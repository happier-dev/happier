import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

const scrollCapture = vi.hoisted(() => ({ offsets: [] as number[], observe: null as null | ((event: { nativeEvent: { contentOffset: { y: number } } }) => void) }));

/**
 * The platform section virtualizer, fully mounted: every header and row cell renders, keyed exactly as the
 * platform keys them, so a remount is observable as a new DOM node. Scroll requests are recorded.
 */
vi.mock('react-native', async () => {
  const native = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...native,
    SectionList: function MountedSectionList(props: Readonly<{
      sections: readonly Readonly<{ key: string; data: readonly unknown[] }>[];
      keyExtractor(item: unknown, index: number): string;
      renderItem(input: Readonly<{ item: unknown; index: number; section: unknown }>): React.ReactNode;
      renderSectionHeader?(input: Readonly<{ section: unknown }>): React.ReactNode;
      ListFooterComponent?: React.ReactNode;
      role?: string;
      ref?: React.Ref<unknown>;
      onScroll?: (event: { nativeEvent: { contentOffset: { y: number } } }) => void;
    }>) {
      scrollCapture.observe = props.onScroll ?? null;
      React.useImperativeHandle(props.ref, () => ({
        scrollToLocation() {},
        getScrollResponder: () => ({ scrollTo: (input: Readonly<{ y: number }>) => { scrollCapture.offsets.push(input.y); } }),
      }), []);
      return (
        <div role={props.role} data-testid="virtualizer">
          {props.sections.map((section) => (
            <React.Fragment key={section.key}>
              {props.renderSectionHeader?.({ section })}
              {section.data.map((item, index) => (
                <React.Fragment key={props.keyExtractor(item, index)}>
                  {props.renderItem({ item, index, section })}
                </React.Fragment>
              ))}
            </React.Fragment>
          ))}
          {props.ListFooterComponent}
        </div>
      );
    },
  };
});

import type { ReactElement } from 'react';
import { Text, View } from 'react-native';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import type {
  PluginUiDetailsPaneHost,
  PluginUiDetailsPanePresentation,
  PluginUiPresentationHost,
} from '../presentationHost/context.js';
import type {
  HappierCollectionAnimatedViewProps,
  HappierCollectionMotionDriver,
  HappierCollectionMotionValue,
} from '../presentation/collection/collectionMotion.js';
import { resolveHappierCollectionTrackStyle } from '../presentation/collection/collectionMotion.js';
import { useHappierCollection } from '../presentation/collection/useCollection.js';
import type { HappierCollectionGrouping } from '../presentation/collection/collectionModel.js';
import type { HappierLayoutChangeEvent } from '../presentation/portableTypes.js';
import { Collection, type CollectionAnatomy, type CollectionProps } from './Collection.js';
import { Button } from './Button.js';
import { Heading } from './Foundation.js';
import { usePluginUiFocusTarget } from './Focus.js';
import { PageHeader } from './PageHeader.js';
import { HappierText } from '../presentation/text/Text.js';
import { createListMultiSelectionStore } from './ListMultiSelection.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';

type Entry = Readonly<{ id: string; title: string; group: 'needs' | 'rest'; repo: string; reason: string; age: string }>;

const entries: readonly Entry[] = [
  { id: 'a', title: 'Retry idempotent payment intents', group: 'needs', repo: 'payments-api', reason: 'Review requested', age: '18m' },
  { id: 'b', title: 'Move cart totals to the server', group: 'needs', repo: 'checkout-web', reason: 'Codex needs you', age: '42m' },
  { id: 'c', title: 'Dark mode date picker', group: 'rest', repo: 'mobile', reason: '', age: '1d' },
];

const anatomy: CollectionAnatomy<Entry> = {
  glyph: () => <Text>•</Text>,
  title: (entry) => entry.title,
  where: (entry) => entry.repo,
  reason: (entry) => entry.reason || null,
  age: (entry) => entry.age,
  peek: (entry) => <Text testID={`peek-content:${entry.id}`}>{`About ${entry.title}`}</Text>,
  accessibilityLabel: (entry) => entry.title,
  testID: (entry) => `row:${entry.id}`,
  columnTitles: { title: 'Entry', where: 'Where', reason: "Why it's here", age: 'Age' },
};

const groups = {
  axis: [
    { key: 'needs', title: 'Needs you', description: 'You act next' },
    { key: 'rest', title: 'Everything else' },
  ],
  groupOf: (entry: Entry) => entry.group,
};
const keyOf = (entry: Entry) => entry.id;

/** A motion driver the test steps by hand: each animation waits until the test finishes or interrupts it. */
function createManualMotion() {
  const animations: Array<Readonly<{ target: number; durationMs: number; from: number }>> = [];
  let pending: ((finished: boolean) => void) | null = null;
  let current: (HappierCollectionMotionValue & { subscribe: (listener: () => void) => () => void; value: number }) | null = null;
  const listeners = new Set<() => void>();
  let target = 0;
  const driver: HappierCollectionMotionDriver = {
    useValue: (initial) => React.useMemo(() => {
      const value = {
        value: initial,
        get: () => value.value,
        set: (next: number) => {
          value.value = next;
          for (const listener of listeners) listener();
        },
        animateTo: (next: number, durationMs: number, onFinished: (finished: boolean) => void) => {
          const interrupted = pending;
          pending = null;
          interrupted?.(false);
          animations.push({ target: next, durationMs, from: value.value });
          target = next;
          pending = onFinished;
        },
        cancel: () => {
          const interrupted = pending;
          pending = null;
          interrupted?.(false);
        },
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      };
      current = value;
      return value;
    }, []),
    AnimatedView: function ManualAnimatedView(props: HappierCollectionAnimatedViewProps): ReactElement {
      const value = props.value as HappierCollectionMotionValue & { subscribe: (listener: () => void) => () => void };
      const progress = React.useSyncExternalStore(value.subscribe, value.get, value.get);
      return (
        <View testID={props.testID} pointerEvents={props.pointerEvents} style={[props.style, resolveHappierCollectionTrackStyle(props.tracks, progress)]}>
          {props.children}
        </View>
      );
    },
    durationsMs: { open: 320, close: 220, reducedMotion: 140 },
  };
  return {
    driver,
    animations,
    /** Moves the presentation value partway, as frames would. */
    step: (to: number) => { act(() => { current!.set(to); }); },
    /** Lands the running animation at its target. */
    finish: () => {
      act(() => {
        current!.set(target);
        const done = pending;
        pending = null;
        done?.(true);
      });
    },
  };
}

/**
 * The page's app details pane as the app binds it: a publisher rendered in place and a pane slot mounted beside
 * the plugin tree (outside its providers), reading the published pane.
 */
function createPaneHost() {
  let published: PluginUiDetailsPanePresentation | null = null;
  const listeners = new Set<() => void>();
  function Publisher(props: Readonly<{ input: PluginUiDetailsPanePresentation }>) {
    published = props.input;
    React.useLayoutEffect(() => { listeners.forEach((listener) => listener()); });
    return null;
  }
  const binding: PluginUiDetailsPaneHost = {
    useAvailable: () => true,
    renderDetailsPane: (input) => <Publisher input={input} />,
  };
  function Slot(): ReactElement | null {
    const input = React.useSyncExternalStore(
      (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      () => published,
    );
    return input?.open ? <View testID="host-pane"><HappierText accessibilityRole="header" ref={input.headingRef} tabIndex={input.headingRef ? -1 : undefined} testID="host-pane-title">{input.title}</HappierText><Text testID="host-pane-subtitle">{input.subtitle}</Text>{input.actions}{input.children}</View> : null;
  }
  return { binding, Slot, close: () => published?.onClose() };
}

function presentationHost(
  motion: HappierCollectionMotionDriver | undefined,
  detailsPane?: PluginUiDetailsPaneHost,
): PluginUiPresentationHost {
  return {
    ...(motion === undefined ? {} : { collectionMotion: motion }),
    ...(detailsPane === undefined ? {} : { detailsPane }),
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
  };
}

type HarnessOptions = Readonly<{
  presentation?: 'table' | 'list' | 'board' | 'grid';
  items?: readonly Entry[];
  grouped?: boolean;
  grouping?: HappierCollectionGrouping<Entry>;
  boardLayout?: CollectionProps<Entry>['boardLayout'];
  loading?: boolean;
  anatomy?: CollectionAnatomy<Entry>;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  detail?: 'auto' | 'none';
  scroll?: 'collection' | 'page';
  groupAction?: (groupKey: string) => Readonly<{ label: string; onPress: () => void }> | null;
  detailHeader?: (key: string) => Readonly<{ title: string; subtitle?: string; actions?: React.ReactNode }>;
  useRowActions?: CollectionProps<Entry>['useRowActions'];
  selection?: CollectionProps<Entry>['selection'];
  search?: CollectionProps<Entry>['search'];
  renderDetail?: CollectionProps<Entry>['renderDetail'];
}>;

type HarnessProps = HarnessOptions & Readonly<{ openKey: string | null; onOpenChange: (key: string | null) => void }>;

function Harness(props: HarnessProps): ReactElement {
  const model = useHappierCollection({
    items: props.items ?? entries,
    keyOf,
    ...(props.grouped === false ? {} : { groups: props.grouping ?? groups }),
    openKey: props.openKey,
    onOpenChange: props.onOpenChange,
    expandable: true,
  });
  return (
    <Collection
      model={model}
      anatomy={props.anatomy ?? anatomy}
      accessibilityLabel="PRs & Issues"
      presentation={props.presentation ?? 'table'}
      boardLayout={props.boardLayout}
      detail={props.detail ?? 'auto'}
      {...(props.useRowActions === undefined ? {} : { useRowActions: props.useRowActions })}
      {...(props.selection === undefined ? {} : { selection: props.selection })}
      {...(props.search === undefined ? {} : { search: props.search })}
      {...(props.scroll === undefined ? {} : { scroll: props.scroll })}
      {...(props.groupAction === undefined ? {} : { groupAction: props.groupAction })}
      minListWidth={240}
      minDetailWidth={400}
      preferredListRatio={0.3}
      renderDetail={props.renderDetail ?? ((key) => <Text testID={`detail:${key}`}>{`Detail ${key}`}</Text>)}
      {...(props.detailHeader === undefined ? {} : { detailHeader: props.detailHeader })}
      windowStatement="3 loaded · complete"
      {...(props.loading === undefined ? {} : { loading: props.loading })}
      {...(props.header === undefined ? {} : { header: props.header })}
      {...(props.footer === undefined ? {} : { footer: props.footer })}
      testID="collection"
      listTestID="collection-list"
      detailTestID="collection-detail"
    />
  );
}

function mount(options: Readonly<{
  renderDestinationRow?: PluginUiPresentationHost['renderDestinationRow'];
  renderPopover?: PluginUiPresentationHost['renderPopover'];
  motion?: HappierCollectionMotionDriver;
  reducedMotion?: boolean;
  openKey?: string | null;
  pane?: ReturnType<typeof createPaneHost>;
}> & HarnessOptions = {}) {
  const context = createSurfaceContext({ reducedMotion: options.reducedMotion ?? false });
  const hostApi = createHostApiStub(context);
  const openChanges: Array<string | null> = [];
  const host = { ...presentationHost(options.motion, options.pane?.binding),
    focusTarget: (target: { focus: () => void }) => { target.focus(); return true; },
    ...(options.renderDestinationRow === undefined ? {} : { renderDestinationRow: options.renderDestinationRow }),
    ...(options.renderPopover === undefined ? {} : { renderPopover: options.renderPopover }),
  };
  const Slot = options.pane?.Slot ?? (() => null);
  let harness: HarnessOptions = options;
  let openKey: string | null = options.openKey ?? null;
  const wrap = () => (
    <>
      <PluginUiProviderInternal hostApi={hostApi} context={context} presentationHost={host}>
        <Harness {...harness} openKey={openKey} onOpenChange={(key) => { openChanges.push(key); }} />
      </PluginUiProviderInternal>
      <Slot />
    </>
  );
  const mounted = mountThroughReactNativeWeb(wrap());
  const query = (testID: string) => mounted.container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  return {
    container: mounted.container,
    openChanges,
    query,
    queryAll: (testID: string) => [...mounted.container.querySelectorAll<HTMLElement>(`[data-testid="${testID}"]`)],
    setOpen: (next: string | null) => {
      openKey = next;
      return mounted.render(wrap());
    },
    update: (next: HarnessOptions) => {
      harness = { ...harness, ...next };
      return mounted.render(wrap());
    },
    measure: (width: number, height = 800) => {
      const root = query('collection:stage');
      const onLayout = (root as unknown as { __reactLayoutHandler: (event: HappierLayoutChangeEvent) => void }).__reactLayoutHandler;
      act(() => onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }));
    },
    unmount: mounted.unmount,
  };
}

function visible(element: HTMLElement | null): boolean {
  if (element === null) return false;
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

function headerTitles(container: HTMLElement): readonly string[] {
  const header = container.querySelector('[aria-hidden="true"]');
  return header === null ? [] : [...header.querySelectorAll('[dir="auto"]')].map((node) => node.textContent ?? '');
}

describe('Collection table', () => {
  it('restores the list viewport after visiting a different presentation', async () => {
    const view = mount({ presentation: 'list', detail: 'none' });
    view.measure(1440);
    act(() => { scrollCapture.observe!({ nativeEvent: { contentOffset: { y: 231 } } }); });
    await view.update({ presentation: 'grid' });
    const before = scrollCapture.offsets.length;
    await view.update({ presentation: 'list' });
    expect(scrollCapture.offsets.slice(before)).toContain(231);
    view.unmount();
  });
  it.each(['board', 'grid'] as const)('shares the complete multi-selection inventory across %s cells and view switches', async (presentation) => {
    const store = createListMultiSelectionStore({ scopeKey: 'entries', visibleOrderedKeys: [] });
    const view = mount({ presentation, detail: 'none', selection: { multiple: { store } } });
    view.measure(1440);
    const mode = view.query('happier-list-selection-mode');
    expect(mode).not.toBeNull();
    expect(store.getSnapshot().visibleOrderedKeys).toEqual(['a', 'b', 'c']);
    act(() => { mode!.click(); view.query('row:a')!.click(); view.query('row:c')!.click(); });
    expect([...store.getSnapshot().selectedKeys]).toEqual(['a', 'c']);
    expect(view.openChanges).toEqual([]);
    await view.update({ presentation: 'list' });
    expect([...store.getSnapshot().selectedKeys]).toEqual(['a', 'c']);
    act(() => { view.query('row:b')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })); });
    expect([...store.getSnapshot().selectedKeys].sort()).toEqual(['a', 'b', 'c']);
    view.unmount();
  });

  it.each(['list', 'board', 'grid'] as const)('extends selection through the canonical eligible inventory in %s', async (presentation) => {
    const store = createListMultiSelectionStore({ scopeKey: 'entries', visibleOrderedKeys: [] });
    const view = mount({ presentation, detail: 'none', selection: {
      multiple: { store, isItemSelectable: item => item.id !== 'b' },
    } });
    try {
      view.measure(1440);
      await act(async () => { view.query('happier-list-selection-mode')!.click(); view.query('row:a')!.click(); });
      await act(async () => { view.query('row:a')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: presentation === 'grid' ? 'ArrowRight' : 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true,
      })); });
      expect([...store.getSnapshot().selectedKeys]).toEqual(['a', 'c']);
      expect(document.activeElement).toBe(view.query('row:c'));
      expect(view.openChanges).toEqual([]);
    } finally { view.unmount(); }
  });

  it('lets the canonical selection command take precedence over a table peek', async () => {
    const store = createListMultiSelectionStore({ scopeKey: 'entries', visibleOrderedKeys: [] });
    const view = mount({ selection: { multiple: { store } } });
    try {
      view.measure(1440);
      await act(async () => { view.query('row:a')!.focus(); view.query('row:a')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: ' ', bubbles: true, cancelable: true,
      })); });
      expect([...store.getSnapshot().selectedKeys]).toEqual(['a']);
      expect(view.query('peek-content:a')).toBeNull();
      expect(view.openChanges).toEqual([]);
    } finally { view.unmount(); }
  });

  it('keeps grid positions when a primary item is inactive', async () => {
    const view = mount({ presentation: 'grid', grouped: false, detail: 'none',
      selection: { isItemActivatable: item => item.id !== 'b' } });
    try {
      view.measure(700);
      await act(async () => { view.query('row:a')!.focus(); view.query('row:a')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown', bubbles: true, cancelable: true,
      })); });
      expect(document.activeElement).toBe(view.query('row:c'));
      expect(view.openChanges).toEqual([]);
    } finally { view.unmount(); }
  });

  it('focuses the actual detail heading on a phone and on same-tree item replacement, then returns to the opener', async () => {
    const view = mount({ renderDetail: key => <><Heading level={1} testID={`detail-heading:${key}`} value={`Detail ${key}`} /><Heading value="Activity" /></> });
    view.measure(390);
    act(() => { view.query('row:b')!.click(); });
    await view.setOpen('b');
    expect(document.activeElement).toBe(view.query('detail-heading:b'));
    await view.setOpen('c');
    expect(document.activeElement).toBe(view.query('detail-heading:c'));
    await view.setOpen(null);
    expect(document.activeElement).toBe(view.query('row:c'));
    view.unmount();
  });

  it('focuses a public PageHeader when the detail is inline', async () => {
    const view = mount({ renderDetail: key => <PageHeader title={`Detail ${key}`} /> });
    view.measure(1440);
    await view.setOpen('a');
    expect(document.activeElement?.getAttribute('role')).toBe('heading');
    expect(document.activeElement?.textContent).toBe('Detail a');
    view.unmount();
  });

  it('keeps an author focus target usable while entering the actual detail heading', async () => {
    let authorTarget: ReturnType<typeof usePluginUiFocusTarget> | null = null;
    function Detail() {
      const target = usePluginUiFocusTarget();
      authorTarget = target;
      return <><Heading value="Entry" focusTarget={target} testID="explicit-detail-heading" /><Heading value="Activity" /></>;
    }
    const view = mount({ renderDetail: () => <Detail /> });
    view.measure(390);
    await view.setOpen('b');
    expect(document.activeElement).toBe(view.query('explicit-detail-heading'));
    act(() => { view.query('row:a')?.focus(); authorTarget?.focus(); });
    expect(document.activeElement).toBe(view.query('explicit-detail-heading'));
    view.unmount();
  });

  it('focuses the app pane heading on open and same-title replacement, without stealing focus on refresh', async () => {
    const pane = createPaneHost();
    const view = mount({ pane, presentation: 'board', detailHeader: () => ({ title: 'Entry' }) });
    view.measure(1440);
    await view.setOpen('a');
    expect(document.activeElement).toBe(view.query('host-pane-title'));
    act(() => { view.query('row:b')!.focus(); });
    await view.update({ items: [...entries] });
    expect(document.activeElement).toBe(view.query('row:b'));
    await view.setOpen('b');
    expect(document.activeElement).toBe(view.query('host-pane-title'));
    await view.setOpen(null);
    expect(document.activeElement).toBe(view.query('row:b'));
    view.unmount();
  });
  it.each(['board', 'grid'] as const)('keeps row actions and search available in %s without opening the item', (presentation) => {
    const actions: string[] = [];
    const queries: string[] = [];
    const view = mount({ presentation, detail: 'none',
      useRowActions: () => ({ secondaryActions: [{ id: 'pin', label: 'Pin' }], onSecondaryAction: id => actions.push(id) }),
      search: { label: 'Search entries', value: '', onValueChange: value => queries.push(value), testID: 'search' },
      renderPopover: input => input.content({ maxHeight: 600, requestClose: () => input.onRequestClose() }),
    });
    view.measure(1440);
    expect(view.query('search')).not.toBeNull();
    if (presentation === 'grid') expect(view.query('row:a')!.closest('[role="grid"]')).not.toBeNull();
    const input = view.query('search') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'payments');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(queries).toEqual(['payments']);
    act(() => { view.query('row:a')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    const pin = [...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Pin');
    expect(pin).toBeDefined();
    act(() => { pin!.click(); });
    expect(actions).toEqual(['pin']);
    expect(view.openChanges).toEqual([]);
    view.unmount();
  });

  it('has one board tab stop and retains the logical cursor across presentations and phone pages', async () => {
    const view = mount({ presentation: 'board', detail: 'none' });
    view.measure(1440);
    expect(['a', 'b', 'c'].filter(key => view.query(`row:${key}`)?.tabIndex === 0)).toEqual(['a']);
    act(() => { view.query('row:b')!.focus(); });
    act(() => { view.query('row:b')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(view.query('row:c'));
    act(() => { view.query('row:c')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(view.query('row:a'));
    act(() => { view.query('row:a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(view.query('row:b'));
    await view.update({ presentation: 'grid' });
    expect(view.query('row:b')!.tabIndex).toBe(0);
    await view.update({ presentation: 'list' });
    expect(view.query('row:b')!.tabIndex).toBe(0);
    await view.update({ presentation: 'board' });
    view.measure(390);
    const controls = [...view.query('collection:pager')!.querySelectorAll<HTMLElement>('[role="radio"]')];
    act(() => { controls[1]!.click(); });
    act(() => { view.query('row:c')!.focus(); });
    act(() => { controls[0]!.click(); });
    expect(view.query('row:b')!.tabIndex).toBe(0);
    expect(view.openChanges).toEqual([]);
    view.unmount();
  });
  it('merges host destination actions into the existing row context menu without losing its actions', () => {
    const selected: string[] = [];
    const view = mount({ detail: 'none',
      anatomy: { ...anatomy, destination: () => ({ destination: { pluginId: 'triage', localId: 'triage' } }) },
      useRowActions: () => ({ secondaryActions: [{ id: 'pin', label: 'Pin' }], onSecondaryAction: id => selected.push(id) }),
      renderDestinationRow: input => input.renderWithSecondaryActions?.({
        secondaryActions: [{ id: 'workspace:newTab', label: 'Open in new tab' }],
        onSecondaryAction: id => selected.push(id),
      }) ?? input.children,
      renderPopover: input => input.content({ maxHeight: 600, requestClose: () => input.onRequestClose() }),
    });
    view.measure(1440);
    act(() => { view.query('row:a')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    const menu = view.container.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('Pin');
    expect(menu?.textContent).toContain('Open in new tab');
    const open = [...menu!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Open in new tab'))!;
    act(() => { open.click(); });
    expect(selected).toEqual(['workspace:newTab']);
    act(() => { view.query('row:a')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    const pin = [...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Pin')!;
    act(() => { pin.click(); });
    expect(selected).toEqual(['workspace:newTab', 'pin']);
    expect(view.openChanges).toEqual([]);
    view.unmount();
  });
  it.each(['table', 'list', 'board', 'grid'] as const)('keeps qualified destinations and ordinary activation in %s anatomy', (presentation) => {
    const view = mount({ presentation, detail: 'none',
      anatomy: { ...anatomy,
        destination: (entry) => ({ destination: { pluginId: 'triage', localId: 'triage' }, subPath: entry.id }),
        wrapItem: (entry, children) => <View testID={`core-row:${entry.id}`}>{children}</View>,
      },
      renderDestinationRow: (input) => <View testID={`destination-row:${input.subPath}`}>{input.children}</View>,
    });
    view.measure(1440);
    expect(view.query('core-row:a')?.contains(view.query('destination-row:a'))).toBe(true);
    expect(view.query('destination-row:a')?.contains(view.query('row:a'))).toBe(true);
    act(() => view.query('row:a')!.click());
    expect(view.openChanges).toEqual(['a']);
    view.unmount();
  });
  it('draws columns by measured width, dropping the lowest priority first and never the title', () => {
    const view = mount();
    view.measure(1440);
    expect(headerTitles(view.container)).toEqual(['Entry', 'Where', "Why it's here", 'Age']);
    view.measure(700);
    // 700 leaves room for the title, the reason (priority 5) and the age (6); Where (4) goes first.
    expect(headerTitles(view.container)).toEqual(['Entry', "Why it's here", 'Age']);
    view.unmount();
  });

  it('groups rows by the one axis, with each group naming what its rows share', () => {
    const view = mount();
    view.measure(1440);
    const text = view.query('virtualizer')!.textContent ?? '';
    expect(text).toContain('Needs you');
    expect(text).toContain('You act next');
    expect(text.indexOf('Needs you')).toBeLessThan(text.indexOf('Everything else'));
    view.unmount();
  });

  it('peeks a row in place from its chevron and from space, only while it is the table', async () => {
    const view = mount();
    view.measure(1440);
    const chevron = view.query('row:a:peek')!;
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    act(() => { chevron.click(); });
    expect(view.query('peek-content:a')).not.toBeNull();
    expect(view.query('row:a:peek')!.getAttribute('aria-expanded')).toBe('true');

    const row = view.query('row:b')!;
    act(() => { row.focus(); });
    act(() => { row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })); });
    expect(view.query('peek-content:b')).not.toBeNull();
    // Space peeked rather than opened.
    expect(view.openChanges).toEqual([]);

    await view.setOpen('c');
    expect(view.query('row:a:peek')).toBeNull();
    expect(view.query('peek-content:a')).toBeNull();
    view.unmount();
  });

  it('shows the keyboard hints and the window line on a desktop table', () => {
    const view = mount();
    view.measure(1440);
    const footer = view.query('collection:footer')!;
    expect(footer.textContent).toContain('peek');
    expect(footer.textContent).toContain('3 loaded · complete');
    view.unmount();
  });
});

describe('detail auto', () => {
  it('opens a row into list + detail without remounting any row, and escape returns to the table', async () => {
    const view = mount();
    view.measure(1440);
    const before = { a: view.query('row:a'), b: view.query('row:b'), list: view.query('virtualizer') };
    expect(visible(view.query('collection-detail'))).toBe(false);

    act(() => { view.query('row:b')!.click(); });
    expect(view.openChanges).toEqual(['b']);
    await view.setOpen('b');

    expect(view.query('detail:b')).not.toBeNull();
    expect(visible(view.query('collection-detail'))).toBe(true);
    expect(visible(view.query('collection-list'))).toBe(true);
    // The same cells, not copies: table and split are one presentation with two geometries.
    expect(view.query('row:a')).toBe(before.a);
    expect(view.query('row:b')).toBe(before.b);
    expect(view.query('virtualizer')).toBe(before.list);
    // Peek exists only in the table.
    expect(view.query('row:a:peek')).toBeNull();
    expect(view.query('collection:footer')!.textContent).toContain('table');

    act(() => { view.query('row:b')!.focus(); });
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(view.openChanges).toEqual(['b', null]);
    await view.setOpen(null);
    expect(visible(view.query('collection-detail'))).toBe(false);
    expect(view.query('row:a')).toBe(before.a);
    expect(view.query('row:a:peek')).not.toBeNull();
    view.unmount();
  });

  it('pushes the detail where both panes do not fit, and never shows the table there', async () => {
    const view = mount();
    view.measure(390);
    expect(headerTitles(view.container)).toEqual([]);
    expect(view.query('row:a:peek')).toBeNull();
    expect(view.query('collection:footer')!.textContent).not.toContain('peek');
    await view.setOpen('a');
    expect(visible(view.query('collection-detail'))).toBe(true);
    expect(visible(view.query('collection-list'))).toBe(false);
    view.unmount();
  });
});

describe('detail auto beside the host details pane', () => {
  it('keeps the selected identity and its working action in the host header as selection changes', async () => {
    const pane = createPaneHost();
    const acted: string[] = [];
    const view = mount({ pane, openKey: 'a', detailHeader: (key) => ({
      title: `Entry ${key}`, subtitle: `Source ${key}`,
      actions: <Button testID="header-action" title="Open at source" onPress={() => { acted.push(key); }} />,
    }) });
    view.measure(1440);
    await view.setOpen('b');
    expect(view.query('host-pane-title')?.textContent).toBe('Entry b');
    expect(view.query('host-pane-subtitle')?.textContent).toBe('Source b');
    act(() => { view.query('header-action')!.click(); });
    expect(acted).toEqual(['b']);
    view.unmount();
  });

  it('keeps the table, narrowed and dropping columns, with the open row marked and its detail in the pane', async () => {
    const pane = createPaneHost();
    const view = mount({ pane });
    view.measure(1440);
    const wideColumns = headerTitles(view.container);
    const rows = { a: view.query('row:a'), b: view.query('row:b') };
    act(() => { view.query('row:b')!.click(); });
    await view.setOpen('b');
    expect(within(view.query('host-pane'), 'detail:b')).toBe(true);
    expect(visible(view.query('collection-detail'))).toBe(false);
    // Still the table (its column header and peeks), the same rows, and the open one marked.
    expect(headerTitles(view.container)).toEqual(wideColumns);
    expect(view.query('row:a:peek')).not.toBeNull();
    expect(view.query('row:a')).toBe(rows.a);
    const rowSelected = (key: string) => view.query(`row:${key}`)!.closest('[role="row"]')?.getAttribute('aria-selected');
    expect(rowSelected('b')).toBe('true');
    expect(rowSelected('a')).toBe('false');
    // The pane docks and the page narrows: the table drops its lowest priority columns, never the title.
    view.measure(520);
    const narrowColumns = headerTitles(view.container);
    expect(narrowColumns.length).toBeGreaterThan(0);
    expect(narrowColumns.length).toBeLessThan(wideColumns.length);
    expect(narrowColumns).toContain('Entry');
    expect(rowSelected('b')).toBe('true');

    act(() => { pane.close(); });
    await view.setOpen(null);
    expect(view.query('host-pane')).toBeNull();
    expect(document.activeElement).toBe(view.query('row:b'));
    view.unmount();
  });
});

describe('a page-sized collection (scroll page)', () => {
  const scroller = (element: HTMLElement | null): HTMLElement | null => {
    for (let node = element?.parentElement ?? null; node !== null; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return node;
    }
    return null;
  };

  it('scrolls the page header, every row and the footer in one scroller, in reading order', () => {
    const view = mount({
      presentation: 'list',
      scroll: 'page',
      detail: 'none',
      header: <Text testID="page-header">Plugins</Text>,
      footer: <Text testID="page-footer">Updates</Text>,
    });
    view.measure(1440);
    const row = view.query('row:c')!;
    const page = scroller(view.query('page-header'));
    expect(page).not.toBeNull();
    // The rows do not scroll on their own: they scroll with the page.
    expect(scroller(row)).toBe(page);
    expect(scroller(view.query('page-footer'))).toBe(page);
    // One order for reading and focus: header, rows, footer.
    const order = [view.query('page-header')!, view.query('row:a')!, row, view.query('page-footer')!];
    for (let index = 1; index < order.length; index += 1) {
      expect(order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    view.unmount();
  });

  it('offers one action per group where the caller has one, in the list and on grid shelves', () => {
    const pressed: string[] = [];
    const groupAction = (key: string) => (key === 'needs' ? { label: 'See all', onPress: () => { pressed.push(key); } } : null);
    for (const presentation of ['list', 'grid'] as const) {
      const view = mount({ presentation, scroll: 'page', detail: 'none', anatomy: described, groupAction });
      view.measure(1440);
      const action = view.query('collection:group:needs:action');
      expect(action).not.toBeNull();
      expect(view.query('collection:group:rest:action')).toBeNull();
      act(() => { action!.click(); });
      view.unmount();
    }
    expect(pressed).toEqual(['needs', 'needs']);
  });
});

describe('the table ⇄ split transition', () => {
  it('travels with the host driver, keeps the opened row anchored, and reverses from where it is', async () => {
    const motion = createManualMotion();
    const view = mount({ motion: motion.driver });
    view.measure(1440);
    await view.setOpen('b');
    expect(motion.animations.at(-1)).toMatchObject({ target: 1, durationMs: 320 });
    // Mid-flight the detail is laid over the list while it slides in; the list is still full width.
    const detail = view.query('collection-detail')!;
    expect(getComputedStyle(detail).position).toBe('absolute');
    // The opened row is anchored: it never travels. The row after it starts where the table had it.
    motion.step(0.5);
    expect(view.query('row:b:cell')!.style.transform).toMatch(/translateY\(0px\)|^$/);
    expect(view.query('row:c:cell')!.style.transform).toMatch(/translateY\(-?[1-9]/);

    // Esc mid-flight re-targets from the presentation value, over the remaining share of the close.
    await view.setOpen(null);
    const reverse = motion.animations.at(-1)!;
    expect(reverse.target).toBe(0);
    expect(reverse.from).toBe(0.5);
    expect(reverse.durationMs).toBeCloseTo(110);
    motion.finish();
    expect(visible(view.query('collection-detail'))).toBe(false);
    expect(view.query('row:a:peek')).not.toBeNull();
    view.unmount();
  });

  it('cross-fades under reduced motion: the table leaves before the split arrives, with no travel', async () => {
    const motion = createManualMotion();
    const view = mount({ motion: motion.driver, reducedMotion: true });
    view.measure(1440);
    await view.setOpen('b');
    expect(motion.animations.at(-1)).toMatchObject({ target: 0.5, durationMs: 70 });
    // Still the table while it fades out: the detail has not arrived.
    expect(visible(view.query('collection-detail'))).toBe(false);
    motion.finish();
    expect(motion.animations.at(-1)).toMatchObject({ target: 1, durationMs: 70 });
    expect(visible(view.query('collection-detail'))).toBe(true);
    expect(getComputedStyle(view.query('collection-detail')!).position).not.toBe('absolute');
    view.unmount();
  });
});

describe('the peek on open', () => {
  it('fades with the other columns and travels with its row instead of vanishing when an open starts', async () => {
    const motion = createManualMotion();
    const view = mount({ motion: motion.driver });
    view.measure(1440);
    act(() => { view.query('row:a:peek')!.click(); });
    expect(view.query('peek-content:a')).not.toBeNull();
    await view.setOpen('b');
    motion.step(0.2);
    // Mid-way through the columns' fade the peek is still on screen, fading with them.
    expect(view.query('peek-content:a')).not.toBeNull();
    const opacity = Number(getComputedStyle(view.query('row:a:peek-cell')!).opacity);
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
    motion.finish();
    expect(view.query('peek-content:a')).toBeNull();
    view.unmount();
  });
});

function within(container: HTMLElement | null, testID: string): boolean {
  return container?.querySelector(`[data-testid="${testID}"]`) != null;
}

describe('board', () => {
  it('keeps five explicit status columns reachable without empty columns taking card width', () => {
    const view = mount({ presentation: 'board', boardLayout: 'columns', detail: 'none', grouping: {
      axis: [
        { key: 'empty-a', title: 'Needs you' },
        { key: 'empty-b', title: 'Working' },
        { key: 'empty-c', title: 'Finished' },
        { key: 'needs', title: 'Idle' },
        { key: 'rest', title: 'Offline' },
      ], groupOf: entry => entry.group, retainEmpty: true,
    } });
    view.measure(980);
    const columns = ['empty-a', 'empty-b', 'empty-c', 'needs', 'rest'].map(key => view.query(`collection:column:${key}`)!);
    expect(columns.every(column => column !== null)).toBe(true);
    // Explicit columns share the available width; they must not force five 260px tracks into a 980px pane.
    expect(columns.map(column => getComputedStyle(column).width)).not.toContain('260px');
    expect(columns[0]!.textContent).toContain('None');
    expect(getComputedStyle(columns[0]!).flexGrow).toBe('0');
    expect(getComputedStyle(columns[3]!).flexGrow).toBe('1');
    expect(view.query('collection:hints')).toBeNull();
    view.unmount();
  });

  it('stretches a stacked domain card through its primary gridcell without reserving an accessory column', () => {
    const view = mount({ presentation: 'board', boardLayout: 'stacked', detail: 'none', anatomy: {
      ...anatomy, boardContent: entry => <View style={{ width: '100%' }} testID={`body:${entry.id}`}><Text>{entry.title}</Text></View>,
    } });
    view.measure(390);
    const row = view.query('row:a')!;
    const cell = row.closest<HTMLElement>('[role="gridcell"]')!;
    // The full-width card must claim the row's remaining width, rather than shrink to its intrinsic title width.
    expect(getComputedStyle(cell).flexGrow).toBe('1');
    expect(row.closest('[role="row"]')!.querySelectorAll('[role="gridcell"]')).toHaveLength(1);
    act(() => row.click());
    expect(view.openChanges).toEqual(['a']);
    view.unmount();
  });

  it('draws one labelled column per group of the one axis, each holding exactly its group\'s cards', () => {
    const view = mount({ presentation: 'board' });
    view.measure(1440);
    const needs = view.container.querySelector<HTMLElement>('[aria-label="Needs you"]');
    const rest = view.container.querySelector<HTMLElement>('[aria-label="Everything else"]');
    expect(within(needs, 'row:a') && within(needs, 'row:b') && !within(needs, 'row:c')).toBe(true);
    expect(within(rest, 'row:c') && !within(rest, 'row:a')).toBe(true);
    // Cards, not table rows: no column header, no peek.
    expect(view.container.textContent).not.toContain("Why it's here");
    expect(view.query('row:a:peek')).toBeNull();
    view.unmount();
  });

  it('opens a card into the host details pane beside the board, marks it, and replaces the content in place', async () => {
    const pane = createPaneHost();
    const view = mount({ presentation: 'board', pane });
    view.measure(1440);
    act(() => { view.query('row:b')!.click(); });
    expect(view.openChanges).toEqual(['b']);
    await view.setOpen('b');
    const hostPane = view.query('host-pane')!;
    expect(within(hostPane, 'detail:b')).toBe(true);
    // The detail lives in the pane only; the board stays on screen and usable, with the open card marked.
    expect(within(view.query('collection'), 'detail:b')).toBe(false);
    expect(visible(view.query('collection-list'))).toBe(true);
    expect(view.query('row:b')!.closest('[role="row"]')!.getAttribute('aria-selected')).toBe('true');
    await view.setOpen('a');
    expect(view.query('host-pane')).toBe(hostPane);
    expect(within(hostPane, 'detail:a')).toBe(true);
    expect(view.query('row:a')!.closest('[role="row"]')!.getAttribute('aria-selected')).toBe('true');
    view.unmount();
  });

  it('pushes the detail over the board where the host has no details pane', async () => {
    const view = mount({ presentation: 'board' });
    view.measure(1440);
    await view.setOpen('b');
    expect(view.query('detail:b')).not.toBeNull();
    expect(visible(view.query('collection-detail'))).toBe(true);
    expect(visible(view.query('collection-list'))).toBe(false);
    view.unmount();
  });

  it('closes from the pane and returns focus to the card that opened it', async () => {
    const pane = createPaneHost();
    const view = mount({ presentation: 'board', pane });
    view.measure(1440);
    act(() => { view.query('row:b')!.click(); });
    await view.setOpen('b');
    act(() => { pane.close(); });
    expect(view.openChanges).toEqual(['b', null]);
    await view.setOpen(null);
    expect(view.query('host-pane')).toBeNull();
    expect(document.activeElement).toBe(view.query('row:b'));
    view.unmount();
  });

  it('crosses columns with the arrow keys, keeping the row as near as the next column allows', () => {
    const view = mount({ presentation: 'board' });
    view.measure(1440);
    act(() => { view.query('row:b')!.focus(); });
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(view.query('row:c'));
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(view.query('row:a'));
    // Nothing opened on the way.
    expect(view.openChanges).toEqual([]);
    view.unmount();
  });

  it('pages one column at a time on a phone and pushes the detail', async () => {
    const view = mount({ presentation: 'board' });
    view.measure(390);
    const pager = view.query('collection:pager')!;
    expect(pager.textContent).toContain('Needs you');
    expect(pager.textContent).toContain('Everything else');
    expect(view.query('row:a')).not.toBeNull();
    expect(view.query('row:c')).toBeNull();
    await view.setOpen('a');
    expect(visible(view.query('collection-detail'))).toBe(true);
    expect(visible(view.query('collection-list'))).toBe(false);
    view.unmount();
  });

  it('keeps the open item and its mounted detail when the view switches from the table to the board', async () => {
    const view = mount({ openKey: 'b' });
    view.measure(1440);
    const detail = view.query('detail:b');
    expect(detail).not.toBeNull();
    await view.update({ presentation: 'board' });
    expect(view.query('detail:b')).toBe(detail);
    view.unmount();

    const pane = createPaneHost();
    const beside = mount({ openKey: 'b', pane });
    beside.measure(1440);
    const inPane = beside.query('detail:b');
    expect(within(beside.query('host-pane'), 'detail:b')).toBe(true);
    await beside.update({ presentation: 'board' });
    expect(beside.query('detail:b')).toBe(inPane);
    beside.unmount();
  });
});

const described: CollectionAnatomy<Entry> = {
  ...anatomy,
  description: (entry) => (entry.id === 'a' ? 'Retries payment intents whose idempotency key was reused by a client that timed out.' : entry.id === 'b' ? 'Short.' : null),
  action: (entry) => (
    <Text testID={`action:${entry.id}`} role="button" onPress={() => { actionPresses.push(entry.id); }}>Manage</Text>
  ),
};
const actionPresses: string[] = [];

describe('grid', () => {
  it('lays cards out in as many equal columns as the minimum card width allows, one column on a phone', () => {
    const view = mount({ presentation: 'grid', grouped: false, anatomy: described });
    view.measure(1440);
    expect(view.queryAll('collection:grid-row')[0]!.querySelectorAll('[data-testid$=":card"]').length).toBe(3);
    view.measure(390);
    const rows = view.queryAll('collection:grid-row');
    expect(rows.length).toBe(3);
    expect(rows.every((row) => row.querySelectorAll('[data-testid$=":card"]').length === 1)).toBe(true);
    view.unmount();
  });

  it('keeps every card the same height, with two description lines reserved and the footer in place', () => {
    const view = mount({ presentation: 'grid', grouped: false, anatomy: described });
    view.measure(1440);
    const heights = ['a', 'b', 'c'].map((id) => view.query(`row:${id}:card`)!.style.height);
    expect(heights[0]).not.toBe('');
    expect(new Set(heights).size).toBe(1);
    const description = view.query('row:a:description')!;
    expect(getComputedStyle(description).webkitLineClamp ?? description.style.webkitLineClamp).toBe('2');
    view.unmount();
  });

  it('makes the footer action its own target that never opens the item', () => {
    actionPresses.length = 0;
    const view = mount({ presentation: 'grid', grouped: false, anatomy: described });
    view.measure(1440);
    const action = view.query('action:a')!;
    expect(within(view.query('row:a'), 'action:a')).toBe(false);
    act(() => { action.click(); });
    expect(actionPresses).toEqual(['a']);
    expect(view.openChanges).toEqual([]);
    act(() => { view.query('row:a')!.click(); });
    expect(view.openChanges).toEqual(['a']);
    view.unmount();
  });

  it('draws shelves only when the consumer groups', () => {
    const grouped = mount({ presentation: 'grid', anatomy: described });
    grouped.measure(1440);
    expect(grouped.query('collection:shelf:needs')!.textContent).toContain('Needs you');
    expect(grouped.query('collection:shelf:needs')!.textContent).toContain('You act next');
    grouped.unmount();
    const flat = mount({ presentation: 'grid', grouped: false, anatomy: described });
    flat.measure(1440);
    expect(flat.query('collection:shelf:needs')).toBeNull();
    flat.unmount();
  });

  it('holds the grid geometry with skeleton cards while loading: the last known count, else one row', async () => {
    const view = mount({ presentation: 'grid', grouped: false, anatomy: described, items: [], loading: true });
    view.measure(1440);
    // Nothing known yet: one row of the measured column count (1440 fits 4 at the default minimum).
    expect(view.queryAll('collection:skeleton-card').length).toBe(4);
    await view.update({ items: entries, loading: false });
    expect(view.queryAll('collection:skeleton-card').length).toBe(0);
    await view.update({ items: [], loading: true });
    expect(view.queryAll('collection:skeleton-card').length).toBe(3);
    view.unmount();
  });

  it('marks the open card when the caller shows its detail elsewhere (detail none)', async () => {
    const view = mount({ presentation: 'grid', grouped: false, anatomy: described, detail: 'none', openKey: 'b' });
    view.measure(1440);
    expect(view.query('row:b:selected')).not.toBeNull();
    expect(view.query('row:a:selected')).toBeNull();
    // Nothing of the detail is drawn by the Collection itself.
    expect(view.query('detail:b')).toBeNull();
    await view.update({ presentation: 'list' });
    expect(view.query('row:b')!.closest('[role="row"]')?.getAttribute('aria-selected')).toBe('true');
    view.unmount();
  });

  it('reserves the description lines and the footer only when some card in the grid fills them', () => {
    const cardHeight = (view: ReturnType<typeof mount>) => Number.parseFloat(view.query('row:a:card')!.style.height);
    const full = mount({ presentation: 'grid', grouped: false, anatomy: described });
    full.measure(1440);
    const bare = mount({ presentation: 'grid', grouped: false, anatomy: { ...anatomy, reason: undefined } });
    bare.measure(1440);
    // No card has a description, a status or an action: the grid keeps neither slot, so its cards are shorter.
    expect(cardHeight(bare)).toBeLessThan(cardHeight(full));
    // One described card is enough for every card in the grid to keep the two lines (equal heights, aligned rows).
    const one = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: { ...anatomy, reason: undefined, description: (entry) => (entry.id === 'c' ? 'Only this one.' : null) },
    });
    one.measure(1440);
    expect(cardHeight(one)).toBeGreaterThan(cardHeight(bare));
    expect(Number.parseFloat(one.query('row:c:card')!.style.height)).toBe(cardHeight(one));
    full.unmount();
    bare.unmount();
    one.unmount();
  });

  it('draws the item itself in a preview band above every card, at one height, and never in a list', () => {
    const cardHeight = (view: ReturnType<typeof mount>) => Number.parseFloat(view.query('row:a:card')!.style.height);
    const previewed: CollectionAnatomy<Entry> = { ...anatomy, preview: (entry) => <Text>{`Preview of ${entry.id}`}</Text> };
    const plain = mount({ presentation: 'grid', grouped: false, anatomy });
    plain.measure(1440);
    const grid = mount({ presentation: 'grid', grouped: false, anatomy: previewed });
    grid.measure(1440);
    expect(grid.query('row:b:preview')?.textContent).toBe('Preview of b');
    // The band is reserved on every card, so rows stay equal and footers align.
    expect(cardHeight(grid)).toBeGreaterThan(cardHeight(plain));
    expect(Number.parseFloat(grid.query('row:c:card')!.style.height)).toBe(cardHeight(grid));
    const list = mount({ presentation: 'list', grouped: false, anatomy: previewed });
    list.measure(1440);
    expect(list.query('row:b:preview')).toBeNull();
    plain.unmount();
    grid.unmount();
    list.unmount();
  });

  it('scrolls the page header and footer with the cards, in one scroll container, as a page-sized collection', () => {
    const view = mount({
      presentation: 'grid',
      scroll: 'page',
      grouped: false,
      anatomy: described,
      header: <Text testID="page-header">Plugins</Text>,
      footer: <Text testID="page-footer">Updates</Text>,
    });
    view.measure(1440);
    const card = view.query('row:a:card')!;
    const scroller = (element: HTMLElement | null): HTMLElement | null => {
      for (let node = element?.parentElement ?? null; node !== null; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') return node;
      }
      return null;
    };
    const grid = scroller(card);
    expect(grid).not.toBeNull();
    expect(scroller(view.query('page-header'))).toBe(grid);
    expect(scroller(view.query('page-footer'))).toBe(grid);
    view.unmount();
  });

  it('opens a card into the host details pane and returns focus to it when the pane closes', async () => {
    const pane = createPaneHost();
    const view = mount({ presentation: 'grid', grouped: false, anatomy: described, pane });
    view.measure(1440);
    act(() => { view.query('row:c')!.click(); });
    await view.setOpen('c');
    expect(within(view.query('host-pane'), 'detail:c')).toBe(true);
    // Escape from the grid closes it as well.
    act(() => { view.query('row:a')!.focus(); });
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(view.openChanges).toEqual(['c', null]);
    await view.setOpen(null);
    expect(document.activeElement).toBe(view.query('row:c'));
    view.unmount();
  });
});
