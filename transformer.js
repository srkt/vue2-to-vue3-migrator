‘use strict’;

/**

- Core transformer: Vue 2 Class Component (TypeScript) → Vue 3 Composition API
- 
- Aligned with: Vue_Migration_Guide_Full_v2.txt (Gemini guide)
- 
- Covered:
- - @Prop / @Model / @Emit / @Ref / @Provide / @Inject / @Watch decorators
- - ref() with .value rewriting (props → props.X, data → X.value)
- - computed() get/set
- - All lifecycle hooks mapped correctly
- - $set/$delete/$listeners/$on/$off/$once → warnings (deleted in Vue 3)
- - $attrs absorbs $listeners
- - v-model: modelValue pattern note in warnings
- - Filters → warning (deleted in Vue 3)
- - Mixins → warning + composable hint
- - useRouter / useRoute from vue-router
- - useStore from vuex (with Pinia note)
- - useI18n detected and imported
- - nextTick imported when used
- - provide/inject via @Provide/@Inject
- - @Ref decorator → ref<Type>(null)
- - Objects deeply mutated → reactive() hint
- - defineExpose intentionally omitted (template auto-accessible)
- - No duplicate watchers (pre-scan approach)
- - Method names resolved so this.method() → method()
    */

// — Helpers ——————————————————————

function indent(code, spaces = 2) {
const pad = ’ ‘.repeat(spaces);
return code.split(’\n’).map(l => (l.trim() === ‘’ ? ‘’ : pad + l)).join(’\n’);
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// — Block Extractors ———————————————————

function extractScriptBlock(source) {
const match = source.match(/<script(\s[^>]*)?>[\s\S]*?</script>/);
if (!match) return { scriptContent: ‘’, lang: ‘ts’, fullMatch: ‘’ };
const langMatch = match[0].match(/lang=[”’]([^"']+)[”’]/);
const lang = langMatch ? langMatch[1] : ‘ts’;
const content = match[0].replace(/<script[^>]*>/, ‘’).replace(/</script>/, ‘’);
return { scriptContent: content.trim(), lang, fullMatch: match[0] };
}

function extractTemplateBlock(source) {
const m = source.match(/<template[\s\S]*?</template>/);
return m ? m[0] : ‘’;
}

function extractStyleBlock(source) {
const matches = source.match(/<style[\s\S]*?</style>/g);
return matches ? matches.join(’\n\n’) : ‘’;
}

// — Import Parser ————————————————————

function parseImports(script) {
const importLines = [];
const restLines = [];
const lines = script.split(’\n’);
let i = 0;
while (i < lines.length) {
const line = lines[i];
if (line.trim().startsWith(‘import ‘)) {
let full = line;
while (!full.includes(’ from ‘) && i + 1 < lines.length) {
i++;
full += ’ ’ + lines[i].trim();
}
importLines.push(full.trim());
} else {
restLines.push(line);
}
i++;
}
return { importLines, restScript: restLines.join(’\n’) };
}

// — Class Body Parser ––––––––––––––––––––––––––––

function parseClassBody(script) {
const classMatch = script.match(/@Component[^]*?export\s+default\s+class\s+(\w+)\s+extends\s+Vue\s*{/);
const className = classMatch ? classMatch[1] : ‘MyComponent’;
const componentDecorator = script.match(/@Component(({[\s\S]*?}))/);
const componentOptions = componentDecorator ? componentDecorator[1] : null;

const classStart = script.indexOf(‘extends Vue’);
if (classStart === -1) return { className, componentOptions, classBody: ‘’ };
const braceStart = script.indexOf(’{’, classStart);
if (braceStart === -1) return { className, componentOptions, classBody: ‘’ };

let depth = 1, idx = braceStart + 1;
while (idx < script.length && depth > 0) {
if (script[idx] === ‘{’) depth++;
else if (script[idx] === ‘}’) depth–;
idx++;
}
return { className, componentOptions, classBody: script.slice(braceStart + 1, idx - 1) };
}

// — Member Extractors ––––––––––––––––––––––––––––

function extractProps(classBody) {
const props = [];
const re = /@Prop(([^)]*))\s+(?:readonly\s+)?(\w+)(?|!)?\s*:\s*([^;\n]+)/g;
let m;
while ((m = re.exec(classBody)) !== null) {
const options = m[1].trim();
const name = m[2];
const required = m[3] === ‘!’;
const type = m[4].trim().replace(/;$/, ‘’);
const hasDefault = options.includes(‘default’);
props.push({ name, type, options, required: required && !hasDefault });
}
return props;
}

function extractModel(classBody) {
// @Model(‘update:modelValue’, { type: String }) value!: string
const models = [];
const re = /@Model([’”]([^'"]+)[’”]\s*(?:,\s*([^)]*))?)\s+(?:readonly\s+)?(\w+)(?|!)?\s*:\s*([^;\n]+)/g;
let m;
while ((m = re.exec(classBody)) !== null) {
models.push({
event: m[1],
options: m[2] ? m[2].trim() : ‘’,
name: m[3],
type: m[5].trim().replace(/;$/, ‘’)
});
}
return models;
}

// @Emit decorator: @Emit(‘event-name’) or @Emit() (uses method name)
function extractEmitDecorators(classBody) {
const emitMap = {}; // methodName → eventName
const lines = classBody.split(’\n’);
for (let i = 0; i < lines.length; i++) {
const line = lines[i].trim();
const emitMatch = line.match(/^@Emit(([’”]([^'"]+)[’”])?)/);
if (emitMatch) {
for (let j = i + 1; j < lines.length; j++) {
const nextLine = lines[j].trim();
if (!nextLine || nextLine.startsWith(’@’)) continue;
const methodMatch = nextLine.match(/^(?:(?:async|private|public|protected)\s+)*(\w+)\s*(/);
if (methodMatch) {
// Event name: explicit string or camelCase→kebab-case of method name
const eventName = emitMatch[2] || toKebabCase(methodMatch[1]);
emitMap[methodMatch[1]] = eventName;
}
break;
}
}
}
return emitMap;
}

// @Ref decorator: @Ref(‘refName’) readonly btn!: HTMLButtonElement
function extractRefDecorators(classBody) {
const refs = [];
const re = /@Ref(([’”]([^'"]+)[’”])?)\s+(?:readonly\s+)?(\w+)(?|!)?\s*:\s*([^;\n]+)/g;
let m;
while ((m = re.exec(classBody)) !== null) {
refs.push({
refAlias: m[2] || m[3], // explicit string name or property name
propName: m[3],
type: m[5].trim().replace(/;$/, ‘’)
});
}
return refs;
}

// @Provide decorator
function extractProvide(classBody) {
const provides = [];
const re = /@Provide([’”]([^'"]+)[’”])\s+(?:readonly\s+)?(\w+)(?|!)?\s*(?::\s*([^=;\n]+))?\s*=\s*([^;\n]+)/g;
let m;
while ((m = re.exec(classBody)) !== null) {
provides.push({ key: m[1], propName: m[2], value: m[5].trim().replace(/;$/, ‘’) });
}
return provides;
}

// @Inject decorator
function extractInject(classBody) {
const injects = [];
const re = /@Inject([’”]([^'"]+)[’”])\s+(?:readonly\s+)?(\w+)(?|!)?\s*:\s*([^;\n]+)/g;
let m;
while ((m = re.exec(classBody)) !== null) {
injects.push({ key: m[1], propName: m[2], type: m[4].trim().replace(/;$/, ‘’) });
}
return injects;
}

function extractData(classBody, propNames, modelNames, refDecoratorNames) {
const items = [];
const lines = classBody.split(’\n’);
for (let i = 0; i < lines.length; i++) {
const line = lines[i].trim();
if (line.startsWith(’@’) || line.startsWith(’//’) || line.startsWith(’*’)) continue;
const m = line.match(/^(?:(?:private|protected|public|readonly)\s+)*(\w+)(?|!)?\s*:\s*([^=\n{(]+)\s*=\s*(.+?);?\s*$/);
if (!m || line.includes(’(’)) continue;
const name = m[1];
if (propNames.has(name) || modelNames.has(name) || refDecoratorNames.has(name)) continue;
const prevLine = lines[i - 1] ? lines[i - 1].trim() : ‘’;
if (prevLine.startsWith(’@Prop’) || prevLine.startsWith(’@Model’) ||
prevLine.startsWith(’@Ref’) || prevLine.startsWith(’@Provide’) ||
prevLine.startsWith(’@Inject’)) continue;

```
// Heuristic: if type is a plain object type or Array, suggest reactive()
const type = m[3].trim();
const isObject = type.startsWith('{') || (type !== 'string' && type !== 'number' &&
  type !== 'boolean' && type !== 'any' && !type.includes('|') &&
  (m[4].trim().startsWith('{') || m[4].trim().startsWith('[')));

items.push({ name, type, value: m[4].trim().replace(/;$/, ''), isObject });
```

}
return items;
}

function extractTemplateRefNames(classBody) {
const refs = new Set();
const re = /this.$refs.(\w+)/g;
let m;
while ((m = re.exec(classBody)) !== null) refs.add(m[1]);
return refs;
}

function extractComputed(classBody) {
const getters = {}, setters = {};
const re = /(get|set)\s+(\w+)\s*(([^)]*))(?:\s*:\s*([^{]+))?\s*{/g;
let m;
while ((m = re.exec(classBody)) !== null) {
const kind = m[1], name = m[2], param = m[3].trim(), retType = m[4] ? m[4].trim() : ‘’;
const braceStart = m.index + m[0].length - 1;
let depth = 1, idx = braceStart + 1;
while (idx < classBody.length && depth > 0) {
if (classBody[idx] === ‘{’) depth++;
else if (classBody[idx] === ‘}’) depth–;
idx++;
}
const body = classBody.slice(braceStart + 1, idx - 1);
if (kind === ‘get’) getters[name] = { returnType: retType, body };
else setters[name] = { param, body };
}
return Object.keys(getters).map(name => ({
name, getter: getters[name], setter: setters[name] || null
}));
}

function extractMethods(classBody) {
const methods = [];
const LIFECYCLE = new Set([
‘beforeCreate’,‘created’,‘beforeMount’,‘mounted’,‘beforeUpdate’,‘updated’,
‘beforeDestroy’,‘destroyed’,‘beforeUnmount’,‘unmounted’,‘activated’,
‘deactivated’,‘errorCaptured’,‘renderTracked’,‘renderTriggered’,‘serverPrefetch’
]);
const SKIP = new Set([‘get’,‘set’,‘if’,‘for’,‘while’,‘switch’,‘return’,‘const’,‘let’,‘var’,
‘new’,‘import’,‘export’,‘class’,‘catch’,‘finally’,‘function’,‘typeof’,‘instanceof’]);

// Pre-scan: @Watch decorators mapped to the method they precede
const watchDecoratorMap = {};
const lines = classBody.split(’\n’);
for (let i = 0; i < lines.length; i++) {
const line = lines[i].trim();
const wm = line.match(/^@Watch([’”]([^'"]+)[’”]\s*(?:,\s*({[^}]+}))?)/);
if (wm) {
for (let j = i + 1; j < lines.length; j++) {
const next = lines[j].trim();
if (!next || next.startsWith(’@’)) continue;
const nm = next.match(/^(?:(?:async|private|public|protected)\s+)*(\w+)\s*(/);
if (nm) watchDecoratorMap[nm[1]] = { target: wm[1], opts: wm[2] || null };
break;
}
}
}

const re = /(?:^|\n)[ \t]*(?:(async)\s+)?(?:(?:private|public|protected)\s+)?(?:(async)\s+)?(\w+)\s*(([^)]*))\s*(?::\s*(?!{)([^\n{]+))?\s*{/g;
let m;
while ((m = re.exec(classBody)) !== null) {
const isAsync = !!(m[1] || m[2]);
const name = m[3];
const params = m[4].trim();
const returnType = m[5] ? m[5].trim() : ‘’;
if (SKIP.has(name)) continue;

```
const braceStart = m.index + m[0].length - 1;
let depth = 1, idx = braceStart + 1;
while (idx < classBody.length && depth > 0) {
  if (classBody[idx] === '{') depth++;
  else if (classBody[idx] === '}') depth--;
  idx++;
}
const body = classBody.slice(braceStart + 1, idx - 1);
const hasAwait = body.includes('await ') || isAsync;
const watchInfo = watchDecoratorMap[name];

if (watchInfo) {
  methods.push({ name, params, returnType, body, isWatch: true,
    watchTarget: watchInfo.target, watchOpts: watchInfo.opts, isAsync: hasAwait });
} else if (LIFECYCLE.has(name)) {
  methods.push({ name, params, returnType, body, isLifecycle: true, isAsync: hasAwait });
} else {
  methods.push({ name, params, returnType, body, isMethod: true, isAsync: hasAwait });
}
```

}
return methods;
}

function extractEmits(classBody) {
const emits = [];
const re = /this.$emit([’”]([^'"]+)[’”]/g;
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
return (m[1].match(/(\w+)\s*(/g) || []).map(f => f.replace(’(’, ‘’).trim());
}

function extractMixins(componentOptions, classBody) {
const mixins = [];
if (componentOptions) {
const m = componentOptions.match(/mixins\s*:\s*[([^]]+)]/);
if (m) mixins.push(…m[1].split(’,’).map(s => s.trim()).filter(Boolean));
}
if (classBody.includes(‘Mixins(’) || classBody.includes(‘mixins(’)) {
mixins.push(’(detected via Mixins() helper)’);
}
return mixins;
}

// — Breaking Change Detectors ————————————————

function detectBreakingChanges(classBody) {
const issues = [];
if (/this.$set\b/.test(classBody))
issues.push(’$set is deleted in Vue 3 — use direct assignment (Proxy reactivity handles it).’);
if (/this.$delete\b/.test(classBody))
issues.push(’$delete is deleted in Vue 3 — use delete obj.key or array splice directly.’);
if (/this.$listeners\b/.test(classBody))
issues.push(’$listeners is deleted — merged into $attrs in Vue 3.’);
if (/this.$on\b|this.$off\b|this.$once\b/.test(classBody))
issues.push(’$on/$off/$once are deleted — use an external event bus like mitt.’);
if (/v-model/.test(classBody) || /modelValue/.test(classBody))
issues.push(‘v-model: prop is now “modelValue”, event is “update:modelValue”.’);
return issues;
}

// — Utilities ––––––––––––––––––––––––––––––––

function toKebabCase(str) {
return str.replace(/([a-z])([A-Z])/g, ‘$1-$2’).toLowerCase();
}

// — this.X → X.value rewriter ————————————————

function makeRewriter(propNames, dataNames, computedNames, templateRefNames, methodNames, refDecoratorNames) {
return function rewrite(body) {
let out = body
.replace(/this.$router\b/g, ‘router’)
.replace(/this.$route\b/g, ‘route’)
.replace(/this.$store\b/g, ‘store’)
.replace(/this.$emit\s*(/g, ‘emit(’)
.replace(/this.$nextTick/g, ‘nextTick’)
.replace(/this.$el\b/g, ‘templateEl.value’)
.replace(/this.$attrs\b/g, ‘attrs’)          // useAttrs()
.replace(/this.$slots\b/g, ‘slots’)           // useSlots()
.replace(/this.$refs.(\w+)/g, (_, n) => `${n}.value`)
// Deleted APIs — leave clear runtime-error-preventing comments
.replace(/this.$set\s*(/g, ‘/* $set deleted — use direct assignment */ (’)
.replace(/this.$delete\s*(/g, ‘/* $delete deleted — use delete/splice */ (’)
.replace(/this.$on\s*(/g, ‘/* $on deleted — use mitt */ (’)
.replace(/this.$off\s*(/g, ‘/* $off deleted — use mitt */ (’)
.replace(/this.$once\s*(/g, ‘/* $once deleted — use mitt */ (’)
.replace(/this.$listeners\b/g, ’/* $listeners deleted → use $attrs */ attrs’);

```
// Remaining unknown $xxx
out = out.replace(/this\.\$(\w+)/g, '/* TODO: this.$$$1 */ $1');

// Named references: prop, data ref, computed, template ref, @Ref decorator, method
out = out.replace(/this\.(\w+)/g, (match, name) => {
  if (propNames.has(name))           return `props.${name}`;
  if (dataNames.has(name))           return `${name}.value`;
  if (computedNames.has(name))       return `${name}.value`;
  if (templateRefNames.has(name))    return `${name}.value`;
  if (refDecoratorNames && refDecoratorNames.has(name)) return `${name}.value`;
  if (methodNames && methodNames.has(name)) return name;
  return `/* TODO: this.${name} */ ${name}`;
});

return out;
```

};
}

// — Code Generators –––––––––––––––––––––––––––––

const LIFECYCLE_MAP = {
beforeCreate: null, created: null,
beforeMount: ‘onBeforeMount’,   mounted: ‘onMounted’,
beforeUpdate: ‘onBeforeUpdate’, updated: ‘onUpdated’,
beforeDestroy: ‘onBeforeUnmount’, destroyed: ‘onUnmounted’,
beforeUnmount: ‘onBeforeUnmount’, unmounted: ‘onUnmounted’,
activated: ‘onActivated’,       deactivated: ‘onDeactivated’,
errorCaptured: ‘onErrorCaptured’,
renderTracked: ‘onRenderTracked’, renderTriggered: ‘onRenderTriggered’,
serverPrefetch: ‘onServerPrefetch’,
};

function generateProps(props, models) {
const lines = [
…props.map(p => {
const opt = !p.required || p.type.includes(‘undefined’) || p.type.includes(’|’);
return `  ${p.name}${opt ? '?' : ''}: ${p.type}`;
}),
…models.map(mo => `  ${mo.name}?: ${mo.type}`)
];
if (!lines.length) return ‘’;
return `const props = defineProps<{\n${lines.join(';\n')}\n}>();`;
}

function generateEmits(emits, models, emitDecoratorMap) {
// Collect all unique event names
const all = new Set([
…emits.map(e => `'${e}'`),
…models.map(mo => `'${mo.event}'`),
…Object.values(emitDecoratorMap).map(e => `'${e}'`)
]);
if (!all.size) return ‘’;
return `const emit = defineEmits([${[...all].join(', ')}]);`;
}

function generateRefDecorators(refDecorators) {
if (!refDecorators.length) return ‘’;
return refDecorators.map(r =>
`const ${r.propName} = ref<${r.type} | null>(null); // @Ref('${r.refAlias}')`
).join(’\n’);
}

function generateTemplateRefs(refNames) {
if (!refNames.length) return ‘’;
return refNames.map(n =>
`const ${n} = ref<InstanceType<typeof ${capitalize(n)}> | null>(null); // TODO: fix type`
).join(’\n’);
}

function generateRefs(dataItems) {
return dataItems.map(d => {
if (d.isObject) {
return `// Consider reactive() for deep object: const ${d.name} = reactive<${d.type}>(${d.value});\nconst ${d.name} = ref<${d.type}>(${d.value});`;
}
return `const ${d.name} = ref<${d.type}>(${d.value});`;
}).join(’\n’);
}

function generateProvide(provides) {
if (!provides.length) return ‘’;
const lines = provides.map(p => `provide('${p.key}', ${p.value});`);
return lines.join(’\n’);
}

function generateInject(injects) {
if (!injects.length) return ‘’;
const lines = injects.map(i => `const ${i.propName} = inject<${i.type}>('${i.key}');`);
return lines.join(’\n’);
}

function generateComputed(computedList, rewrite) {
return computedList.map(c => {
const getBody = rewrite(c.getter.body);
const retType = c.getter.returnType ? `: ${c.getter.returnType}` : ‘’;
if (c.setter) {
const setBody = rewrite(c.setter.body);
return (
`const ${c.name} = computed({\n` +
`  get()${retType} {\n${indent(getBody.trim(), 4)}\n  },\n` +
`  set(${c.setter.param}) {\n${indent(setBody.trim(), 4)}\n  }\n});`
);
}
return `const ${c.name} = computed(()${retType} => {\n${indent(getBody.trim(), 2)}\n});`;
}).join(’\n\n’);
}

function generateMethods(methods, rewrite, emitDecoratorMap) {
return methods.filter(m => m.isMethod).map(m => {
const body = rewrite(m.body);
const asyncKw = m.isAsync ? ’async ’ : ‘’;
const retType = m.returnType ? `: ${m.returnType}` : ‘’;

```
// @Emit: emit return value before returning (Vue 3 pattern)
const eventName = emitDecoratorMap[m.name];
let finalBody = body.trim();
if (eventName) {
  const alreadyEmits = finalBody.includes(`emit('${eventName}'`);
  if (!alreadyEmits) {
    const returnMatch = finalBody.match(/return (.+?);[ \t]*$/m);
    if (returnMatch) {
      const retVal = returnMatch[1];
      finalBody = finalBody.replace(
        /return (.+?);[ \t]*$/m,
        `emit('${eventName}', ${retVal});\n  return ${retVal};`
      );
    } else {
      finalBody += `\nemit('${eventName}');`;
    }
  }
}
return `const ${m.name} = ${asyncKw}(${m.params})${retType} => {\n${indent(finalBody, 2)}\n};`;
```

}).join(’\n\n’);
}

function generateLifecycle(methods, rewrite) {
return methods.filter(m => m.isLifecycle).map(m => {
const body = rewrite(m.body);
const hook = LIFECYCLE_MAP[m.name];
if (!hook) return `// ${m.name} → runs inline in <script setup>\n${body.trim()}`;
const asyncKw = m.isAsync ? ‘async ’ : ‘’;
return `${hook}(${asyncKw}() => {\n${indent(body.trim(), 2)}\n});`;
}).join(’\n\n’);
}

function generateWatchers(methods, rewrite, dataNames, propNames) {
return methods.filter(m => m.isWatch).map(m => {
const body = rewrite(m.body);
const opts = m.watchOpts ? `, ${m.watchOpts}` : ‘’;
const asyncKw = m.isAsync ? ‘async ’ : ‘’;
let source;
if (propNames.has(m.watchTarget))      source = `() => props.${m.watchTarget}`;
else if (dataNames.has(m.watchTarget)) source = m.watchTarget; // ref passed directly
else source = `() => ${m.watchTarget}`;
return `watch(${source}, ${asyncKw}(${m.params}) => {\n${indent(body.trim(), 2)}\n}${opts});`;
}).join(’\n\n’);
}

// — Import Builder ———————————————————–

function buildVue3Imports({
dataItems, computedList, watchMethods, lifecycleMethods,
usesNextTick, usesRouter, usesRoute, usesStore, usesI18n,
usesAttrs, usesSlots, templateRefs, refDecorators,
provides, injects
}, oldImports) {
const vueSet = new Set();

if (dataItems.length || templateRefs.length || refDecorators.length) vueSet.add(‘ref’);
if (computedList.length) vueSet.add(‘computed’);
if (watchMethods.length) vueSet.add(‘watch’);
if (usesNextTick) vueSet.add(‘nextTick’);
if (provides.length) vueSet.add(‘provide’);
if (injects.length) vueSet.add(‘inject’);
if (usesAttrs) vueSet.add(‘useAttrs’);
if (usesSlots) vueSet.add(‘useSlots’);

for (const m of lifecycleMethods) {
const hook = LIFECYCLE_MAP[m.name];
if (hook) vueSet.add(hook);
}

const routerSet = new Set();
if (usesRouter) routerSet.add(‘useRouter’);
if (usesRoute) routerSet.add(‘useRoute’);

// Clean old Vue 2 specific imports
const cleaned = oldImports.filter(l =>
!l.includes(‘vue-class-component’) &&
!l.includes(‘vue-property-decorator’) &&
!l.includes(“from ‘vue’”) && !l.includes(‘from “vue”’) &&
!l.includes(“from ‘vue-router’”) && !l.includes(‘from “vue-router”’) &&
!l.includes(“from ‘vue-i18n’”) && !l.includes(‘from “vue-i18n”’)
);

const lines = [];
if (vueSet.size) lines.push(`import { ${[...vueSet].sort().join(', ')} } from 'vue';`);
if (routerSet.size) lines.push(`import { ${[...routerSet].sort().join(', ')} } from 'vue-router';`);
if (usesStore) lines.push(`import { useStore } from 'vuex'; // TODO: consider migrating to Pinia`);
if (usesI18n) lines.push(`import { useI18n } from 'vue-i18n';`);
lines.push(…cleaned);
return lines.filter(Boolean).join(’\n’);
}

// — Main Transform ———————————————————–

function transformComponent(source, filename = ‘Component.vue’) {
const warnings = [];

const template = extractTemplateBlock(source);
const style = extractStyleBlock(source);
const { scriptContent, lang } = extractScriptBlock(source);

if (!scriptContent) {
return { output: source, warnings: [‘No <script> block found — file unchanged.’] };
}

const { importLines, restScript } = parseImports(scriptContent);
const { className, componentOptions, classBody } = parseClassBody(restScript);

if (!classBody) {
warnings.push(‘Could not detect Vue 2 class syntax — may already be Vue 3 or Options API.’);
return { output: source, warnings };
}

// – Extract everything ——————————————————
const props          = extractProps(classBody);
const models         = extractModel(classBody);
const emitDecoratorMap = extractEmitDecorators(classBody);
const refDecorators  = extractRefDecorators(classBody);
const provides       = extractProvide(classBody);
const injects        = extractInject(classBody);

const propNames         = new Set(props.map(p => p.name));
const modelNames        = new Set(models.map(mo => mo.name));
const refDecoratorNames = new Set(refDecorators.map(r => r.propName));

const dataItems      = extractData(classBody, propNames, modelNames, refDecoratorNames);
const dataNames      = new Set(dataItems.map(d => d.name));
const computedList   = extractComputed(classBody);
const computedNames  = new Set(computedList.map(c => c.name));
const templateRefNames = extractTemplateRefNames(classBody);
const allMethods     = extractMethods(classBody);
const lifecycleMethods = allMethods.filter(m => m.isLifecycle);
const watchMethods   = allMethods.filter(m => m.isWatch);
const normalMethods  = allMethods.filter(m => m.isMethod);
const emits          = extractEmits(classBody);
const filters        = extractFilters(componentOptions);
const mixins         = extractMixins(componentOptions, classBody);
const breakingChanges = detectBreakingChanges(classBody);

const methodNames = new Set(allMethods.map(m => m.name));
const rewrite = makeRewriter(propNames, dataNames, computedNames, templateRefNames, methodNames, refDecoratorNames);

// – Feature flags ———————————————————–
const usesNextTick = classBody.includes(’$nextTick’);
const usesRouter   = classBody.includes(‘this.$router’);
const usesRoute    = classBody.includes(‘this.$route’);
const usesStore    = classBody.includes(‘this.$store’);
const usesI18n     = classBody.includes(‘this.$t(’) || classBody.includes(‘this.$i18n’);
const usesAttrs    = classBody.includes(‘this.$attrs’);
const usesSlots    = classBody.includes(‘this.$slots’);

// – Imports —————————————————————–
const imports = buildVue3Imports({
dataItems, computedList, watchMethods, lifecycleMethods,
usesNextTick, usesRouter, usesRoute, usesStore, usesI18n,
usesAttrs, usesSlots,
templateRefs: […templateRefNames],
refDecorators, provides, injects
}, importLines);

// – Assemble script body ––––––––––––––––––––––––––
const parts = [];

const propsCode = generateProps(props, models);
if (propsCode) parts.push(propsCode);

const emitsCode = generateEmits(emits, models, emitDecoratorMap);
if (emitsCode) parts.push(emitsCode);

// Composable inits
const composableInits = [];
if (usesRouter) composableInits.push(‘const router = useRouter();’);
if (usesRoute)  composableInits.push(‘const route = useRoute();’);
if (usesStore)  composableInits.push(‘const store = useStore();’);
if (usesI18n)   composableInits.push(‘const { t } = useI18n();’);
if (usesAttrs)  composableInits.push(‘const attrs = useAttrs();’);
if (usesSlots)  composableInits.push(‘const slots = useSlots();’);
if (composableInits.length) parts.push(composableInits.join(’\n’));

// provide / inject
const provideCode = generateProvide(provides);
if (provideCode) parts.push(provideCode);
const injectCode = generateInject(injects);
if (injectCode) parts.push(injectCode);

// @Ref decorator refs
const refDecoratorCode = generateRefDecorators(refDecorators);
if (refDecoratorCode) parts.push(refDecoratorCode);

// $refs-based template refs
const templateRefCode = generateTemplateRefs([…templateRefNames]);
if (templateRefCode) parts.push(templateRefCode);

// Reactive data
const refsCode = generateRefs(dataItems);
if (refsCode) parts.push(refsCode);

// Computed
const computedCode = generateComputed(computedList, rewrite);
if (computedCode) parts.push(computedCode);

// Methods
const methodsCode = generateMethods(normalMethods, rewrite, emitDecoratorMap);
if (methodsCode) parts.push(methodsCode);

// Lifecycle
const lifecycleCode = generateLifecycle(lifecycleMethods, rewrite);
if (lifecycleCode) parts.push(lifecycleCode);

// Watchers
const watchersCode = generateWatchers(watchMethods, rewrite, dataNames, propNames);
if (watchersCode) parts.push(watchersCode);

// Note: defineExpose intentionally omitted.
// <script setup> bindings are auto-accessible in the template.
// Add defineExpose manually only when a parent needs ref access to internals.

// Component registration comment
let componentsDef = ‘’;
if (componentOptions) {
const compMatch = componentOptions.match(/components\s*:\s*({[^}]+})/);
if (compMatch) {
componentsDef = `// [OK] Components auto-registered in Vue 3 SFC\n// Was: ${compMatch[0]}\n`;
}
}

const setupBody = parts.filter(Boolean).join(’\n\n’);
const header = `${imports}\n\n${componentsDef}// Migrated from Vue 2 Class Component: ${className}\n`;
const scriptTag = `<script setup lang="${lang}">\n${header}\n${setupBody}\n</script>`;

const outputParts = [template, ‘’, scriptTag];
if (style) outputParts.push(’’, style);
const output = outputParts.join(’\n’).trim() + ‘\n’;

// – Warnings ––––––––––––––––––––––––––––––––
for (const bc of breakingChanges) warnings.push(`[!] Breaking change: ${bc}`);
if (filters.length)
warnings.push(`Filters (${filters.join(', ')}) removed in Vue 3 — convert to computed props or methods.`);
if (mixins.length)
warnings.push(`Mixins (${mixins.join(', ')}) detected — convert to composables (useXxx functions).`);
if (models.length)
warnings.push(`@Model migrated to prop+emit. Consider defineModel() on Vue 3.4+.`);
if (refDecorators.length)
warnings.push(`@Ref decorators migrated to ref(null) — verify types for: ${refDecorators.map(r => r.propName).join(', ')}.`);
if (templateRefNames.size)
warnings.push(`Template $refs (${[...templateRefNames].join(', ')}) — fix types in generated ref declarations.`);
if (provides.length || injects.length)
warnings.push(`provide/inject migrated — verify keys match between parent and child components.`);
if (dataItems.some(d => d.isObject))
warnings.push(`Some data properties may be deeply mutated objects — consider reactive() over ref().`);
if (output.includes(’/* TODO:’))
warnings.push(`Some this.X references unresolved — search "/* TODO:" in the output.`);
if (watchMethods.length || computedList.length)
warnings.push(‘Review watch() and computed() bodies for correctness.’);

return { output, warnings };
}

module.exports = { transformComponent };
