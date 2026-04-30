<template>
  <div class="complex-component">
    <h1>{{ greeting }}</h1>
    <p>Status: {{ status }}</p>
    <p>Synced Prop: {{ localSyncedValue }}</p>
    <div ref="scrollContainer">
      <li v-for="item in items" :key="item.id" ref="listItems">
        {{ item.name }} - {{ $t('common.price') }}: {{ item.price | currency }}
      </li>
    </div>
    <button @click="handleEmit">Update & Emit</button>
    <child-component v-model="internalValue" />
    <async-component v-if="showAsync" />
  </div>
</template>

<script lang="ts">
import {
  Component,
  Vue,
  Prop,
  Watch,
  Emit,
  Model,
  Ref,
  Provide,
  Inject,
} from 'vue-property-decorator';
import { State, Getter, Action } from 'vuex-class';
import { Mixins } from 'vue-class-component';
import MyMixin from '@/mixins/MyMixin';
import ChildComponent from './ChildComponent.vue';

/**
 * EXTREMELY COMPLEX VUE 2 CLASS COMPONENT
 * Tests: Mixins, Vuex Decorators, Provide/Inject, PropSync, Model, Multi-line Watchers,
 * Legacy $listeners, Async Components, and custom Filters.
 */
@Component({
  components: {
    ChildComponent,
    AsyncComponent: () => import('./AsyncComponent.vue'),
  },
  filters: {
    currency(value: number) {
      return `$${value.toFixed(2)}`;
    },
  },
})
export default class ComplexComponent extends Mixins(MyMixin) {
  // 1. Props & Model
  @Prop({ type: String, default: 'Default' }) readonly title!: string;
  @Model('change', { type: Boolean }) readonly checked!: boolean;

  // 2. PropSync (Two-way binding prop)
  @PropSync('syncedValue', { type: String }) localSyncedValue!: string;

  // 3. Vuex State & Getters
  @State('user') currentUser!: any;
  @Getter('isLoggedIn') authenticated!: boolean;
  @Action('fetchData') dispatchFetchData!: (id: number) => Promise<void>;

  // 4. Provide / Inject
  @Provide('themeConfig') theme = { color: 'blue', density: 'high' };
  @Inject('globalBus') bus!: any;

  // 5. Template Refs
  @Ref('scrollContainer') readonly container!: HTMLDivElement;
  @Ref() readonly listItems!: HTMLLIElement[];

  // 6. Data (Reactive State)
  public items: Array<{ id: number; name: string; price: number }> = [
    { id: 1, name: 'Tool A', price: 10 },
    { id: 2, name: 'Tool B', price: 20 },
  ];
  private internalValue: boolean = false;
  protected showAsync: boolean = false;
  public status: string = 'initializing';

  // 7. Computed
  get greeting(): string {
    return `${this.title}, ${this.currentUser?.name || 'Guest'}`;
  }

  set greeting(val: string) {
    this.status = `Greeting updated to ${val}`;
  }

  // 8. Watchers (Complex/Multi-line)
  @Watch('items', { deep: true, immediate: true })
  onItemsChanged(val: any, oldVal: any) {
    console.log('Items updated:', val);
    this.$nextTick(() => {
      this.status = 'List rendered';
    });
  }

  // 9. Lifecycle Hooks
  async created() {
    this.status = 'Loading...';
    await this.dispatchFetchData(123);
    this.bus.$on('refresh', this.handleEmit);
  }

  mounted() {
    console.log('Mounted el:', this.$el);
    console.log('Listeners:', this.$listeners); // Legacy check
  }

  beforeDestroy() {
    this.bus.$off('refresh', this.handleEmit);
  }

  // 10. Methods & Emits
  @Emit('submit')
  public handleEmit() {
    this.items.push({
      id: Date.now(),
      name: 'New Item',
      price: Math.random() * 100,
    });
    // This calls the mixin method
    this.mixinMethod();
    return this.items; // Emitted value
  }

  public async updateInternalState(id: string): Promise<void> {
    try {
      this.$set(this.items[0], 'price', 99); // Vue 2 $set
      this.showAsync = true;
    } catch (e) {
      this.$delete(this.items, 1); // Vue 2 $delete
    }
  }
}
</script>

<style scoped>
.complex-component {
  padding: 20px;
}
</style>
