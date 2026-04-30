'use strict';

/**
 * Core transformer: Vue 2 Class Component (TypeScript) → Vue 3 Composition API
 *
 * NOTE: Regex-based parsing has known limits with deeply nested generics and
 * template literals. For production-grade use, consider @babel/parser + recast.
 *
 * Safety guardrails in this version:
 * - Comments stripped before parsing (prevents rewriting commented-out code)
 * - Multi-line decorators normalized before extraction
 * - Namespace shadowing: function params are not rewritten as this.x → x.value
 * - @PropSync → computed get/set + prop + emit
 * - Async component detection → defineAsyncComponent()
 * - Reactive provide wrapping → computed() for data refs
 * - vuex-class (@State/@Getter/@Mutation/@Action) → store mappings
 * - Array ref detection (v-for + ref) warnings
 * - Mixin composable name suggestions in output
 * - @Model prop name derived from update:arg event
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

function indent(code, spaces = 2) {
  const pad = ' '.repeat(spaces);
  return code
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : pad + l))
    .join('\n');
}

function dedent(code) {
  const lines = code.split('\n');
  const minIndent = lines
    .filter((l) => l.trim().length > 0)
    .reduce((min, l) => Math.min(min, l.match(/^(\s*)/)[1].length), Infinity);
  if (!isFinite(minIndent) || minIndent === 0) return code;
  return lines.map((l) => l.slice(minIndent)).join('\n');
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toKebabCase(str) {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Extract simple parameter names from a TypeScript param string.
 * Used to detect namespace shadowing (a param named 'count' means
 * this.count inside that method should NOT be rewritten to count.value).
 */
function parseParamNames(params) {
  if (!params.trim()) return new Set();
  const names = new Set();
  const re = /(?:^|,)\s*\.{0,3}(\w+)/g;
  let m;
  while ((m = re.exec(params)) !== null) {
    if (m[1] !== 'this') names.add(m[1]);
  }
  return names;
}

// ─── Source Preprocessing ─────────────────────────────────────────────────────

/**
 * Remove // and block comments while preserving line count.
 * Run on classBody before extraction so decorators inside comments
 * are not mistakenly parsed, and this.x in comments isn't rewritten.
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) =>
      '\n'.repeat((m.match(/\n/g) || []).length),
    )
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Collapse multi-line decorator calls onto one line so that
 *   @Prop({ type: Object,
 *     default: () => ({}) })
 * is treated as a single line by all extractor regexes.
 */
function normalizeDecorators(code) {
  const lines = code.split('\n');
  const result = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/@\w+\s*\(/.test(line.trim())) {
      let combined = line;
      let depth = 0;
      for (const ch of line) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      while (depth > 0 && i + 1 < lines.length) {
        i++;
        const next = lines[i].trim();
        combined += ' ' + next;
        for (const ch of next) {
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
        }
      }
      result.push(combined);
    } else {
      result.push(line);
    }
    i++;
  }
  return result.join('\n');
}

/**
 * Apply a rewrite function only to non-comment sections of a body string.
 * Prevents this.x → x.value transforms inside // and block comments.
 */
function rewriteSkippingComments(body, rewriteFn) {
  const parts = [];
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g;
  let last = 0,
    m;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last)
      parts.push({ comment: false, text: body.slice(last, m.index) });
    parts.push({ comment: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < body.length)
    parts.push({ comment: false, text: body.slice(last) });
  return parts.map((p) => (p.comment ? p.text : rewriteFn(p.text))).join('');
}

// ─── Block Extractors ─────────────────────────────────────────────────────────

function extractScriptBlock(source) {
  const match = source.match(/<script(\s[^>]*)?>[\s\S]*?<\/script>/);
  if (!match) return { scriptContent: '', lang: 'ts', fullMatch: '' };
  const langMatch = match[0].match(/lang=["']([^"']+)["']/);
  const lang = langMatch ? langMatch[1] : 'ts';
  const content = match[0]
    .replace(/<script[^>]*>/, '')
    .replace(/<\/script>/, '');
  return { scriptContent: content.trim(), lang, fullMatch: match[0] };
}

function extractTemplateBlock(source) {
  const m = source.match(/<template[\s\S]*?<\/template>/);
  return m ? m[0] : '';
}

function extractStyleBlock(source) {
  const matches = source.match(/<style[\s\S]*?<\/style>/g);
  return matches ? matches.join('\n\n') : '';
}

// ─── Import Parser ────────────────────────────────────────────────────────────

function parseImports(script) {
  const importLines = [];
  const restLines = [];
  const lines = script.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('import ')) {
      let full = line;
      while (!full.includes(' from ') && i + 1 < lines.length) {
        i++;
        full += ' ' + lines[i].trim();
      }
      importLines.push(full.trim());
    } else {
      restLines.push(line);
    }
    i++;
  }
  return { importLines, restScript: restLines.join('\n') };
}

// ─── Class Body Parser ────────────────────────────────────────────────────────

/**
 * Extract the @Component({...}) options object using brace-depth counting.
 * The regex approach ({[\s\S]*?}) stops at the first } and misses nested objects
 * (e.g. components: { Foo: ... }, filters: { bar() {} }).
 */
function extractBalancedComponentOptions(script) {
  const decorIdx = script.indexOf('@Component(');
  if (decorIdx === -1) return null;
  const openParen = script.indexOf('(', decorIdx);
  const openBrace = script.indexOf('{', openParen);
  const closeParen = script.indexOf(')', openParen);
  // Guard: if there's no { before ), the decorator has no object arg
  if (openBrace === -1 || openBrace > closeParen) return null;

  let depth = 0,
    i = openBrace;
  while (i < script.length) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') {
      depth--;
      if (depth === 0) return script.slice(openBrace, i + 1);
    }
    i++;
  }
  return null;
}

function parseClassBody(script) {
  // Support both `extends Vue` and `extends Mixins(A, B)` (vue-class-component helper)
  const classMatch = script.match(
    /@Component[\s\S]*?export\s+default\s+class\s+(\w+)\s+extends\s+(?:Vue|Mixins\([^)]*\))\s*{/,
  );
  const className = classMatch ? classMatch[1] : 'MyComponent';
  const componentOptions = extractBalancedComponentOptions(script);

  // Find where the class body opens — handle both extends Vue and extends Mixins(...)
  let classStart = script.indexOf('extends Vue');
  if (classStart === -1) classStart = script.indexOf('extends Mixins');
  if (classStart === -1) return { className, componentOptions, classBody: '' };
  const braceStart = script.indexOf('{', classStart);
  if (braceStart === -1) return { className, componentOptions, classBody: '' };

  let depth = 1,
    idx = braceStart + 1;
  while (idx < script.length && depth > 0) {
    if (script[idx] === '{') depth++;
    else if (script[idx] === '}') depth--;
    idx++;
  }
  return {
    className,
    componentOptions,
    classBody: script.slice(braceStart + 1, idx - 1),
  };
}

// ─── Member Extractors ────────────────────────────────────────────────────────

function extractProps(classBody) {
  const props = [];
  const re = /@Prop\(([^)]*)\)\s+(?:readonly\s+)?(\w+)([?!])?\s*:\s*([^;\n]+)/g;
  let m;
  while ((m = re.exec(classBody)) !== null) {
    const options = m[1].trim();
    const name = m[2];
    const required = m[3] === '!';
    const type = m[4].trim().replace(/;$/, '');
    const hasDefault = options.includes('default');
    props.push({ name, type, options, required: required && !hasDefault });
  }
  return props;
}

function extractModel(classBody) {
  const models = [];
  const re =
    /@Model\(['"]([^'"]+)['"]\s*(?:,\s*([^)]*))?\)\s+(?:readonly\s+)?(\w+)([?!])?\s*:\s*([^;\n]+)/g;
  let m;
  while ((m = re.exec(classBody)) !== null) {
    const event = m[1];
    // Derive Vue 3 prop name: 'update:foo' → prop 'foo', else use class property name
    const updateMatch = event.match(/^update:(.+)$/);
    const vue3PropName = updateMatch ? updateMatch[1] : m[3];
    models.push({
      event,
      options: m[2] ? m[2].trim() : '',
      name: m[3],
      vue3PropName,
      type: m[5].trim().replace(/;$/, ''),
    });
  }
  return models;
}

function extractPropSync(classBody) {
  const synced = [];
  const re =
    /@PropSync\(['"]([^'"]+)['"]\s*(?:,\s*([^)]*))?\)\s+(?:readonly\s+)?(\w+)([?!])?\s*:\s*([^;\n]+)/g;
  let m;
  while ((m = re.exec(classBody)) !== null) {
    synced.push({
      propName: m[1], // the string arg — the actual prop accepted by the component
      options: m[2] ? m[2].trim() : '',
      localName: m[3], // class property name → becomes a computed in Vue 3
      type: m[5].trim().replace(/;$/, ''),
    });
  }
  return synced;
}

function extractEmitDecorators(classBody) {
  const emitMap = {};
  const lines = classBody.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const emitMatch = line.match(/^@Emit\((?:['"]([^'"]+)['"])?\)/);
    if (emitMatch) {
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (!nextLine || nextLine.startsWith('@')) continue;
        const methodMatch = nextLine.match(
          /^(?:(?:async|private|public|protected)\s+)*(\w+)\s*\(/,
        );
        if (methodMatch) {
          const eventName = emitMatch[1] || toKebabCase(methodMatch[1]);
          emitMap[methodMatch[1]] = eventName;
        }
        break;
      }
    }
  }
  return emitMap;
}

function extractRefDecorators(classBody) {
  const refs = [];
  const re =
    /@Ref\((?:['"]([^'"]+)['"])?\)\s+(?:readonly\s+)?(\w+)([?!])?\s*:\s*([^;\n]+)/g;
  let m;
  while ((m = re.exec(classBody)) !== null) {
    refs.push({
      refAlias: m[1] || m[2],
      propName: m[2],
      type: m[4].trim().replace(/;$/, ''),
    });
  }
  return refs;
}

function extractProvide(classBody) {
  const provides = [];
  const re =
    /@Provide\(['"]([^'"]+)['"]\)\s+(?:readonly\s+)?(\w+)([?!])?\s*(?::\s*([^=;\n]+))?\s*=\s*([^;\n]+)/g;
  let m;
  while ((m = re.exec(classBody)) !== null) {
    provides.push({
      key: m[1],
      propName: m[2],
      value: m[5].trim().replace(/;$/, ''),
    });
  }
  return provides;
}

function extractInject(classBody) {
  const injects = [];
  const re =
    /@Inject\(['"]([^'"]+)['"]\)\s+(?:readonly\s+)?(\w+)([?!])?\s*:\s*([^;\n]+)/g;
  let m;
  while ((m = re.exec(classBody)) !== null) {
    injects.push({
      key: m[1],
      propName: m[2],
      type: m[4].trim().replace(/;$/, ''),
    });
  }
  return injects;
}

/**
 * vuex-class: @State/@Getter → computed; @Mutation/@Action → functions.
 * m[1]/m[2] = explicit store key (single/double quoted), m[3] = class property name.
 */
function extractVuexDecorators(classBody) {
  const vuexItems = [];
  for (const decType of ['State', 'Getter', 'Mutation', 'Action']) {
    const re = new RegExp(
      `@${decType}\\s*(?:\\(\\s*(?:'([^']+)'|"([^"]+)")?\\s*\\))?\\s+(?:readonly\\s+)?(\\w+)([?!])?[^\\n]*`,
      'g',
    );
    let m;
    while ((m = re.exec(classBody)) !== null) {
      vuexItems.push({
        decType,
        storeName: m[1] || m[2] || m[3],
        localName: m[3],
      });
    }
  }
  return vuexItems;
}

/**
 * Detect async components in @Component({ components: { Foo: () => import(...) } }).
 */
function extractAsyncComponents(componentOptions) {
  if (!componentOptions) return [];
  const asyncComps = [];
  const re = /(\w+)\s*:\s*(\(\s*\)\s*=>\s*import\s*\([^)]+\))/g;
  let m;
  while ((m = re.exec(componentOptions)) !== null) {
    asyncComps.push({ name: m[1], loader: m[2] });
  }
  return asyncComps;
}

function extractData(
  classBody,
  propNames,
  modelNames,
  refDecoratorNames,
  propSyncNames,
  vuexNames,
) {
  const items = [];
  const excluded = new Set([
    ...propNames,
    ...modelNames,
    ...refDecoratorNames,
    ...propSyncNames,
    ...vuexNames,
  ]);

  // Join multi-line property declarations (e.g. Array<{...}> = [\n  ...\n]) onto one line
  // so the extractor sees the full type and value in a single string.
  const joined = classBody.replace(/([^;{}\n])\n\s+/g, (_, ch) => ch + ' ');
  const lines = joined.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('@') || line.startsWith('//') || line.startsWith('*'))
      continue;

    // Match the declaration prefix: [modifiers] name[?!]:
    const prefixMatch = line.match(
      /^(?:(?:private|protected|public|readonly)\s+)*(\w+)([?!])?\s*:\s*/,
    );
    if (!prefixMatch || line.includes('(')) continue;

    const name = prefixMatch[1];
    if (excluded.has(name)) continue;

    const prevLine = lines[i - 1] ? lines[i - 1].trim() : '';
    if (
      /^@(Prop|Model|PropSync|Ref|Provide|Inject|State|Getter|Mutation|Action)/.test(
        prevLine,
      )
    )
      continue;

    // Everything after "name[?!]:" — find the first top-level '=' to split type from value.
    // Depth-counting skips '=' inside generics (Map<string, T = U>), brackets, etc.
    const afterColon = line.slice(prefixMatch[0].length);
    let depth = 0, eqIdx = -1;
    for (let j = 0; j < afterColon.length; j++) {
      const ch = afterColon[j];
      if (ch === '<' || ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '>' || ch === '}' || ch === ']' || ch === ')') depth--;
      else if (ch === '=' && depth === 0 && afterColon[j + 1] !== '>') {
        eqIdx = j;
        break;
      }
    }
    if (eqIdx === -1) continue;

    const type = afterColon.slice(0, eqIdx).trim();
    const value = afterColon.slice(eqIdx + 1).trim().replace(/;$/, '');
    if (!type || !value) continue;

    const isObject =
      type.startsWith('{') ||
      (!['string', 'number', 'boolean', 'any'].includes(type) &&
        !type.includes('|') &&
        (value.startsWith('{') || value.startsWith('[')));
    items.push({ name, type, value, isObject });
  }
  return items;
}

function extractTemplateRefNames(classBody) {
  const refs = new Set();
  const re = /this\.\$refs\.(\w+)/g;
  let m;
  while ((m = re.exec(classBody)) !== null) refs.add(m[1]);
  return refs;
}

function extractComputed(classBody) {
  const getters = {},
    setters = {};
  const re = /(get|set)\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*{/g;
  let m;
  while ((m = re.exec(classBody)) !== null) {
    const kind = m[1],
      name = m[2],
      param = m[3].trim(),
      retType = m[4] ? m[4].trim() : '';
    const braceStart = m.index + m[0].length - 1;
    let depth = 1,
      idx = braceStart + 1;
    while (idx < classBody.length && depth > 0) {
      if (classBody[idx] === '{') depth++;
      else if (classBody[idx] === '}') depth--;
      idx++;
    }
    const body = classBody.slice(braceStart + 1, idx - 1);
    if (kind === 'get') getters[name] = { returnType: retType, body };
    else setters[name] = { param, body };
  }
  return Object.keys(getters).map((name) => ({
    name,
    getter: getters[name],
    setter: setters[name] || null,
  }));
}

function extractMethods(classBody) {
  const methods = [];
  const LIFECYCLE = new Set([
    'beforeCreate',
    'created',
    'beforeMount',
    'mounted',
    'beforeUpdate',
    'updated',
    'beforeDestroy',
    'destroyed',
    'beforeUnmount',
    'unmounted',
    'activated',
    'deactivated',
    'errorCaptured',
    'renderTracked',
    'renderTriggered',
    'serverPrefetch',
  ]);
  const SKIP = new Set([
    'get',
    'set',
    'if',
    'for',
    'while',
    'switch',
    'return',
    'const',
    'let',
    'var',
    'new',
    'import',
    'export',
    'class',
    'catch',
    'finally',
    'function',
    'typeof',
    'instanceof',
  ]);

  const watchDecoratorMap = {};
  const lines = classBody.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const wm = line.match(/^@Watch\(['"]([^'"]+)['"]\s*(?:,\s*({[^}]+}))?\)/);
    if (wm) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next || next.startsWith('@')) continue;
        const nm = next.match(
          /^(?:(?:async|private|public|protected)\s+)*(\w+)\s*\(/,
        );
        if (nm)
          watchDecoratorMap[nm[1]] = { target: wm[1], opts: wm[2] || null };
        break;
      }
    }
  }

  const re =
    /(?:^|\n)[ \t]*(?:(async)\s+)?(?:(?:private|public|protected)\s+)?(?:(async)\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*(?!{)([^\n{]+))?\s*{/g;
  let m;
  while ((m = re.exec(classBody)) !== null) {
    const isAsync = !!(m[1] || m[2]);
    const name = m[3];
    const params = m[4].trim();
    const returnType = m[5] ? m[5].trim() : '';
    if (SKIP.has(name)) continue;

    const braceStart = m.index + m[0].length - 1;
    let depth = 1,
      idx = braceStart + 1;
    while (idx < classBody.length && depth > 0) {
      if (classBody[idx] === '{') depth++;
      else if (classBody[idx] === '}') depth--;
      idx++;
    }
    const body = classBody.slice(braceStart + 1, idx - 1);
    const hasAwait = body.includes('await ') || isAsync;
    const watchInfo = watchDecoratorMap[name];

    if (watchInfo) {
      methods.push({
        name,
        params,
        returnType,
        body,
        isWatch: true,
        watchTarget: watchInfo.target,
        watchOpts: watchInfo.opts,
        isAsync: hasAwait,
      });
    } else if (LIFECYCLE.has(name)) {
      methods.push({
        name,
        params,
        returnType,
        body,
        isLifecycle: true,
        isAsync: hasAwait,
      });
    } else {
      methods.push({
        name,
        params,
        returnType,
        body,
        isMethod: true,
        isAsync: hasAwait,
      });
    }
  }
  return methods;
}

function extractEmits(classBody) {
  const emits = [];
  const re = /this\.\$emit\(['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(classBody)) !== null) {
    if (!emits.includes(m[1])) emits.push(m[1]);
  }
  return emits;
}

function extractFilters(componentOptions) {
  if (!componentOptions) return [];
  const m = componentOptions.match(/filters\s*:\s*{([^}]+)}/);
  if (!m) return [];
  // Only match top-level function definitions (word followed by params and {)
  // to avoid picking up inner method calls like value.toFixed(2)
  return (m[1].match(/^\s*(\w+)\s*\([^)]*\)\s*\{/gm) || []).map((f) =>
    f.trim().match(/^(\w+)/)[1],
  );
}

function extractMixins(componentOptions, classBody) {
  const mixins = [];
  if (componentOptions) {
    const m = componentOptions.match(/mixins\s*:\s*\[([^\]]+)\]/);
    if (m)
      mixins.push(
        ...m[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
  }
  // Also extract from class Mixins(A, B) helper
  const mm = classBody.match(/Mixins\(([^)]+)\)/);
  if (mm) {
    mm[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((n) => {
        if (!mixins.includes(n)) mixins.push(n);
      });
  } else if (classBody.includes('Mixins(') || classBody.includes('mixins(')) {
    mixins.push('(detected via Mixins() helper)');
  }
  return [...new Set(mixins)];
}

/**
 * Scan the template for ref attributes on v-for elements.
 * In Vue 3 these produce arrays; the migrated ref needs a different type annotation.
 */
function detectArrayRefs(template) {
  const names = new Set();
  const re1 = /v-for\s*=\s*["'][^"']*["'][^>]*\bref\s*=\s*["'](\w+)["']/g;
  const re2 = /\bref\s*=\s*["'](\w+)["'][^>]*v-for\s*=/g;
  let m;
  while ((m = re1.exec(template)) !== null) names.add(m[1]);
  while ((m = re2.exec(template)) !== null) names.add(m[1]);
  return names;
}

// ─── Breaking Change Detectors ────────────────────────────────────────────────

function detectBreakingChanges(classBody) {
  const issues = [];
  if (/this\.\$set\b/.test(classBody))
    issues.push(
      '$set is deleted in Vue 3 — use direct assignment (Proxy reactivity handles it).',
    );
  if (/this\.\$delete\b/.test(classBody))
    issues.push(
      '$delete is deleted in Vue 3 — use delete obj.key or array splice directly.',
    );
  if (/this\.\$listeners\b/.test(classBody))
    issues.push('$listeners is deleted — merged into $attrs in Vue 3.');
  if (/this\.\$on\b|this\.\$off\b|this\.\$once\b/.test(classBody))
    issues.push(
      '$on/$off/$once are deleted — use an external event bus like mitt.',
    );
  if (/v-model/.test(classBody) || /modelValue/.test(classBody))
    issues.push(
      'v-model: prop is now "modelValue", event is "update:modelValue".',
    );
  return issues;
}

// ─── this.X → X.value rewriter ───────────────────────────────────────────────

function makeRewriter(
  propNames,
  dataNames,
  computedNames,
  templateRefNames,
  methodNames,
  refDecoratorNames,
) {
  return function rewrite(body, localNames = new Set()) {
    const transform = (code) => {
      let out = code
        .replace(/this\.\$router\b/g, 'router')
        .replace(/this\.\$route\b/g, 'route')
        .replace(/this\.\$store\b/g, 'store')
        .replace(/this\.\$emit\s*\(/g, 'emit(')
        .replace(/this\.\$nextTick/g, 'nextTick')
        .replace(/this\.\$el\b/g, 'templateEl.value')
        .replace(/this\.\$attrs\b/g, 'attrs')
        .replace(/this\.\$slots\b/g, 'slots')
        .replace(/this\.\$refs\.(\w+)/g, (_, n) => `${n}.value`)
        .replace(
          /this\.\$set\s*\(/g,
          '/* $set deleted — use direct assignment */ (',
        )
        .replace(
          /this\.\$delete\s*\(/g,
          '/* $delete deleted — use delete/splice */ (',
        )
        .replace(/this\.\$on\s*\(/g, '/* $on deleted — use mitt */ (')
        .replace(/this\.\$off\s*\(/g, '/* $off deleted — use mitt */ (')
        .replace(/this\.\$once\s*\(/g, '/* $once deleted — use mitt */ (')
        .replace(
          /this\.\$listeners\b/g,
          '/* $listeners deleted → use $attrs */ attrs',
        );

      out = out.replace(/this\.\$(\w+)/g, '/* TODO: this.$$$1 */ $1');

      out = out.replace(/this\.(\w+)/g, (match, name) => {
        if (localNames.has(name)) return match; // shadowed by function parameter
        if (propNames.has(name)) return `props.${name}`;
        if (dataNames.has(name)) return `${name}.value`;
        if (computedNames.has(name)) return `${name}.value`;
        if (templateRefNames.has(name)) return `${name}.value`;
        if (refDecoratorNames && refDecoratorNames.has(name))
          return `${name}.value`;
        if (methodNames && methodNames.has(name)) return name;
        return `/* TODO: this.${name} */ ${name}`;
      });

      return out;
    };

    return rewriteSkippingComments(body, transform);
  };
}

// ─── Code Generators ─────────────────────────────────────────────────────────

const LIFECYCLE_MAP = {
  beforeCreate: null,
  created: null,
  beforeMount: 'onBeforeMount',
  mounted: 'onMounted',
  beforeUpdate: 'onBeforeUpdate',
  updated: 'onUpdated',
  beforeDestroy: 'onBeforeUnmount',
  destroyed: 'onUnmounted',
  beforeUnmount: 'onBeforeUnmount',
  unmounted: 'onUnmounted',
  activated: 'onActivated',
  deactivated: 'onDeactivated',
  errorCaptured: 'onErrorCaptured',
  renderTracked: 'onRenderTracked',
  renderTriggered: 'onRenderTriggered',
  serverPrefetch: 'onServerPrefetch',
};

function generateProps(props, models, propSyncs) {
  const lines = [
    ...props.map((p) => {
      const opt =
        !p.required || p.type.includes('undefined') || p.type.includes('|');
      return `  ${p.name}${opt ? '?' : ''}: ${p.type}`;
    }),
    // @Model: use the Vue 3 prop name derived from the event (update:foo → prop foo)
    ...models.map((mo) => `  ${mo.vue3PropName}?: ${mo.type}`),
    // @PropSync: the original prop is accepted by the component
    ...propSyncs.map((ps) => `  ${ps.propName}?: ${ps.type}`),
  ];
  if (!lines.length) return '';
  return `const props = defineProps<{\n${lines.join(';\n')}\n}>();`;
}

function generateEmits(emits, models, emitDecoratorMap, propSyncs) {
  const all = new Set([
    ...emits.map((e) => `'${e}'`),
    ...models.map((mo) => `'${mo.event}'`),
    ...Object.values(emitDecoratorMap).map((e) => `'${e}'`),
    ...propSyncs.map((ps) => `'update:${ps.propName}'`),
  ]);
  if (!all.size) return '';
  return `const emit = defineEmits([${[...all].join(', ')}]);`;
}

function generateRefDecorators(refDecorators) {
  if (!refDecorators.length) return '';
  return refDecorators
    .map(
      (r) =>
        `const ${r.propName} = ref<${r.type} | null>(null); // @Ref('${r.refAlias}')`,
    )
    .join('\n');
}

function generateTemplateRefs(refNames) {
  if (!refNames.length) return '';
  return refNames
    .map(
      (n) =>
        `const ${n} = ref<InstanceType<typeof ${capitalize(n)}> | null>(null); // TODO: fix type`,
    )
    .join('\n');
}

function generateRefs(dataItems) {
  return dataItems
    .map((d) => {
      if (d.isObject) {
        return `// Consider reactive() for deep object: const ${d.name} = reactive<${d.type}>(${d.value});\nconst ${d.name} = ref<${d.type}>(${d.value});`;
      }
      return `const ${d.name} = ref<${d.type}>(${d.value});`;
    })
    .join('\n');
}

/**
 * @PropSync → computed get/set.
 * get returns props.propName; set emits update:propName.
 */
function generatePropSyncComputed(propSyncs) {
  if (!propSyncs.length) return '';
  return propSyncs
    .map(
      (ps) =>
        `const ${ps.localName} = computed<${ps.type}>({\n` +
        `  get() { return props.${ps.propName}; },\n` +
        `  set(val: ${ps.type}) { emit('update:${ps.propName}', val); }\n` +
        `});`,
    )
    .join('\n\n');
}

/**
 * vuex-class decorators → useStore() mappings.
 * @State/@Getter become computed refs; @Mutation/@Action become dispatch wrappers.
 */
function generateVuexMappings(vuexItems) {
  if (!vuexItems.length) return '';
  return vuexItems
    .map((item) => {
      switch (item.decType) {
        case 'State':
          return `const ${item.localName} = computed(() => store.state.${item.storeName}); // @State`;
        case 'Getter':
          return `const ${item.localName} = computed(() => store.getters['${item.storeName}']); // @Getter`;
        case 'Mutation':
          return `const ${item.localName} = (...args: unknown[]) => store.commit('${item.storeName}', ...args); // @Mutation`;
        case 'Action':
          return `const ${item.localName} = (...args: unknown[]) => store.dispatch('${item.storeName}', ...args); // @Action`;
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

function generateAsyncComponents(asyncComps) {
  if (!asyncComps.length) return '';
  return asyncComps
    .map((c) => `const ${c.name} = defineAsyncComponent(${c.loader});`)
    .join('\n');
}

/**
 * @Provide → provide() calls.
 * If the provided value string matches a known data ref name, wrap in computed()
 * to maintain reactivity (Vue 2 class properties were reactive by default).
 */
function generateProvide(provides, dataNames) {
  if (!provides.length) return '';
  return provides
    .map((p) => {
      const raw = p.value.trim();
      const val = dataNames.has(raw) ? `computed(() => ${raw}.value)` : raw;
      return `provide('${p.key}', ${val});`;
    })
    .join('\n');
}

function generateInject(injects) {
  if (!injects.length) return '';
  return injects
    .map((i) => `const ${i.propName} = inject<${i.type}>('${i.key}');`)
    .join('\n');
}

function generateComputed(computedList, rewrite) {
  return computedList
    .map((c) => {
      const getBody = rewrite(c.getter.body, new Set());
      const retType = c.getter.returnType ? `: ${c.getter.returnType}` : '';
      if (c.setter) {
        const setLocalNames = parseParamNames(c.setter.param);
        const setBody = rewrite(c.setter.body, setLocalNames);
        return (
          `const ${c.name} = computed({\n` +
          `  get()${retType} {\n${indent(dedent(getBody).trim(), 4)}\n  },\n` +
          `  set(${c.setter.param}) {\n${indent(dedent(setBody).trim(), 4)}\n  }\n});`
        );
      }
      return `const ${c.name} = computed(()${retType} => {\n${indent(dedent(getBody).trim(), 2)}\n});`;
    })
    .join('\n\n');
}

function generateMethods(methods, rewrite, emitDecoratorMap) {
  return methods
    .filter((m) => m.isMethod)
    .map((m) => {
      const localNames = parseParamNames(m.params);
      const body = rewrite(m.body, localNames);
      const asyncKw = m.isAsync ? 'async ' : '';
      const retType = m.returnType ? `: ${m.returnType}` : '';

      const eventName = emitDecoratorMap[m.name];
      let finalBody = dedent(body).trim();
      if (eventName) {
        const alreadyEmits = finalBody.includes(`emit('${eventName}'`);
        if (!alreadyEmits) {
          const returnMatch = finalBody.match(/return (.+?);[ \t]*$/m);
          if (returnMatch) {
            const retVal = returnMatch[1];
            finalBody = finalBody.replace(
              /return (.+?);[ \t]*$/m,
              `emit('${eventName}', ${retVal});\nreturn ${retVal};`,
            );
          } else {
            finalBody += `\nemit('${eventName}');`;
          }
        }
      }
      return `const ${m.name} = ${asyncKw}(${m.params})${retType} => {\n${indent(finalBody, 2)}\n};`;
    })
    .join('\n\n');
}

function generateLifecycle(methods, rewrite) {
  return methods
    .filter((m) => m.isLifecycle)
    .map((m) => {
      const localNames = parseParamNames(m.params);
      const body = rewrite(m.body, localNames);
      const hook = LIFECYCLE_MAP[m.name];
      const cleanBody = dedent(body).trim();
      if (!hook)
        return `// ${m.name} → runs inline in <script setup>\n${cleanBody}`;
      const asyncKw = m.isAsync ? 'async ' : '';
      return `${hook}(${asyncKw}() => {\n${indent(cleanBody, 2)}\n});`;
    })
    .join('\n\n');
}

function generateWatchers(methods, rewrite, dataNames, propNames) {
  return methods
    .filter((m) => m.isWatch)
    .map((m) => {
      const localNames = parseParamNames(m.params);
      const body = rewrite(m.body, localNames);
      const opts = m.watchOpts ? `, ${m.watchOpts}` : '';
      const asyncKw = m.isAsync ? 'async ' : '';
      let source;
      if (propNames.has(m.watchTarget)) source = `() => props.${m.watchTarget}`;
      else if (dataNames.has(m.watchTarget)) source = m.watchTarget;
      else source = `() => ${m.watchTarget}`;
      return `watch(${source}, ${asyncKw}(${m.params}) => {\n${indent(dedent(body).trim(), 2)}\n}${opts});`;
    })
    .join('\n\n');
}

// ─── Import Builder ───────────────────────────────────────────────────────────

function buildVue3Imports(
  {
    dataItems,
    computedList,
    watchMethods,
    lifecycleMethods,
    usesNextTick,
    usesRouter,
    usesRoute,
    usesStore,
    usesI18n,
    usesAttrs,
    usesSlots,
    usesTemplateEl,
    templateRefs,
    refDecorators,
    provides,
    injects,
    propSyncs,
    vuexItems,
    asyncComps,
    dataNames,
  },
  oldImports,
) {
  const vueSet = new Set();

  if (
    dataItems.length ||
    templateRefs.length ||
    refDecorators.length ||
    usesTemplateEl
  )
    vueSet.add('ref');
  if (computedList.length) vueSet.add('computed');
  if (propSyncs.length) vueSet.add('computed');
  if (vuexItems.some((v) => v.decType === 'State' || v.decType === 'Getter'))
    vueSet.add('computed');
  if (provides.some((p) => dataNames.has(p.value.trim())))
    vueSet.add('computed');
  if (watchMethods.length) vueSet.add('watch');
  if (usesNextTick) vueSet.add('nextTick');
  if (provides.length) vueSet.add('provide');
  if (injects.length) vueSet.add('inject');
  if (usesAttrs) vueSet.add('useAttrs');
  if (usesSlots) vueSet.add('useSlots');
  if (dataItems.some((d) => d.isObject)) vueSet.add('reactive');
  if (asyncComps.length) vueSet.add('defineAsyncComponent');

  for (const m of lifecycleMethods) {
    const hook = LIFECYCLE_MAP[m.name];
    if (hook) vueSet.add(hook);
  }

  const routerSet = new Set();
  if (usesRouter) routerSet.add('useRouter');
  if (usesRoute) routerSet.add('useRoute');

  const cleaned = oldImports.filter(
    (l) =>
      !l.includes('vue-class-component') &&
      !l.includes('vue-property-decorator') &&
      !l.includes('vuex-class') &&
      !l.includes("from 'vue'") &&
      !l.includes('from "vue"') &&
      !l.includes("from 'vue-router'") &&
      !l.includes('from "vue-router"') &&
      !l.includes("from 'vue-i18n'") &&
      !l.includes('from "vue-i18n"'),
  );

  const lines = [];
  if (vueSet.size)
    lines.push(`import { ${[...vueSet].sort().join(', ')} } from 'vue';`);
  if (routerSet.size)
    lines.push(
      `import { ${[...routerSet].sort().join(', ')} } from 'vue-router';`,
    );
  if (usesStore || vuexItems.length)
    lines.push(
      `import { useStore } from 'vuex'; // TODO: consider migrating to Pinia`,
    );
  if (usesI18n) lines.push(`import { useI18n } from 'vue-i18n';`);
  lines.push(...cleaned);
  return lines.filter(Boolean).join('\n');
}

// ─── Main Transform ───────────────────────────────────────────────────────────

function transformComponent(source, filename = 'Component.vue') {
  const warnings = [];

  // Normalize Windows CRLF to LF so all regex and join logic works correctly
  source = source.replace(/\r\n/g, '\n');

  const template = extractTemplateBlock(source);
  const style = extractStyleBlock(source);
  const { scriptContent, lang } = extractScriptBlock(source);

  if (!scriptContent) {
    return {
      output: source,
      warnings: ['No <script> block found — file unchanged.'],
    };
  }

  const { importLines, restScript } = parseImports(scriptContent);
  const {
    className,
    componentOptions,
    classBody: rawClassBody,
  } = parseClassBody(restScript);

  if (!rawClassBody) {
    warnings.push(
      'Could not detect Vue 2 class syntax — may already be Vue 3 or Options API.',
    );
    return { output: source, warnings };
  }

  // Preprocess: strip comments, then collapse multi-line decorators.
  // This prevents decorator regexes from matching inside comments and
  // handles @Prop({ type: Object,\n  default: () => ({}) }) spanning multiple lines.
  const classBody = normalizeDecorators(stripComments(rawClassBody));

  // ── Extract ───────────────────────────────────────────────────────────────
  const props = extractProps(classBody);
  const models = extractModel(classBody);
  const propSyncs = extractPropSync(classBody);
  const emitDecoratorMap = extractEmitDecorators(classBody);
  const refDecorators = extractRefDecorators(classBody);
  const provides = extractProvide(classBody);
  const injects = extractInject(classBody);
  const vuexItems = extractVuexDecorators(classBody);
  const asyncComps = extractAsyncComponents(componentOptions);

  const propNames = new Set(props.map((p) => p.name));
  const modelNames = new Set(models.map((mo) => mo.name));
  const refDecoratorNames = new Set(refDecorators.map((r) => r.propName));
  const propSyncNames = new Set(propSyncs.map((ps) => ps.localName));
  const vuexNames = new Set(vuexItems.map((v) => v.localName));

  const dataItems = extractData(
    classBody,
    propNames,
    modelNames,
    refDecoratorNames,
    propSyncNames,
    vuexNames,
  );
  const dataNames = new Set(dataItems.map((d) => d.name));
  const computedList = extractComputed(classBody);
  const computedNames = new Set(computedList.map((c) => c.name));
  const templateRefNames = extractTemplateRefNames(classBody);
  const allMethods = extractMethods(classBody);
  const lifecycleMethods = allMethods.filter((m) => m.isLifecycle);
  const watchMethods = allMethods.filter((m) => m.isWatch);
  const normalMethods = allMethods.filter((m) => m.isMethod);
  const emits = extractEmits(classBody);
  const filters = extractFilters(componentOptions);
  const mixins = extractMixins(componentOptions, restScript);
  const breakingChanges = detectBreakingChanges(classBody);
  const arrayRefs = detectArrayRefs(template);

  const methodNames = new Set(allMethods.map((m) => m.name));

  // Build extended name sets so the rewriter resolves all known names correctly.
  // @State/@Getter → ComputedRef: this.X → X.value
  // @Model class props → treated as component props: this.X → props.X
  // @PropSync local names → ComputedRef: this.X → X.value
  // @Action/@Mutation → plain functions: this.X → X
  // @Inject names → plain constants from inject(): this.X → X
  const vuexComputedNames = new Set(
    vuexItems.filter((v) => v.decType === 'State' || v.decType === 'Getter').map((v) => v.localName),
  );
  const vuexFunctionNames = new Set(
    vuexItems.filter((v) => v.decType === 'Action' || v.decType === 'Mutation').map((v) => v.localName),
  );
  const injectNames = new Set(injects.map((i) => i.propName));
  const allPropNames = new Set([...propNames, ...modelNames]);
  const allComputedNames = new Set([...computedNames, ...vuexComputedNames, ...propSyncNames]);
  const allMethodNames = new Set([...methodNames, ...vuexFunctionNames, ...injectNames]);

  const rewrite = makeRewriter(
    allPropNames,
    dataNames,
    allComputedNames,
    templateRefNames,
    allMethodNames,
    refDecoratorNames,
  );

  // ── Feature flags ─────────────────────────────────────────────────────────
  const usesNextTick = classBody.includes('$nextTick');
  const usesRouter = classBody.includes('this.$router');
  const usesRoute = classBody.includes('this.$route');
  const usesStore = classBody.includes('this.$store');
  const usesI18n =
    classBody.includes('this.$t(') || classBody.includes('this.$i18n');
  // $listeners was merged into $attrs in Vue 3; treat it the same as $attrs
  const usesAttrs =
    classBody.includes('this.$attrs') || classBody.includes('this.$listeners');
  const usesSlots = classBody.includes('this.$slots');
  const usesTemplateEl = classBody.includes('this.$el');

  // ── Imports ───────────────────────────────────────────────────────────────
  const imports = buildVue3Imports(
    {
      dataItems,
      computedList,
      watchMethods,
      lifecycleMethods,
      usesNextTick,
      usesRouter,
      usesRoute,
      usesStore,
      usesI18n,
      usesAttrs,
      usesSlots,
      usesTemplateEl,
      templateRefs: [...templateRefNames],
      refDecorators,
      provides,
      injects,
      propSyncs,
      vuexItems,
      asyncComps,
      dataNames,
    },
    importLines,
  );

  // ── Assemble script body ──────────────────────────────────────────────────
  // Ordering guarantee: ref/reactive declarations always appear before inline
  // lifecycle code (created/beforeCreate run as top-level setup statements),
  // so all refs are defined before any setup-time code that references them.
  const parts = [];

  const propsCode = generateProps(props, models, propSyncs);
  if (propsCode) parts.push(propsCode);

  const emitsCode = generateEmits(emits, models, emitDecoratorMap, propSyncs);
  if (emitsCode) parts.push(emitsCode);

  const composableInits = [];
  if (usesRouter) composableInits.push('const router = useRouter();');
  if (usesRoute) composableInits.push('const route = useRoute();');
  if (usesStore || vuexItems.length)
    composableInits.push('const store = useStore();');
  if (usesI18n) composableInits.push('const { t } = useI18n();');
  if (usesAttrs) composableInits.push('const attrs = useAttrs();');
  if (usesSlots) composableInits.push('const slots = useSlots();');
  if (usesTemplateEl)
    composableInits.push('const templateEl = ref<Element | null>(null);');
  if (composableInits.length) parts.push(composableInits.join('\n'));

  const provideCode = generateProvide(provides, dataNames);
  if (provideCode) parts.push(provideCode);
  const injectCode = generateInject(injects);
  if (injectCode) parts.push(injectCode);

  const refDecoratorCode = generateRefDecorators(refDecorators);
  if (refDecoratorCode) parts.push(refDecoratorCode);

  const templateRefCode = generateTemplateRefs([...templateRefNames]);
  if (templateRefCode) parts.push(templateRefCode);

  // Data refs hoisted here — before computed, methods, and inline lifecycle
  const refsCode = generateRefs(dataItems);
  if (refsCode) parts.push(refsCode);

  const asyncCompsCode = generateAsyncComponents(asyncComps);
  if (asyncCompsCode) parts.push(asyncCompsCode);

  const vuexCode = generateVuexMappings(vuexItems);
  if (vuexCode) parts.push(vuexCode);

  const propSyncCode = generatePropSyncComputed(propSyncs);
  if (propSyncCode) parts.push(propSyncCode);

  const computedCode = generateComputed(computedList, rewrite);
  if (computedCode) parts.push(computedCode);

  const methodsCode = generateMethods(normalMethods, rewrite, emitDecoratorMap);
  if (methodsCode) parts.push(methodsCode);

  // beforeCreate/created run inline as setup-level statements
  const lifecycleCode = generateLifecycle(lifecycleMethods, rewrite);
  if (lifecycleCode) parts.push(lifecycleCode);

  const watchersCode = generateWatchers(
    watchMethods,
    rewrite,
    dataNames,
    propNames,
  );
  if (watchersCode) parts.push(watchersCode);

  // Mixin composable hints as comments
  const mixinHints = mixins
    .filter((n) => !n.startsWith('(detected'))
    .map((n) => {
      const base = n.replace(/Mixin$/i, '').replace(/^Mixin/i, '') || n;
      return `// TODO: Convert mixin → import { use${capitalize(base)} } from './use${capitalize(base)}'`;
    });
  if (mixinHints.length) parts.push(mixinHints.join('\n'));

  // defineExpose intentionally omitted — <script setup> bindings are auto-accessible in the template.
  // Add defineExpose manually only when a parent needs ref access to internals.

  let componentsDef = '';
  if (componentOptions) {
    const compMatch = componentOptions.match(/components\s*:\s*\{[^}]*\}/);
    if (compMatch) {
      const oneLine = compMatch[0].replace(/\s+/g, ' ').trim();
      componentsDef = `// [OK] Components auto-registered in Vue 3 SFC\n// Was: ${oneLine}\n`;
    }
  }

  const setupBody = parts.filter(Boolean).join('\n\n');
  const header = `${imports}\n\n${componentsDef}// Migrated from Vue 2 Class Component: ${className}\n`;
  const scriptTag = `<script setup lang="${lang}">\n${header}\n${setupBody}\n</script>`;

  const outputParts = [template, '', scriptTag];
  if (style) outputParts.push('', style);
  const output = outputParts.join('\n').trim() + '\n';

  // ── Warnings ──────────────────────────────────────────────────────────────
  for (const bc of breakingChanges) warnings.push(`[!] Breaking change: ${bc}`);
  if (filters.length)
    warnings.push(
      `Filters (${filters.join(', ')}) removed in Vue 3 — convert to computed props or methods.`,
    );
  if (mixins.length)
    warnings.push(
      `Mixins detected (${mixins.join(', ')}) — see use*() composable hints in the output.`,
    );
  if (models.length)
    warnings.push(
      `@Model migrated to prop+emit. Consider defineModel() on Vue 3.4+.`,
    );
  if (models.some((mo) => mo.name !== mo.vue3PropName))
    warnings.push(
      `@Model class property name differs from Vue 3 prop name — verify v-model binding in parent.`,
    );
  if (propSyncs.length)
    warnings.push(
      `@PropSync migrated to computed get/set — parent must use v-model:${propSyncs.map((ps) => ps.propName).join(', v-model:')} syntax.`,
    );
  if (refDecorators.length)
    warnings.push(
      `@Ref decorators migrated to ref(null) — verify types for: ${refDecorators.map((r) => r.propName).join(', ')}.`,
    );
  if (templateRefNames.size)
    warnings.push(
      `Template $refs (${[...templateRefNames].join(', ')}) — fix types in generated ref declarations.`,
    );
  if (arrayRefs.size)
    warnings.push(
      `Possible array refs on v-for (${[...arrayRefs].join(', ')}) — Vue 3 collects these as Element[]; type the ref as Ref<Element[]>.`,
    );
  if (provides.length || injects.length)
    warnings.push(
      `provide/inject migrated — verify keys match between parent and child.`,
    );
  if (provides.some((p) => dataNames.has(p.value.trim())))
    warnings.push(
      `Reactive data refs in provide() wrapped in computed() — consumers receive a ComputedRef, not a plain value.`,
    );
  if (provides.length)
    warnings.push(
      `@Provide: Vue 2 class properties were reactive by default. Verify all provided values remain reactive in Vue 3.`,
    );
  if (vuexItems.length)
    warnings.push(
      `vuex-class (${[...new Set(vuexItems.map((v) => `@${v.decType}`))].join(', ')}) migrated to store helpers — consider Pinia for new projects.`,
    );
  if (asyncComps.length)
    warnings.push(
      `Async components (${asyncComps.map((c) => c.name).join(', ')}) converted to defineAsyncComponent() — verify import paths.`,
    );
  if (dataItems.some((d) => d.isObject))
    warnings.push(
      `Some data properties may be deeply mutated objects — consider reactive() over ref().`,
    );
  if (output.includes('/* TODO:'))
    warnings.push(
      `Some this.X references unresolved — search "/* TODO:" in the output.`,
    );
  if (watchMethods.length || computedList.length)
    warnings.push('Review watch() and computed() bodies for correctness.');

  return { output, warnings };
}

module.exports = { transformComponent };
