# vue2-to-vue3-migrator

A local CLI tool that automatically migrates **Vue 2 Class Components (TypeScript)** to **Vue 3 Composition API** (`<script setup>`).

-----

## Installation

### Option A — Install globally from the folder

```bash
# Unzip the package, then:
cd vue2-to-vue3-migrator
npm install
npm link        # makes `vue-migrate` available globally
```

### Option B — Use directly with npx / node

```bash
cd vue2-to-vue3-migrator
npm install
node bin/cli.js --help
```

-----

## Commands

### `vue-migrate all <dir>` — Migrate an entire folder

```bash
# Migrate all .vue files in src/ (with backup)
vue-migrate all ./src

# Dry run — preview what would change, no files written
vue-migrate all ./src --dry-run

# Migrate without creating .vue2.bak backups
vue-migrate all ./src --no-backup

# Custom glob (e.g. only top-level components)
vue-migrate all ./src --pattern "components/*.vue"
```

### `vue-migrate file <path>` — Migrate one file

```bash
# Migrate a single component
vue-migrate file src/components/UserCard.vue

# Preview the output without writing
vue-migrate file src/components/UserCard.vue --dry-run

# Print the transformed code to stdout
vue-migrate file src/components/UserCard.vue --print
```

### `vue-migrate preview <path>` — Print transformed output

```bash
vue-migrate preview src/components/UserCard.vue
# Prints migrated code to stdout — great for piping or inspection
```

### `vue-migrate interactive` — Step through files one by one

```bash
# Interactive mode in current directory
vue-migrate interactive

# Specify a directory
vue-migrate interactive --dir ./src
```

In interactive mode, for each file you can:

- ✔ **Migrate** — apply the migration
- 👁 **Preview** — see the diff first, then decide
- ⊘ **Skip** — leave the file untouched
- ✖ **Quit** — stop processing

-----

## What Gets Migrated

|Vue 2 Class Feature         |Vue 3 Output               |
|----------------------------|---------------------------|
|`@Prop()` decorators        |`defineProps<{...}>()`     |
|`@Watch()` decorators       |`watch(() => ...)`         |
|Class data properties       |`ref<Type>(value)`         |
|`get` computed              |`computed(() => ...)`      |
|`get`/`set` computed        |`computed({ get, set })`   |
|Class methods               |`const fn = () => {}`      |
|`mounted()`                 |`onMounted(...)`           |
|`beforeDestroy()`           |`onBeforeUnmount(...)`     |
|`created()`                 |inline in `<script setup>` |
|`this.$emit(...)`           |`emit(...)` + `defineEmits`|
|`this.$router`              |`useRouter()`              |
|`this.$route`               |`useRoute()`               |
|`this.$store`               |`useStore()`               |
|`this.$nextTick`            |`nextTick`                 |
|Vue imports                 |Cleaned up automatically   |
|`@Component({ components })`|Auto-registered (Vue 3 SFC)|

-----

## Backup Files

By default, a `.vue2.bak` backup is created alongside every modified file:

```
UserCard.vue        ← migrated Vue 3 file
UserCard.vue.vue2.bak  ← original preserved
```

Use `--no-backup` to skip this.

-----

## After Migration — Manual Checklist

The tool handles ~80-90% of migrations automatically. Review these manually:

- [ ] `ref` values need `.value` in `<script>` (template refs are fine)
- [ ] Complex `this.$` usages are marked with `// TODO` comments
- [ ] Vuex: consider migrating to Pinia (`useStore()` still works with Vuex 4)
- [ ] `$refs` → `const myRef = ref(null)` + `useTemplateRef`
- [ ] Mixins → composables (not automatically converted)
- [ ] `@Model` decorator → `defineModel()` (Vue 3.3+)
- [ ] Filters → converted to methods/computed (Vue 3 removed filters)

-----

## Example

**Before (Vue 2):**

```vue
<script lang="ts">
import { Component, Prop, Vue } from 'vue-property-decorator';

@Component
export default class MyButton extends Vue {
  @Prop({ type: String, required: true }) label!: string;
  count: number = 0;

  get doubled(): number {
    return this.count * 2;
  }

  increment(): void {
    this.count++;
    this.$emit('clicked', this.count);
  }

  mounted(): void {
    console.log('ready');
  }
}
</script>
```

**After (Vue 3):**

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

const props = defineProps<{
  label: string;
}>();

const emit = defineEmits(['clicked']);

const count = ref<number>(0);

const doubled = computed((): number => {
  return count.value * 2;
});

const increment = (): void => {
  count.value++;
  emit('clicked', count.value);
};

onMounted(() => {
  console.log('ready');
});

defineExpose({ count, doubled, increment });
</script>
```
