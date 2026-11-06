import * as React from 'react';
import { DragSource } from './EntityDragDrop.js';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

const scrollCapture = vi.hoisted(() => ({
  offsets: [] as number[],
  observe: null as
    | null
    | ((event: { nativeEvent: { contentOffset: { y: number } } }) => void),
}));

/**
 * The platform section virtualizer, fully mounted: every header and row cell renders, keyed exactly as the
 * platform keys them, so a remount is observable as a new DOM node. Scroll requests are recorded.
 */
vi.mock('react-native', async () => {
  const native =
    await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...native,
    SectionList: function MountedSectionList(
      props: Readonly<{
        sections: readonly Readonly<{
          key: string;
          data: readonly unknown[];
        }>[];
        keyExtractor(item: unknown, index: number): string;
        renderItem(
          input: Readonly<{ item: unknown; index: number; section: unknown }>,
        ): React.ReactNode;
        renderSectionHeader?(
          input: Readonly<{ section: unknown }>,
        ): React.ReactNode;
        ListFooterComponent?: React.ReactNode;
        role?: string;
        accessibilityLabel?: string;
        ref?: React.Ref<unknown>;
        onScroll?: (event: {
          nativeEvent: { contentOffset: { y: number } };
        }) => void;
      }>,
    ) {
      scrollCapture.observe = props.onScroll ?? null;
      React.useImperativeHandle(
        props.ref,
        () => ({
          scrollToLocation() {},
          getScrollResponder: () => ({
            scrollTo: (input: Readonly<{ y: number }>) => {
              scrollCapture.offsets.push(input.y);
            },
          }),
        }),
        [],
      );
      return (
        <div
          role={props.role}
          aria-label={props.accessibilityLabel}
          data-testid="virtualizer"
        >
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

import { SURFACE_CONTEXT_THEME_FIXTURE } from '@happier-dev/plugin-sdk/testing';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
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
import {
  useHappierCollection,
  type HappierCollectionModel,
} from '../presentation/collection/useCollection.js';
import type { HappierCollectionGrouping } from '../presentation/collection/collectionModel.js';
import type { HappierLayoutChangeEvent } from '../presentation/portableTypes.js';
import {
  Collection,
  CollectionLoadingRows,
  type CollectionAnatomy,
  type CollectionProps,
} from './Collection.js';
import { CollectionToolbar } from './CollectionToolbar.js';
import { DetailsPaneFooter } from './DetailsPane.js';
import { Button } from './Button.js';
import { Heading } from './Foundation.js';
import { usePluginUiFocusTarget } from './Focus.js';
import { PageHeader } from './PageHeader.js';
import { HappierText } from '../presentation/text/Text.js';
import { HappierCollectionNavigationBackClosesDetailContext } from '../presentation/collection/collectionLayout.js';
import {
  HappierCollectionRestingRowsContext,
  useHappierCollectionTableRow,
  type HappierCollectionRestingRows,
} from '../presentation/collection/CollectionList.js';
import { createListMultiSelectionStore } from './ListMultiSelection.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';
import {
  PluginUiScrollActivityProvider,
  type PluginUiScrollActivityTracker,
} from '../presentationHost/scrollActivity.js';

type Entry = Readonly<{
  id: string;
  title: string;
  group: 'needs' | 'rest';
  repo: string;
  reason: string;
  age: string;
}>;

const entries: readonly Entry[] = [
  {
    id: 'a',
    title: 'Retry idempotent payment intents',
    group: 'needs',
    repo: 'payments-api',
    reason: 'Review requested',
    age: '18m',
  },
  {
    id: 'b',
    title: 'Move cart totals to the server',
    group: 'needs',
    repo: 'checkout-web',
    reason: 'Codex needs you',
    age: '42m',
  },
  {
    id: 'c',
    title: 'Dark mode date picker',
    group: 'rest',
    repo: 'mobile',
    reason: '',
    age: '1d',
  },
];

const anatomy: CollectionAnatomy<Entry> = {
  glyph: () => <Text>•</Text>,
  title: (entry) => entry.title,
  where: (entry) => entry.repo,
  reason: (entry) => entry.reason || null,
  age: (entry) => entry.age,
  peek: (entry) => (
    <Text testID={`peek-content:${entry.id}`}>{`About ${entry.title}`}</Text>
  ),
  accessibilityLabel: (entry) => entry.title,
  testID: (entry) => `row:${entry.id}`,
  columnTitles: {
    title: 'Entry',
    where: 'Where',
    reason: "Why it's here",
    age: 'Age',
  },
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
  const animations: Array<
    Readonly<{ target: number; durationMs: number; from: number }>
  > = [];
  let pending: ((finished: boolean) => void) | null = null;
  let current:
    | (HappierCollectionMotionValue & {
        subscribe: (listener: () => void) => () => void;
        value: number;
      })
    | null = null;
  const listeners = new Set<() => void>();
  let target = 0;
  const driver: HappierCollectionMotionDriver = {
    useValue: (initial) =>
      React.useMemo(() => {
        const value = {
          value: initial,
          get: () => value.value,
          set: (next: number) => {
            value.value = next;
            for (const listener of listeners) listener();
          },
          animateTo: (
            next: number,
            durationMs: number,
            onFinished: (finished: boolean) => void,
          ) => {
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
            return () => {
              listeners.delete(listener);
            };
          },
        };
        current = value;
        return value;
      }, []),
    AnimatedView: function ManualAnimatedView(
      props: HappierCollectionAnimatedViewProps,
    ): ReactElement {
      const value = props.value as HappierCollectionMotionValue & {
        subscribe: (listener: () => void) => () => void;
      };
      const progress = React.useSyncExternalStore(
        value.subscribe,
        value.get,
        value.get,
      );
      return (
        <View
          testID={props.testID}
          pointerEvents={props.pointerEvents}
          style={[
            props.style,
            resolveHappierCollectionTrackStyle(props.tracks, progress),
          ]}
        >
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
    step: (to: number) => {
      act(() => {
        current!.set(to);
      });
    },
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
  function Publisher(
    props: Readonly<{ input: PluginUiDetailsPanePresentation }>,
  ) {
    published = props.input;
    React.useLayoutEffect(() => {
      listeners.forEach((listener) => listener());
    });
    return null;
  }
  const binding: PluginUiDetailsPaneHost = {
    useAvailable: () => true,
    renderDetailsPane: (input) => <Publisher input={input} />,
  };
  function Slot(): ReactElement | null {
    const input = React.useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      () => published,
    );
    return input?.open ? (
      <View testID="host-pane">
        <HappierText
          accessibilityRole="header"
          ref={input.headingRef}
          tabIndex={input.headingRef ? -1 : undefined}
          testID="host-pane-title"
        >
          {input.title}
        </HappierText>
        <Text testID="host-pane-subtitle">{input.subtitle}</Text>
        {input.actions}
        {input.children}
      </View>
    ) : null;
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
  narrowGrid?: CollectionProps<Entry>['narrowGrid'];
  minCardWidth?: number;
  grouped?: boolean;
  grouping?: HappierCollectionGrouping<Entry>;
  boardLayout?: CollectionProps<Entry>['boardLayout'];
  loading?: boolean;
  loadingRows?: number;
  empty?: React.ReactNode;
  afterRows?: React.ReactNode;
  anatomy?: CollectionAnatomy<Entry>;
  header?: CollectionProps<Entry>['header'];
  footer?: React.ReactNode;
  detail?: 'auto' | 'none';
  navigationBackClosesDetail?: boolean;
  restingRows?: HappierCollectionRestingRows;
  scroll?: CollectionProps<Entry>['scroll'];
  groupAction?: (
    groupKey: string,
  ) => Readonly<{ label: string; onPress: () => void }> | null;
  collapsedGroups?: ReadonlySet<string>;
  detailHeader?: (key: string) => Readonly<{
    title: string;
    subtitle?: string;
    actions?: React.ReactNode;
  }>;
  useRowActions?: CollectionProps<Entry>['useRowActions'];
  selection?: CollectionProps<Entry>['selection'];
  modelSelection?: (
    model: HappierCollectionModel<Entry>,
  ) => CollectionProps<Entry>['selection'];
  search?: CollectionProps<Entry>['search'];
  sort?: CollectionProps<Entry>['sort'];
  renderDetail?: CollectionProps<Entry>['renderDetail'];
  title?: CollectionProps<Entry>['title'];
  listWidthPx?: number;
  onListWidthCommit?: (widthPx: number) => void;
  resizeKey?: string;
}>;

type HarnessProps = HarnessOptions &
  Readonly<{
    openKey: string | null;
    onOpenChange: (key: string | null) => void;
  }>;

function Harness(props: HarnessProps): ReactElement {
  const model = useHappierCollection({
    items: props.items ?? entries,
    keyOf,
    ...(props.grouped === false ? {} : { groups: props.grouping ?? groups }),
    openKey: props.openKey,
    onOpenChange: props.onOpenChange,
    expandable: true,
    ...(props.modelSelection === undefined
      ? {}
      : { selection: 'multiple' as const }),
  });
  return (
    <HappierCollectionRestingRowsContext.Provider value={props.restingRows ?? 'air'}>
    <HappierCollectionNavigationBackClosesDetailContext.Provider value={props.navigationBackClosesDetail === true}>
    <Collection
      model={model}
      anatomy={props.anatomy ?? anatomy}
      accessibilityLabel="PRs & Issues"
      presentation={props.presentation ?? 'table'}
      boardLayout={props.boardLayout}
      detail={props.detail ?? 'auto'}
      {...(props.useRowActions === undefined
        ? {}
        : { useRowActions: props.useRowActions })}
      {...(props.modelSelection === undefined
        ? props.selection === undefined
          ? {}
          : { selection: props.selection }
        : { selection: props.modelSelection(model) })}
      {...(props.search === undefined ? {} : { search: props.search })}
      {...(props.sort === undefined ? {} : { sort: props.sort })}
      {...(props.scroll === undefined ? {} : { scroll: props.scroll })}
      {...(props.groupAction === undefined
        ? {}
        : { groupAction: props.groupAction })}
      {...(props.collapsedGroups === undefined
        ? {}
        : { collapsedGroups: props.collapsedGroups })}
      minListWidth={240}
      minDetailWidth={400}
      preferredListRatio={0.3}
      listWidthPx={props.listWidthPx}
      onListWidthCommit={props.onListWidthCommit}
      resizeKey={props.resizeKey}
      renderDetail={
        props.renderDetail ??
        ((key) => <Text testID={`detail:${key}`}>{`Detail ${key}`}</Text>)
      }
      {...(props.detailHeader === undefined
        ? {}
        : { detailHeader: props.detailHeader })}
      windowStatement="3 loaded · complete"
      {...(props.narrowGrid === undefined ? {} : { narrowGrid: props.narrowGrid })}
      {...(props.minCardWidth === undefined ? {} : { minCardWidth: props.minCardWidth })}
      {...(props.loading === undefined ? {} : { loading: props.loading })}
      {...(props.loadingRows === undefined ? {} : { loadingRows: props.loadingRows })}
      {...(props.empty === undefined ? {} : { empty: props.empty })}
      {...(props.afterRows === undefined ? {} : { afterRows: props.afterRows })}
      {...(props.header === undefined ? {} : { header: props.header })}
      {...(props.footer === undefined ? {} : { footer: props.footer })}
      {...(props.title === undefined ? {} : { title: props.title })}
      testID="collection"
      listTestID="collection-list"
      detailTestID="collection-detail"
    />
    </HappierCollectionNavigationBackClosesDetailContext.Provider>
    </HappierCollectionRestingRowsContext.Provider>
  );
}

function mount(
  options: Readonly<{
    renderDestinationRow?: PluginUiPresentationHost['renderDestinationRow'];
    renderPopover?: PluginUiPresentationHost['renderPopover'];
    motion?: HappierCollectionMotionDriver;
    reducedMotion?: boolean;
    openKey?: string | null;
    pane?: ReturnType<typeof createPaneHost>;
    scrollTracker?: PluginUiScrollActivityTracker;
    pageChrome?: Readonly<{ showsTitle: boolean; columnMaxWidthPx?: number; renderNavigationActions?: (actions: React.ReactNode) => React.ReactNode }>;
    hostApiOverrides?: Parameters<typeof createHostApiStub>[1];
  }> &
    HarnessOptions = {},
) {
  const context = createSurfaceContext({
    reducedMotion: options.reducedMotion ?? false,
  });
  const hostApi = createHostApiStub(context, options.hostApiOverrides);
  const openChanges: Array<string | null> = [];
  const host = {
    ...presentationHost(options.motion, options.pane?.binding),
    focusTarget: (target: { focus: () => void }) => {
      target.focus();
      return true;
    },
    ...(options.renderDestinationRow === undefined
      ? {}
      : { renderDestinationRow: options.renderDestinationRow }),
    ...(options.renderPopover === undefined
      ? {}
      : { renderPopover: options.renderPopover }),
    ...(options.pageChrome === undefined
      ? {}
      : { pageChrome: options.pageChrome }),
  };
  const Slot = options.pane?.Slot ?? (() => null);
  let harness: HarnessOptions = options;
  let openKey: string | null = options.openKey ?? null;
  const wrap = () => (
    <>
      <PluginUiProviderInternal
        hostApi={hostApi}
        context={context}
        presentationHost={host}
      >
        <PluginUiScrollActivityProvider tracker={options.scrollTracker ?? null}>
          <Harness
            {...harness}
            openKey={openKey}
            onOpenChange={(key) => {
              openChanges.push(key);
            }}
          />
        </PluginUiScrollActivityProvider>
      </PluginUiProviderInternal>
      <Slot />
    </>
  );
  const mounted = mountThroughReactNativeWeb(wrap());
  const query = (testID: string) =>
    mounted.container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  return {
    container: mounted.container,
    openChanges,
    query,
    queryAll: (testID: string) => [
      ...mounted.container.querySelectorAll<HTMLElement>(
        `[data-testid="${testID}"]`,
      ),
    ],
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
      const onLayout = (
        root as unknown as {
          __reactLayoutHandler: (event: HappierLayoutChangeEvent) => void;
        }
      ).__reactLayoutHandler;
      act(() =>
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }),
      );
    },
    unmount: mounted.unmount,
  };
}

function visible(element: HTMLElement | null): boolean {
  if (element === null) return false;
  for (
    let node: HTMLElement | null = element;
    node !== null;
    node = node.parentElement
  ) {
    if (getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

function scroller(element: HTMLElement | null): HTMLElement | null {
  for (
    let node = element?.parentElement ?? null;
    node !== null;
    node = node.parentElement
  ) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
  }
  return null;
}

function headerTitles(container: HTMLElement): readonly string[] {
  const header = container.querySelector('[aria-hidden="true"]');
  return header === null
    ? []
    : [...header.querySelectorAll('[dir="auto"]')].map(
        (node) => node.textContent ?? '',
      );
}

/**
 * The pointer-events value the browser hit-tests for an element, as React Native Web draws it: an element's own
 * `none`/`auto` wins; `box-none` makes the element itself `none` and hands `auto` to its children (RNW's `>*`
 * rule, which a test DOM shows as the parent's inline value); otherwise the value inherits.
 */
function resolvedPointerEvents(element: HTMLElement): string {
  const own = (node: HTMLElement) => getComputedStyle(node).pointerEvents.replace(/\s*!important$/, '');
  const value = own(element);
  if (value === 'box-none') return 'none';
  if (value !== '' && value !== 'inherit') return value;
  const parent = element.parentElement;
  if (parent === null) return 'auto';
  return own(parent) === 'box-none' ? 'auto' : resolvedPointerEvents(parent);
}

describe('Collection table', () => {
  it("on a phone places Select beside the search's round buttons, never squeezed between the lens and the view switch", () => {
    const store = createListMultiSelectionStore({ scopeKey: 'entries', visibleOrderedKeys: [] });
    const view = mount({ search, header: toolbarHeader([]), renderPopover: openPopover, selection: { multiple: { store } } });
    view.measure(390);
    const mode = view.query('happier-list-selection-mode')!;
    expect(mode).not.toBeNull();
    // The lens row holds the lens and the arrangement switch only; Select joins Filters and ⋯ in the search row, so
    // the row that holds Select also holds the search, and that row is not the whole two-row toolbar.
    const toolbar = view.query('toolbar')!;
    let row: HTMLElement | null = mode.parentElement;
    while (row !== null && !row.contains(view.query('search'))) row = row.parentElement;
    expect(row).not.toBeNull();
    expect(row).not.toBe(toolbar);
    expect(toolbar.contains(row)).toBe(true);
    expect(row!.contains(view.query('lens'))).toBe(false);
    view.unmount();
  });

  it('resizes the split geometry while preserving its open detail and composition', () => {
    const motion = createManualMotion();
    const commit = vi.fn();
    const view = mount({ openKey: 'a', motion: motion.driver, listWidthPx: 300, onListWidthCommit: commit });
    try {
      view.measure(1000);
      const detail = view.query('detail:a');
      const handle = view.query('collection-resize-handle');
      expect(handle).not.toBeNull();
      const animations = motion.animations.length;
      act(() => handle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300 })));
      act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 })));
      act(() => window.dispatchEvent(new MouseEvent('mouseup', { clientX: 400 })));
      expect(commit).toHaveBeenLastCalledWith(400);
      expect(view.query('detail:a')).toBe(detail);
      expect(visible(view.query('collection-list'))).toBe(true);
      expect(visible(view.query('collection-detail'))).toBe(true);
      expect(view.openChanges).toEqual([]);
      expect(motion.animations).toHaveLength(animations);
    } finally { view.unmount(); }
  });
  it.each([1440, 390])(
    'windows a large single-choice catalog in the page and reveals keyboard focus at width %s',
    async (width) => {
      const listeners = new Set<() => void>();
      let window = { top: 0, bottom: 600 };
      const offsets: number[] = [];
      const tracker: PluginUiScrollActivityTracker & {
        scrollToOffset(offset: number): void;
      } = {
        onScroll() {},
        onLayout() {},
        onContentSizeChange() {},
        invalidateLayout() {},
        getLayoutRevision: () => 0,
        getWindow: () => window,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        measureSpan: async () => ({ top: 0 }),
        scrollToOffset: (offset) => {
          offsets.push(offset);
          window = { top: offset, bottom: offset + 600 };
          listeners.forEach((listener) => listener());
        },
      };
      const catalog = Array.from({ length: 240 }, (_, index): Entry => ({
        id: `size-${index}`,
        title: `Compute ${index + 1}`,
        group: 'rest',
        repo: `${index + 1} vCPU · ${2 * (index + 1)} GiB`,
        reason: '',
        age: '$0.12/h',
      }));
      const choices: string[] = [];
      const view = mount({
        items: catalog,
        grouped: false,
        detail: 'none',
        scroll: 'page-virtualized',
        scrollTracker: tracker,
        anatomy: {
          ...anatomy,
          peek: undefined,
          // A title plus the short Age column still fits at 390 without a detail pane.
          // Keep capacity as the table column and price in the list byline so this catalog recomposes.
          age: undefined,
          byline: (entry) => `${entry.repo} · ${entry.age}`,
        },
        selection: {
          single: {
            value: 'size-0',
            onValueChange: (key) => choices.push(key),
          },
        },
      });
      const otherControl = document.createElement('button');
      document.body.appendChild(otherControl);
      try {
        view.measure(width);
        await act(async () => {});
        const mountedRows = () =>
          view.container.querySelectorAll('[role="radio"]');
        expect(mountedRows().length).toBeGreaterThan(0);
        expect(mountedRows().length).toBeLessThan(catalog.length);
        expect(
          view.container.querySelectorAll('[role="radiogroup"]'),
        ).toHaveLength(1);
        expect(scroller(view.query('row:size-0'))).toBeNull();
        expect(view.query('virtualizer')).toBeNull();
        expect(view.query('row:size-239')).toBeNull();
        await act(async () => {
          view.query('row:size-0')!.focus();
          view.query('row:size-0')!.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'End',
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        expect(choices).toEqual(['size-239']);
        expect(offsets.at(-1)).toBeGreaterThan(600);
        expect(document.activeElement).toBe(view.query('row:size-239'));
        expect(mountedRows().length).toBeLessThan(catalog.length);
        await view.update({
          selection: {
            single: {
              value: 'size-239',
              onValueChange: (key) => choices.push(key),
            },
          },
        });
        expect(view.query('row:size-239')?.getAttribute('aria-checked')).toBe(
          'true',
        );
        const focusedRow = view.query('row:size-239');
        const offsetsBeforeResize = offsets.length;
        const focusedOffsetBeforeResize = offsets.at(-1);
        view.measure(width === 1440 ? 390 : 1440);
        await act(async () => {});
        expect(document.activeElement).toBe(focusedRow);
        expect(view.query('row:size-239')).toBe(focusedRow);
        // The two-line list changes the focused row's position; revealing stale table geometry must fail.
        expect(offsets.length).toBeGreaterThan(offsetsBeforeResize);
        expect(offsets.at(-1)).not.toBe(focusedOffsetBeforeResize);
        expect(choices).toEqual(['size-239']);
        expect(mountedRows().length).toBeLessThan(catalog.length);
        const offsetsBeforeLeaving = offsets.length;
        act(() => {
          otherControl.focus();
        });
        view.measure(width);
        await act(async () => {});
        expect(document.activeElement).toBe(otherControl);
        expect(offsets).toHaveLength(offsetsBeforeLeaving);
        await act(async () => {
          view.query('row:size-239')!.focus();
          view.query('row:size-239')!.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Home',
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        expect(choices).toEqual(['size-239', 'size-0']);
        expect(document.activeElement).toBe(view.query('row:size-0'));
        expect(view.openChanges).toEqual([]);
      } finally {
        otherControl.remove();
        view.unmount();
      }
    },
  );
  it('uses the incumbent collection virtualizer when page windowing has no positioned page host', () => {
    const view = mount({
      detail: 'none',
      scroll: 'page-virtualized',
      selection: { single: { value: 'a', onValueChange() {} } },
    });
    try {
      view.measure(1440);
      expect(view.query('virtualizer')).not.toBeNull();
      expect(
        view.container.querySelectorAll('[role="radiogroup"]'),
      ).toHaveLength(1);
    } finally {
      view.unmount();
    }
  });
  it.each(['board', 'grid'] as const)(
    'chooses cards in %s without opening their navigation destinations',
    async (presentation) => {
      const choices: string[] = [];
      const destinationRenders: string[] = [];
      const single = {
        value: 'a',
        onValueChange: (key: string) => choices.push(key),
        isItemSelectable: (item: Entry) => item.id !== 'b',
      };
      const view = mount({
        presentation,
        selection: { single },
        anatomy: {
          ...anatomy,
          destination: () => ({ surface: 'example', params: {} }),
        },
        renderDestinationRow: (input) => {
          destinationRenders.push(input.surface);
          return input.children;
        },
      });
      try {
        view.measure(1440);
        expect(
          view.container.querySelectorAll('[role="radiogroup"]'),
        ).toHaveLength(1);
        expect(view.query('row:c')?.getAttribute('role')).toBe('radio');
        const character = new KeyboardEvent('keydown', {
          key: 'j',
          bubbles: true,
          cancelable: true,
        });
        act(() => {
          view.query('row:a')!.focus();
          view.query('row:a')!.dispatchEvent(character);
        });
        expect(character.defaultPrevented).toBe(false);
        expect(choices).toEqual([]);
        act(() => {
          view.query('row:a')!.focus();
          view.query('row:a')!.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: presentation === 'board' ? 'ArrowRight' : 'End',
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        expect(choices).toEqual(['c']);
        expect(document.activeElement).toBe(view.query('row:c'));
        await view.update({ selection: { single: { ...single, value: 'c' } } });
        act(() => {
          view.query('row:c')!.click();
          view.query('row:b')!.click();
        });
        expect(choices).toEqual(['c']);
        act(() => {
          view.query('row:c')!.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: presentation === 'board' ? 'ArrowLeft' : 'Home',
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        expect(choices).toEqual(['c', 'a']);
        expect(view.openChanges).toEqual([]);
        expect(destinationRenders).toEqual([]);
        await view.update({ presentation: 'list' });
        view.measure(320);
        expect(view.query('row:c')?.getAttribute('aria-checked')).toBe('true');
        expect(view.query('row:a')?.getAttribute('tabindex')).toBe('0');
      } finally {
        view.unmount();
      }
    },
  );
  it('keeps controlled radio choice distinct from focus, open and responsive composition', async () => {
    const values: string[] = [];
    const focused: string[] = [];
    const single = {
      value: 'a',
      onValueChange: (key: string) => {
        values.push(key);
      },
      isItemSelectable: (item: Entry) => item.id !== 'b',
      unavailableReason: (item: Entry) =>
        item.id === 'b' ? 'Unavailable in this region' : null,
    };
    const view = mount({
      selection: { single, onFocusedKeyChange: (key) => focused.push(key) },
    });
    try {
      view.measure(1440);
      const group = view.container.querySelector('[role="radiogroup"]');
      expect(group?.getAttribute('aria-label')).toBe('PRs & Issues');
      expect(view.query('row:a')?.getAttribute('aria-checked')).toBe('true');
      expect(view.query('row:b')?.getAttribute('aria-disabled')).toBe('true');
      const reasonId = view.query('row:b')?.getAttribute('aria-describedby');
      expect(reasonId && document.getElementById(reasonId)?.textContent).toBe(
        'Unavailable in this region',
      );
      expect([
        ...view.container.querySelectorAll('[role="radio"][tabindex="0"]'),
      ]).toEqual([view.query('row:a')]);
      act(() => {
        view.query('row:a')!.focus();
        view.query('row:a')!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(values).toEqual(['c']);
      expect(document.activeElement).toBe(view.query('row:c'));
      // A controlled callback is a request: the old value stays checked until its owner responds.
      expect(view.query('row:a')?.getAttribute('aria-checked')).toBe('true');
      act(() => {
        view.query('row:c')!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: ' ',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(values).toEqual(['c', 'c']);
      await view.update({
        selection: {
          single: { ...single, value: 'c' },
          onFocusedKeyChange: (key) => focused.push(key),
        },
      });
      act(() => {
        view.query('row:c')!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: ' ',
            bubbles: true,
            cancelable: true,
          }),
        );
        view.query('row:b')!.click();
        view.query('row:a')!.click();
      });
      expect(values).toEqual(['c', 'c', 'a']);
      expect(view.openChanges).toEqual([]);
      expect(view.query('peek-content:c')).toBeNull();
      await view.update({
        selection: {
          single: { ...single, value: 'a' },
          onFocusedKeyChange: (key) => focused.push(key),
        },
      });
      const retained = view.query('row:a');
      view.measure(320);
      expect(view.query('row:a')).toBe(retained);
      expect(view.query('row:a')?.getAttribute('aria-checked')).toBe('true');
      expect([
        ...view.container.querySelectorAll('[role="radio"][tabindex="0"]'),
      ]).toEqual([view.query('row:a')]);
      expect(focused).toContain('c');
      expect(view.openChanges).toEqual([]);
      await view.update({
        selection: {
          single: {
            ...single,
            value: 'a',
            isItemSelectable: (item) => item.id === 'c',
            unavailableReason: (item) =>
              item.id === 'c' ? null : 'Unavailable in this region',
          },
        },
      });
      // A refresh may withdraw eligibility, but only the domain owner can repair its value.
      expect(view.query('row:a')?.getAttribute('aria-checked')).toBe('true');
      expect(view.query('row:a')?.getAttribute('aria-disabled')).toBe('true');
      expect([
        ...view.container.querySelectorAll('[role="radio"][tabindex="0"]'),
      ]).toEqual([view.query('row:c')]);
      expect(values).toEqual(['c', 'c', 'a']);
    } finally {
      view.unmount();
    }
  });
  it.each(['model', 'author'] as const)(
    'keeps hidden retained selections but excludes present retained rows with the %s store',
    async (owner) => {
      let store = createListMultiSelectionStore({
        scopeKey: 'entries',
        visibleOrderedKeys: [],
      });
      const selection = () => ({
        multiple: {
          store,
          isItemSelectable: (item: Entry) => item.id !== 'b',
          retainedSelectionKeys: ['b', 'hidden'],
        },
      });
      const view = mount({
        detail: 'none',
        ...(owner === 'author'
          ? { selection: selection() }
          : {
              modelSelection: (model) => {
                store = model.selectionStore!;
                return selection();
              },
            }),
      });
      try {
        view.measure(1440);
        act(() => {
          store.setSelectedKeys(['a', 'b', 'hidden']);
        });
        expect([...store.getSnapshot().selectedKeys]).toEqual(['a', 'hidden']);
        expect([...store.getSnapshot().eligibleKeys]).toEqual([
          'a',
          'c',
          'hidden',
        ]);
        await view.update({ items: [...entries] });
        expect([...store.getSnapshot().selectedKeys]).toEqual(['a', 'hidden']);
        expect(store.getSnapshot().visibleOrderedKeys).toEqual(['a', 'c']);
      } finally {
        view.unmount();
      }
    },
  );
  it('restores the list viewport after visiting a different presentation', async () => {
    const view = mount({ presentation: 'list', detail: 'none' });
    view.measure(1440);
    act(() => {
      scrollCapture.observe!({ nativeEvent: { contentOffset: { y: 231 } } });
    });
    await view.update({ presentation: 'grid' });
    const before = scrollCapture.offsets.length;
    await view.update({ presentation: 'list' });
    expect(scrollCapture.offsets.slice(before)).toContain(231);
    view.unmount();
  });
  it.each(['board', 'grid'] as const)(
    'shares the complete multi-selection inventory across %s cells and view switches',
    async (presentation) => {
      const store = createListMultiSelectionStore({
        scopeKey: 'entries',
        visibleOrderedKeys: [],
      });
      const view = mount({
        presentation,
        detail: 'none',
        selection: { multiple: { store } },
      });
      view.measure(1440);
      const mode = view.query('happier-list-selection-mode');
      expect(mode).not.toBeNull();
      expect(store.getSnapshot().visibleOrderedKeys).toEqual(['a', 'b', 'c']);
      act(() => {
        mode!.click();
        view.query('row:a')!.click();
        view.query('row:c')!.click();
      });
      expect([...store.getSnapshot().selectedKeys]).toEqual(['a', 'c']);
      expect(view.openChanges).toEqual([]);
      await view.update({ presentation: 'list' });
      expect([...store.getSnapshot().selectedKeys]).toEqual(['a', 'c']);
      act(() => {
        view.query('row:b')!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect([...store.getSnapshot().selectedKeys].sort()).toEqual([
        'a',
        'b',
        'c',
      ]);
      view.unmount();
    },
  );

  it.each(['list', 'board', 'grid'] as const)(
    'extends selection through the canonical eligible inventory in %s',
    async (presentation) => {
      const store = createListMultiSelectionStore({
        scopeKey: 'entries',
        visibleOrderedKeys: [],
      });
      const view = mount({
        presentation,
        detail: 'none',
        selection: {
          multiple: { store, isItemSelectable: (item) => item.id !== 'b' },
        },
      });
      try {
        view.measure(1440);
        await act(async () => {
          view.query('happier-list-selection-mode')!.click();
          view.query('row:a')!.click();
        });
        await act(async () => {
          view.query('row:a')!.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: presentation === 'grid' ? 'ArrowRight' : 'ArrowDown',
              shiftKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        expect([...store.getSnapshot().selectedKeys]).toEqual(['a', 'c']);
        expect(document.activeElement).toBe(view.query('row:c'));
        expect(view.openChanges).toEqual([]);
      } finally {
        view.unmount();
      }
    },
  );

  it('peeks with idle table Space and selects with X and selection-mode Space', async () => {
    const store = createListMultiSelectionStore({
      scopeKey: 'entries',
      visibleOrderedKeys: [],
    });
    const view = mount({ selection: { multiple: { store } } });
    try {
      view.measure(1440);
      await act(async () => {
        view.query('row:a')!.focus();
        view.query('row:a')!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: ' ',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect([...store.getSnapshot().selectedKeys]).toEqual([]);
      expect(view.query('peek-content:a')).not.toBeNull();
      expect(view.container.textContent).toContain('peek');
      expect(view.container.textContent).not.toContain('select');
      await act(async () => {
        view.query('row:a')!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'x',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect([...store.getSnapshot().selectedKeys]).toEqual(['a']);
      expect(view.container.textContent).toContain('select');
      await act(async () => {
        view.query('row:b')!.focus();
        view.query('row:b')!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: ' ',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect([...store.getSnapshot().selectedKeys]).toEqual(['a', 'b']);
      expect(view.query('peek-content:b')).toBeNull();
      expect(view.openChanges).toEqual([]);
    } finally {
      view.unmount();
    }
  });

  it.each(['list', 'board', 'phone'] as const)(
    'keeps Space selection without table peek in %s',
    async (mode) => {
      const store = createListMultiSelectionStore({
        scopeKey: 'entries',
        visibleOrderedKeys: [],
      });
      const view = mount({
        presentation: mode === 'phone' ? 'table' : mode,
        selection: { multiple: { store } },
      });
      try {
        view.measure(mode === 'phone' ? 390 : 1440);
        await act(async () => {
          view.query('row:a')!.focus();
          view
            .query('row:a')!
            .dispatchEvent(
              new KeyboardEvent('keydown', {
                key: ' ',
                bubbles: true,
                cancelable: true,
              }),
            );
        });
        expect([...store.getSnapshot().selectedKeys]).toEqual(['a']);
        expect(view.query('peek-content:a')).toBeNull();
      } finally {
        view.unmount();
      }
    },
  );

  it('selects a table row with no peek instead of expanding an empty body', async () => {
    const store = createListMultiSelectionStore({
      scopeKey: 'entries',
      visibleOrderedKeys: [],
    });
    const view = mount({
      anatomy: { ...anatomy, peek: () => null },
      selection: { multiple: { store } },
    });
    try {
      view.measure(1440);
      expect(view.query('collection:footer')?.textContent).toContain('select');
      expect(view.query('collection:footer')?.textContent).not.toContain(
        'peek',
      );
      await act(async () => {
        view.query('row:a')!.focus();
        view
          .query('row:a')!
          .dispatchEvent(
            new KeyboardEvent('keydown', {
              key: ' ',
              bubbles: true,
              cancelable: true,
            }),
          );
      });
      expect([...store.getSnapshot().selectedKeys]).toEqual(['a']);
      expect(view.query('row:a:peek-cell')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('keeps grid positions when a primary item is inactive', async () => {
    const view = mount({
      presentation: 'grid',
      grouped: false,
      detail: 'none',
      selection: { isItemActivatable: (item) => item.id !== 'b' },
    });
    try {
      view.measure(700);
      await act(async () => {
        view.query('row:a')!.focus();
        view.query('row:a')!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(document.activeElement).toBe(view.query('row:c'));
      expect(view.openChanges).toEqual([]);
    } finally {
      view.unmount();
    }
  });

  it('focuses the actual detail heading on a phone and on same-tree item replacement, then returns to the opener', async () => {
    const view = mount({
      renderDetail: (key) => (
        <>
          <Heading
            level={1}
            testID={`detail-heading:${key}`}
            value={`Detail ${key}`}
          />
          <Heading value="Activity" />
        </>
      ),
    });
    view.measure(390);
    act(() => {
      view.query('row:b')!.click();
    });
    await view.setOpen('b');
    expect(document.activeElement).toBe(view.query('detail-heading:b'));
    await view.setOpen('c');
    expect(document.activeElement).toBe(view.query('detail-heading:c'));
    await view.setOpen(null);
    expect(document.activeElement).toBe(view.query('row:c'));
    view.unmount();
  });

  it('focuses a public PageHeader when the detail is inline', async () => {
    const view = mount({
      renderDetail: (key) => <PageHeader title={`Detail ${key}`} />,
    });
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
      return (
        <>
          <Heading
            value="Entry"
            focusTarget={target}
            testID="explicit-detail-heading"
          />
          <Heading value="Activity" />
        </>
      );
    }
    const view = mount({ renderDetail: () => <Detail /> });
    view.measure(390);
    await view.setOpen('b');
    expect(document.activeElement).toBe(view.query('explicit-detail-heading'));
    act(() => {
      view.query('row:a')?.focus();
      authorTarget?.focus();
    });
    expect(document.activeElement).toBe(view.query('explicit-detail-heading'));
    view.unmount();
  });

  it('focuses the app pane heading on open and same-title replacement, without stealing focus on refresh', async () => {
    const pane = createPaneHost();
    const view = mount({
      pane,
      presentation: 'board',
      detailHeader: () => ({ title: 'Entry' }),
    });
    view.measure(1440);
    await view.setOpen('a');
    expect(document.activeElement).toBe(view.query('host-pane-title'));
    act(() => {
      view.query('row:b')!.focus();
    });
    await view.update({ items: [...entries] });
    expect(document.activeElement).toBe(view.query('row:b'));
    await view.setOpen('b');
    expect(document.activeElement).toBe(view.query('host-pane-title'));
    await view.setOpen(null);
    expect(document.activeElement).toBe(view.query('row:b'));
    view.unmount();
  });
  it.each(['board', 'grid'] as const)(
    'keeps row actions and search available in %s without opening the item',
    (presentation) => {
      const actions: string[] = [];
      const queries: string[] = [];
      const view = mount({
        presentation,
        detail: 'none',
        useRowActions: () => ({
          secondaryActions: [{ id: 'pin', label: 'Pin' }],
          onSecondaryAction: (id) => actions.push(id),
        }),
        search: {
          label: 'Search entries',
          value: '',
          onValueChange: (value) => queries.push(value),
          testID: 'search',
        },
        renderPopover: (input) =>
          input.content({
            maxHeight: 600,
            requestClose: () => input.onRequestClose(),
          }),
      });
      view.measure(1440);
      expect(view.query('search')).not.toBeNull();
      if (presentation === 'grid')
        expect(view.query('row:a')!.closest('[role="grid"]')).not.toBeNull();
      const input = view.query('search') as HTMLInputElement;
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(input, 'payments');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(queries).toEqual(['payments']);
      act(() => {
        view
          .query('row:a')!
          .dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
          );
      });
      const pin = [
        ...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((item) => item.textContent?.trim() === 'Pin');
      expect(pin).toBeDefined();
      act(() => {
        pin!.click();
      });
      expect(actions).toEqual(['pin']);
      expect(view.openChanges).toEqual([]);
      view.unmount();
    },
  );

  it("keeps a table row's actions out of sight on a precise pointer until the row is focused (or hovered, selected or open), and never removes them from the row", () => {
    const matchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
    const viewportWidth = Object.getOwnPropertyDescriptor(
      document.documentElement,
      'clientWidth',
    );
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1440,
    });
    window.dispatchEvent(new Event('resize'));
    (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
      matches: query.includes('hover: hover'),
    });
    let view: ReturnType<typeof mount> | undefined;
    try {
      view = mount({
        detail: 'none',
        // A separate Peek control is an always-visible accessory, not row-action chrome.
        anatomy: { ...anatomy, peek: undefined },
        useRowActions: () => ({
          secondaryActions: [{ id: 'pin', label: 'Pin' }],
          onSecondaryAction: () => undefined,
        }),
      });
      view.measure(1440);
      const row = view.query('row:a')!;
      const container = view.container;
      const opacityOf = () => {
        for (
          let node: HTMLElement | null = container.querySelector<HTMLElement>(
            '[aria-label="More actions"]',
          );
          node !== null;
          node = node.parentElement
        ) {
          const opacity = getComputedStyle(node).opacity;
          if (opacity !== '' && opacity !== '1') return opacity;
          if (node === container) break;
        }
        return '1';
      };
      // Laid out and named, but not drawn at rest.
      expect(opacityOf()).toBe('0');
      // Keyboard focus inside the row reveals them (hover is the same state, checked in the live pass).
      act(() => {
        row.focus();
      });
      expect(opacityOf()).toBe('1');
      act(() => {
        row.blur();
      });
      expect(opacityOf()).toBe('0');
    } finally {
      view?.unmount();
      (globalThis as { matchMedia?: unknown }).matchMedia = matchMedia;
      if (viewportWidth)
        Object.defineProperty(
          document.documentElement,
          'clientWidth',
          viewportWidth,
        );
      else Reflect.deleteProperty(document.documentElement, 'clientWidth');
      window.dispatchEvent(new Event('resize'));
    }
  });

  it.each(['table', 'grid'] as const)(
    'reveals %s row actions on mouse enter and hides them on leave',
    (presentation) => {
      const matchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
      const viewportWidth = Object.getOwnPropertyDescriptor(
        document.documentElement,
        'clientWidth',
      );
      Object.defineProperty(document.documentElement, 'clientWidth', {
        configurable: true,
        value: 1440,
      });
      window.dispatchEvent(new Event('resize'));
      (globalThis as { matchMedia?: unknown }).matchMedia = (
        query: string,
      ) => ({ matches: query.includes('hover: hover') });
      const view = mount({
        presentation,
        detail: 'none',
        anatomy: { ...anatomy, peek: undefined },
        useRowActions: () => ({
          secondaryActions: [{ id: 'pin', label: 'Pin' }],
          onSecondaryAction: () => undefined,
        }),
      });
      try {
        view.measure(1440);
        const row = view.query('row:a')!;
        const trigger = view.container.querySelector<HTMLElement>(
          '[aria-label="More actions"]',
        )!;
        const opacityOf = () => {
          for (
            let node: HTMLElement | null = trigger;
            node !== null && node !== view.container;
            node = node.parentElement
          ) {
            const opacity = getComputedStyle(node).opacity;
            if (opacity !== '' && opacity !== '1') return opacity;
          }
          return '1';
        };
        expect(opacityOf()).toBe('0');
        act(() => {
          row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        });
        expect(opacityOf()).toBe('1');
        act(() => {
          row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        });
        expect(opacityOf()).toBe('0');
        expect(view.container.contains(trigger)).toBe(true);
      } finally {
        view.unmount();
        (globalThis as { matchMedia?: unknown }).matchMedia = matchMedia;
        if (viewportWidth)
          Object.defineProperty(
            document.documentElement,
            'clientWidth',
            viewportWidth,
          );
        else Reflect.deleteProperty(document.documentElement, 'clientWidth');
        window.dispatchEvent(new Event('resize'));
      }
    },
  );

  it("gives a resting list's rows the full width on a precise pointer: the actions overlay the row's end, revealed by hover", () => {
    const matchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
    (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
      matches: query.includes('hover: hover'),
    });
    const actions: string[] = [];
    let view: ReturnType<typeof mount> | undefined;
    try {
      view = mount({
        detail: 'none',
        // A peek the phone list never draws must not hold a cell open at the row's end.
        anatomy,
        useRowActions: () => ({
          secondaryActions: [{ id: 'pin', label: 'Pin' }],
          onSecondaryAction: (id) => actions.push(id),
        }),
        renderPopover: (input) =>
          input.content({
            maxHeight: 600,
            requestClose: () => input.onRequestClose(),
          }),
      });
      view.measure(390);
      const row = view.query('row:a')!;
      const trigger = view.container.querySelector<HTMLElement>(
        '[aria-label="More actions"]',
      )!;
      // The row's own wrapper: the closest node holding both the row's press target and its actions.
      let item: HTMLElement = row;
      while (!item.contains(trigger)) item = item.parentElement!;
      // Out of the row's flow: the actions' outermost node beside the row's content is positioned, so no
      // column (nor a padded cell) is reserved at the row's end and the age keeps the edge.
      const ancestors: HTMLElement[] = [];
      for (
        let node = trigger.parentElement;
        node !== null && node !== item;
        node = node.parentElement
      )
        ancestors.push(node);
      expect(getComputedStyle(ancestors.at(-1)!).position).toBe('absolute');
      const opacityOf = () => {
        for (const node of [trigger, ...ancestors]) {
          const opacity = getComputedStyle(node).opacity;
          if (opacity !== '' && opacity !== '1') return opacity;
        }
        return '1';
      };
      expect(opacityOf()).toBe('0');
      act(() => {
        row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(opacityOf()).toBe('1');
      act(() => {
        row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });
      expect(opacityOf()).toBe('0');
      // Keyboard focus on the trigger itself reveals it.
      act(() => {
        trigger.focus();
      });
      expect(opacityOf()).toBe('1');
      act(() => {
        trigger.blur();
      });
      // The row's context menu still reaches every action.
      act(() => {
        row.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
      });
      const pin = [
        ...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((entry) => entry.textContent?.trim() === 'Pin');
      expect(pin).toBeDefined();
      act(() => {
        pin!.click();
      });
      expect(actions).toEqual(['pin']);
    } finally {
      view?.unmount();
      (globalThis as { matchMedia?: unknown }).matchMedia = matchMedia;
    }
  });

  it("draws a board card's actions inside the card at its title line, not beside it", () => {
    const view = mount({
      presentation: 'board',
      detail: 'none',
      useRowActions: () => ({
        secondaryActions: [{ id: 'pin', label: 'Pin' }],
        onSecondaryAction: () => undefined,
      }),
    });
    view.measure(1440);
    const trigger = view.container.querySelector<HTMLElement>(
      '[aria-label="More actions"]',
    )!;
    expect(trigger).not.toBeNull();
    // The corner cell is out of the row's flow, so it cannot widen the row past the card's edge.
    let positioned = false;
    for (
      let node: HTMLElement | null = trigger;
      node !== null && node !== view.container;
      node = node.parentElement
    ) {
      if (getComputedStyle(node).position === 'absolute') {
        positioned = true;
        break;
      }
    }
    expect(positioned).toBe(true);
    view.unmount();
  });

  it('keeps one sequential stop while the roving row reaches Peek and staged Move by shortcut and menu', async () => {
    const requests: import('@happier-dev/plugin-sdk/ui').PluginUiUpdateEntityDragDropRequestV1[] =
      [];
    let delayedPickupPhase: 'destinations' | 'begin' | null = null;
    let completePickupPhase: (() => void) | null = null;
    const view = mount({
      detail: 'auto',
      renderPopover: (input) =>
        input.open
          ? input.content({
              requestClose: input.onRequestClose,
              maxHeight: 10_000,
            })
          : null,
      hostApiOverrides: {
        watchEntityDragDrop: async () => ({ dispose() {} }),
        updateEntityDragDrop: async (request) => {
          requests.push(request);
          if (request.kind === delayedPickupPhase) {
            delayedPickupPhase = null;
            await new Promise<void>((resolve) => {
              completePickupPhase = resolve;
            });
          }
          return request.kind === 'destinations'
            ? {
                accepted: true,
                destinations: [
                  {
                    targetId: 'review',
                    label: 'Review',
                    admission: {
                      status: 'allowed',
                      effect: {
                        actionId: 'example.move',
                        input: {},
                        preview: { verb: 'Move', target: 'Review' },
                      },
                    },
                  },
                ],
              }
            : { accepted: true };
        },
      },
      anatomy: {
        ...anatomy,
        wrapItem: (entry, children) => (
          <DragSource
            sourceId="entry"
            reference={entry.id}
            organizing
            testID={`move:${entry.id}`}
          >
            {children}
          </DragSource>
        ),
      },
    });
    try {
      view.measure(1440);
      const stops = () =>
        ['a', 'b', 'c'].map((key) => ({
          key,
          row: view.query(`row:${key}`)!.tabIndex,
          peek: view.query(`row:${key}:peek`)!.tabIndex,
          move: view.query(`move:${key}`)!.tabIndex,
        }));
      const sequentialTargets = () =>
        ['a', 'b', 'c']
          .flatMap((key) => [
            ...view
              .query(`row:${key}:cell`)!
              .querySelectorAll<HTMLElement>(
                'a[href], button, input, select, textarea, [tabindex]',
              ),
          ])
          .filter(
            (element) => element.tabIndex >= 0 && !element.matches(':disabled'),
          );
      expect(sequentialTargets()).toEqual([view.query('row:a')]);
      expect(stops()).toEqual([
        { key: 'a', row: 0, peek: -1, move: -1 },
        { key: 'b', row: -1, peek: -1, move: -1 },
        { key: 'c', row: -1, peek: -1, move: -1 },
      ]);
      act(() => {
        view.query('row:b')!.focus();
      });
      expect(
        stops()
          .filter((row) => row.row === 0)
          .map((row) => row.key),
      ).toEqual(['b']);
      expect(stops().every((row) => row.peek === -1 && row.move === -1)).toBe(
        true,
      );
      expect(sequentialTargets()).toEqual([view.query('row:b')]);
      expect(view.query('row:b:peek')!.getAttribute('aria-label')).toContain(
        entries[1]!.title,
      );
      expect(view.query('move:b')!.getAttribute('aria-label')).toBe(
        'Move item',
      );
      act(() => {
        view.query('row:b:peek')!.click();
      });
      expect(view.query('peek-content:b')).not.toBeNull();
      expect(view.openChanges).toEqual([]);
      const row = view.query('row:b')!;
      const key = async (value: string, init: KeyboardEventInit = {}) => {
        await act(async () => {
          row.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: value,
              bubbles: true,
              cancelable: true,
              ...init,
            }),
          );
          row.dispatchEvent(
            new KeyboardEvent('keyup', {
              key: value,
              bubbles: true,
              cancelable: true,
              ...init,
            }),
          );
        });
      };
      await key('m', { altKey: true });
      expect(
        requests.some(
          (request) => request.kind === 'begin' && request.input === 'keyboard',
        ),
      ).toBe(true);
      await key('Enter');
      expect(
        requests.filter((request) => request.kind === 'commit'),
      ).toHaveLength(1);
      expect(view.openChanges).toEqual([]);
      await key('F10', { shiftKey: true });
      const menuItem = (name: string) =>
        [
          ...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
        ].find((item) => item.textContent?.includes(name));
      expect(menuItem('Peek')).toBeDefined();
      const move = menuItem('Move item');
      expect(move).toBeDefined();
      await act(async () => {
        move!.click();
      });
      expect(
        requests.filter((request) => request.kind === 'begin'),
      ).toHaveLength(2);
      await key('Escape');
      expect(requests.some((request) => request.kind === 'cancel')).toBe(true);
      for (const phase of ['destinations', 'begin'] as const) {
        delayedPickupPhase = phase;
        completePickupPhase = null;
        await key('m', { altKey: true });
        expect(completePickupPhase).not.toBeNull();
        await key('Enter');
        expect(view.openChanges).toEqual([]);
        await key('Escape');
        const beginsAfterCancel = requests.filter(
          (request) => request.kind === 'begin',
        ).length;
        const choicesAfterCancel = requests.filter(
          (request) => request.kind === 'choose',
        ).length;
        await act(async () => {
          (completePickupPhase as (() => void) | null)?.();
        });
        expect(
          requests.filter((request) => request.kind === 'begin'),
        ).toHaveLength(beginsAfterCancel);
        expect(
          requests.filter((request) => request.kind === 'choose'),
        ).toHaveLength(choicesAfterCancel);
      }
    } finally {
      view.unmount();
    }
  });

  it('has one board tab stop and retains the logical cursor across presentations and phone pages', async () => {
    const view = mount({ presentation: 'board', detail: 'none' });
    view.measure(1440);
    expect(
      ['a', 'b', 'c'].filter((key) => view.query(`row:${key}`)?.tabIndex === 0),
    ).toEqual(['a']);
    act(() => {
      view.query('row:b')!.focus();
    });
    act(() => {
      view.query('row:b')!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(view.query('row:c'));
    act(() => {
      view.query('row:c')!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(view.query('row:a'));
    act(() => {
      view.query('row:a')!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(view.query('row:b'));
    await view.update({ presentation: 'grid' });
    expect(view.query('row:b')!.tabIndex).toBe(0);
    await view.update({ presentation: 'list' });
    expect(view.query('row:b')!.tabIndex).toBe(0);
    await view.update({ presentation: 'board' });
    view.measure(390);
    const controls = [
      ...view
        .query('collection:pager')!
        .querySelectorAll<HTMLElement>('[role="radio"]'),
    ];
    act(() => {
      controls[1]!.click();
    });
    act(() => {
      view.query('row:c')!.focus();
    });
    act(() => {
      controls[0]!.click();
    });
    expect(view.query('row:b')!.tabIndex).toBe(0);
    expect(view.openChanges).toEqual([]);
    view.unmount();
  });
  it('merges host destination actions into the existing row context menu without losing its actions', () => {
    const selected: string[] = [];
    const view = mount({
      detail: 'none',
      anatomy: {
        ...anatomy,
        destination: () => ({
          destination: { pluginId: 'triage', localId: 'triage' },
        }),
      },
      useRowActions: () => ({
        secondaryActions: [{ id: 'pin', label: 'Pin' }],
        onSecondaryAction: (id) => selected.push(id),
      }),
      renderDestinationRow: (input) =>
        input.renderWithSecondaryActions?.({
          secondaryActions: [
            { id: 'workspace:newTab', label: 'Open in new tab' },
          ],
          onSecondaryAction: (id) => selected.push(id),
        }) ?? input.children,
      renderPopover: (input) =>
        input.content({
          maxHeight: 600,
          requestClose: () => input.onRequestClose(),
        }),
    });
    view.measure(1440);
    act(() => {
      view
        .query('row:a')!
        .dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
    });
    const menu = view.container.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('Pin');
    expect(menu?.textContent).toContain('Open in new tab');
    const open = [
      ...menu!.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes('Open in new tab'))!;
    act(() => {
      open.click();
    });
    expect(selected).toEqual(['workspace:newTab']);
    act(() => {
      view
        .query('row:a')!
        .dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
    });
    const pin = [
      ...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.trim() === 'Pin')!;
    act(() => {
      pin.click();
    });
    expect(selected).toEqual(['workspace:newTab', 'pin']);
    expect(view.openChanges).toEqual([]);
    view.unmount();
  });
  it.each(['table', 'list', 'board', 'grid'] as const)(
    'keeps qualified destinations and ordinary activation in %s anatomy',
    (presentation) => {
      const view = mount({
        presentation,
        detail: 'none',
        anatomy: {
          ...anatomy,
          destination: (entry) => ({
            destination: { pluginId: 'triage', localId: 'triage' },
            subPath: entry.id,
          }),
          wrapItem: (entry, children) => (
            <View testID={`core-row:${entry.id}`}>{children}</View>
          ),
        },
        renderDestinationRow: (input) => (
          <View testID={`destination-row:${input.subPath}`}>
            {input.children}
          </View>
        ),
      });
      view.measure(1440);
      expect(
        view.query('core-row:a')?.contains(view.query('destination-row:a')),
      ).toBe(true);
      expect(
        view.query('destination-row:a')?.contains(view.query('row:a')),
      ).toBe(true);
      act(() => view.query('row:a')!.click());
      expect(view.openChanges).toEqual(['a']);
      view.unmount();
    },
  );
  it('draws columns by measured width, dropping the lowest priority first and never the title', () => {
    const view = mount();
    view.measure(1440);
    expect(headerTitles(view.container)).toEqual([
      'Entry',
      'Where',
      "Why it's here",
      'Age',
    ]);
    view.measure(700);
    // 700 leaves room for the title, the reason (priority 5) and the age (6); Where (4) goes first.
    expect(headerTitles(view.container)).toEqual([
      'Entry',
      "Why it's here",
      'Age',
    ]);
    view.unmount();
  });

  it("lets a row's field cell stand across the following field columns, drawing nothing in them", () => {
    const view = mount({
      anatomy: {
        ...anatomy,
        where: undefined,
        reason: undefined,
        age: undefined,
        fields: [
          {
            key: 'cpu',
            title: 'CPU',
            minWidth: 120,
            priority: 1,
            render: (entry) =>
              entry.id === 'a'
                ? 'Offline · last seen yesterday 23:14'
                : `cpu ${entry.id}`,
            spanRest: (entry) => entry.id === 'a',
          },
          {
            key: 'memory',
            title: 'Memory',
            minWidth: 120,
            priority: 1,
            render: (entry) => `memory ${entry.id}`,
          },
        ],
        columnTitles: { title: 'Entry' },
      },
    });
    view.measure(1440);
    expect(headerTitles(view.container)).toEqual(['Entry', 'CPU', 'Memory']);
    const rowText = (id: string) =>
      view.query(`row:${id}`)!.closest('[role="row"]')!.textContent ?? '';
    expect(rowText('a')).toContain('Offline · last seen yesterday 23:14');
    expect(rowText('a')).not.toContain('memory a');
    expect(rowText('b')).toContain('cpu b');
    expect(rowText('b')).toContain('memory b');
    view.unmount();
  });

  it('stands a leading field right after the title and keeps Age the last column after every other field', () => {
    const view = mount({
      anatomy: {
        ...anatomy,
        reason: undefined,
        fields: [
          { key: 'progress', title: 'Progress', minWidth: 90, priority: 1, render: () => '1 of 2' },
          { key: 'status', title: 'Status', minWidth: 90, priority: 1, leading: true, render: () => 'Open' },
        ],
        columnTitles: { title: 'Task', where: 'Where', age: 'Age' },
      },
    });
    view.measure(1440);
    expect(headerTitles(view.container)).toEqual(['Task', 'Status', 'Where', 'Progress', 'Age']);
    view.unmount();
  });

  it("ends a list row's second line with its list fact, which the table leaves to its columns", () => {
    const factAnatomy: CollectionAnatomy<Entry> = {
      ...anatomy,
      reason: undefined,
      listFact: (entry) => (entry.id === 'a' ? 'Overdue' : null),
      columnTitles: { title: 'Task', where: 'Where', age: 'Age' },
    };
    const list = mount({ presentation: 'list', detail: 'none', anatomy: factAnatomy });
    list.measure(390);
    expect(list.query('row:a')?.textContent).toContain('Overdue');
    expect(list.query('row:b')?.textContent).not.toContain('Overdue');
    list.unmount();
    const table = mount({ anatomy: factAnatomy });
    table.measure(1440);
    expect(table.query('virtualizer')?.textContent).not.toContain('Overdue');
    table.unmount();
  });

  it('draws what the caller says beneath its rows, after every group and outside the rows a reader moves through', () => {
    const grouping = {
      axis: [
        { key: 'needs', title: 'Needs you' },
        { key: 'other', title: 'With an agent' },
        { key: 'rest', title: 'Everything else' },
      ],
      groupOf: (entry: Entry) => entry.group,
    };
    const view = mount({ items: entries, grouping, presentation: 'table', detail: 'none',
      empty: <Text testID="empty-state">Nothing here</Text>,
      afterRows: <Text testID="after-rows">No matches beyond these</Text> });
    view.measure(1440);
    const text = view.query('virtualizer')?.textContent ?? '';
    expect(view.query('after-rows')).not.toBeNull();
    expect(text.indexOf('No matches beyond these')).toBeGreaterThan(text.lastIndexOf(entries[entries.length - 1]!.title));
    expect(view.query('empty-state')).toBeNull();
    view.unmount();
  });

  it('groups rows by the one axis, with each group naming what its rows share', () => {
    const view = mount();
    view.measure(1440);
    const text = view.query('virtualizer')!.textContent ?? '';
    expect(text).toContain('Needs you');
    expect(text).toContain('You act next');
    expect(text.indexOf('Needs you')).toBeLessThan(
      text.indexOf('Everything else'),
    );
    view.unmount();
  });

  it('draws no band for an untitled group: the table header already names its rows', () => {
    const view = mount({
      grouping: {
        axis: [
          { key: 'needs', title: '' },
          { key: 'rest', title: 'Everything else' },
        ],
        groupOf: (entry: Entry) => entry.group,
      },
    });
    view.measure(1440);
    expect(
      view.container.querySelector('[aria-label="Everything else"]'),
    ).not.toBeNull();
    expect(view.container.querySelector('[aria-label=""]')).toBeNull();
    view.unmount();
  });

  it('offers a peek only on rows that have one, keeping the place on the others', () => {
    const view = mount({
      anatomy: {
        ...anatomy,
        peek: (entry) =>
          entry.id === 'a' ? null : (
            <Text testID={`peek-content:${entry.id}`}>{entry.title}</Text>
          ),
      },
    });
    view.measure(1440);
    expect(view.query('row:a:peek')).toBeNull();
    expect(view.query('row:b:peek')).not.toBeNull();
    view.unmount();
  });

  it('peeks a row in place from its chevron and from space, only while it is the table', async () => {
    const view = mount();
    view.measure(1440);
    const chevron = view.query('row:a:peek')!;
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      chevron.click();
    });
    expect(view.query('peek-content:a')).not.toBeNull();
    expect(view.query('row:a:peek')!.getAttribute('aria-expanded')).toBe(
      'true',
    );

    const row = view.query('row:b')!;
    act(() => {
      row.focus();
    });
    act(() => {
      row.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
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

  it('names no keys on a table that opens nothing, and keeps its window line', () => {
    const view = mount({ detail: 'none' });
    view.measure(1440);
    expect(view.query('collection:hints')).toBeNull();
    expect(view.query('collection:footer')!.textContent).toContain(
      '3 loaded · complete',
    );
    view.unmount();
  });
});

describe('detail auto', () => {
  it('opens a row into list + detail without remounting any row, and escape returns to the table', async () => {
    const view = mount();
    view.measure(1440);
    const before = {
      a: view.query('row:a'),
      b: view.query('row:b'),
      list: view.query('virtualizer'),
    };
    expect(visible(view.query('collection-detail'))).toBe(false);

    act(() => {
      view.query('row:b')!.click();
    });
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

    act(() => {
      view.query('row:b')!.focus();
    });
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
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

  it('makes a pushed detail the page: the toolbar gives way, the hosted title leads, and back returns to the list', async () => {
    const hostedSeen: boolean[] = [];
    const view = mount({
      header: <Text testID="toolbar">Clear sample reviews</Text>,
      detailHeader: (key) => ({ title: `Entry ${key}` }),
      renderDetail: (key, { headerHosted }) => {
        hostedSeen.push(headerHosted);
        return <Text testID={`detail:${key}`}>{`Detail ${key}`}</Text>;
      },
    });
    view.measure(390);
    await view.setOpen('a');
    const detail = view.query('collection-detail')!;
    expect(visible(detail)).toBe(true);
    expect(detail.contains(view.query('detail:a'))).toBe(true);
    // The page's own header (its toolbar) gives way: the detail is the page, not a block under the toolbar.
    expect(visible(view.query('toolbar'))).toBe(false);
    expect(visible(view.query('collection-list'))).toBe(false);
    // The title lives in the hosted band, so the body is told not to draw it again.
    expect(detail.querySelector('[role="heading"]')?.textContent).toBe(
      'Entry a',
    );
    expect(hostedSeen.at(-1)).toBe(true);
    act(() => {
      view.query('collection-detail:back')!.click();
    });
    expect(view.openChanges.at(-1)).toBeNull();
    await view.setOpen(null);
    expect(visible(view.query('toolbar'))).toBe(true);
    view.unmount();
  });

  it('draws no Back of its own in a pushed detail when the host\'s navigation Back already closes it', async () => {
    const view = mount({
      navigationBackClosesDetail: true,
      renderDetail: (key) => <Text testID={`detail:${key}`}>{`Detail ${key}`}</Text>,
    });
    view.measure(390);
    await view.setOpen('a');
    expect(visible(view.query('collection-detail'))).toBe(true);
    expect(view.query('detail:a')).not.toBeNull();
    expect(view.query('collection-detail:back')).toBeNull();
    view.unmount();
  });

  it('tells the detail it is pushed, and pins its primary through the one footer owner there only', async () => {
    const pushedSeen: boolean[] = [];
    const renderDetail: CollectionProps<Entry>['renderDetail'] = (
      key,
      { pushed },
    ) => {
      pushedSeen.push(pushed);
      return (
        <View style={{ flex: 1 }}>
          <Text testID={`story:${key}`}>Story</Text>
          {pushed ? (
            <DetailsPaneFooter testID="pushed-footer">
              <Text testID="primary">Fix with Claude</Text>
            </DetailsPaneFooter>
          ) : null}
        </View>
      );
    };
    // Beside the list (the in-page split) the detail is not the page: no footer.
    const split = mount({ renderDetail });
    split.measure(1440);
    await split.setOpen('a');
    expect(pushedSeen.at(-1)).toBe(false);
    expect(split.query('story:a')).not.toBeNull();
    expect(split.query('primary')).toBeNull();
    split.unmount();
    // Where the detail is the page (a phone), it pins its primary below the story in the same footer drawing.
    const phone = mount({ renderDetail });
    phone.measure(390);
    await phone.setOpen('a');
    expect(pushedSeen.at(-1)).toBe(true);
    const footer = phone.query('pushed-footer')!;
    expect(footer.contains(phone.query('primary'))).toBe(true);
    expect(
      phone.query('story:a')!.compareDocumentPosition(footer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(getComputedStyle(footer).borderTopWidth).not.toBe('0px');
    phone.unmount();
  });
});

describe('detail auto beside the host details pane', () => {
  it('keeps the selected identity and its working action in the host header as selection changes', async () => {
    const pane = createPaneHost();
    const acted: string[] = [];
    const view = mount({
      pane,
      openKey: 'a',
      detailHeader: (key) => ({
        title: `Entry ${key}`,
        subtitle: `Source ${key}`,
        actions: (
          <Button
            testID="header-action"
            title="Open at source"
            onPress={() => {
              acted.push(key);
            }}
          />
        ),
      }),
    });
    view.measure(1440);
    await view.setOpen('b');
    expect(view.query('host-pane-title')?.textContent).toBe('Entry b');
    expect(view.query('host-pane-subtitle')?.textContent).toBe('Source b');
    act(() => {
      view.query('header-action')!.click();
    });
    expect(acted).toEqual(['b']);
    view.unmount();
  });

  it('recomposes the narrowed table into the two-line list beside the pane, the same rows, the open one marked', async () => {
    const pane = createPaneHost();
    const commit = vi.fn();
    const view = mount({ pane, listWidthPx: 300, resizeKey: 'hosted-entries', onListWidthCommit: commit });
    view.measure(1440);
    const wideColumns = headerTitles(view.container);
    expect(wideColumns).toContain('Where');
    const rows = { a: view.query('row:a'), b: view.query('row:b') };
    act(() => {
      view.query('row:b')!.click();
    });
    await view.setOpen('b');
    // The pane docks and the page narrows: like the lab's Desk list beside its detail, the rows become the
    // two-line list (title over where · why) instead of a squeezed table.
    view.measure(760);
    expect(within(view.query('host-pane'), 'detail:b')).toBe(true);
    expect(visible(view.query('collection-detail'))).toBe(false);
    const hostedDetail = view.query('detail:b');
    await view.update({ listWidthPx: 900 });
    expect(view.query('detail:b')).toBe(hostedDetail);
    expect(within(view.query('host-pane'), 'detail:b')).toBe(true);
    expect(view.query('collection-resize-handle')).toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(headerTitles(view.container)).not.toContain('Where');
    // One message per state: the window's coverage is said once, in the footer, not again in the list's bar.
    const statements =
      view.container.textContent?.split('3 loaded · complete').length ?? 0;
    expect(statements - 1).toBe(1);
    expect(view.query('collection:footer')?.textContent).toContain(
      '3 loaded · complete',
    );
    expect(view.query('row:a:peek')).toBeNull();
    expect(view.query('row:a')?.textContent).toContain('payments-api');
    // The same row elements (no remount) and the open one marked.
    expect(view.query('row:a')).toBe(rows.a);
    const rowSelected = (key: string) =>
      view
        .query(`row:${key}`)!
        .closest('[role="row"]')
        ?.getAttribute('aria-selected');
    expect(rowSelected('b')).toBe('true');
    expect(rowSelected('a')).toBe('false');

    act(() => {
      pane.close();
    });
    await view.setOpen(null);
    view.measure(1440);
    expect(view.query('host-pane')).toBeNull();
    // Closed: the table again, with its columns and peeks.
    expect(headerTitles(view.container)).toEqual(wideColumns);
    expect(view.query('row:a:peek')).not.toBeNull();
    expect(document.activeElement).toBe(view.query('row:b'));
    view.unmount();
  });
});

describe('list row lines (title meta, description, status takes the facts line)', () => {
  const described: CollectionAnatomy<Entry> = {
    ...anatomy,
    peek: undefined,
    age: undefined,
    description: (entry) => `What ${entry.title} does`,
    titleMeta: (entry) => (
      <Text testID={`meta:${entry.id}`}>{`Everywhere ${entry.id}`}</Text>
    ),
    byline: (entry) => <Text testID={`facts:${entry.id}`}>{entry.repo}</Text>,
    reason: (entry) =>
      entry.reason ? (
        <Text testID={`status:${entry.id}`}>{entry.reason}</Text>
      ) : null,
    action: (entry) => <Text testID={`action:${entry.id}`}>Add</Text>,
  };

  function textOrder(row: HTMLElement, needles: readonly string[]): number[] {
    const text = row.textContent ?? '';
    return needles.map((needle) => text.indexOf(needle));
  }

  it('draws title and meta, then the description, then the facts line where a status replaces the facts', () => {
    const view = mount({ presentation: 'list', anatomy: described });
    view.measure(1440);
    const withStatus = view.query('row:a')!;
    const [title, meta, description, status] = textOrder(withStatus, [
      'Retry idempotent payment intents',
      'Everywhere a',
      'What Retry',
      'Review requested',
    ]);
    expect(title).toBeGreaterThanOrEqual(0);
    expect(meta).toBeGreaterThan(title);
    expect(description).toBeGreaterThan(meta);
    expect(status).toBeGreaterThan(description);
    // A status takes the facts line: the byline is not drawn beside it.
    expect(view.query('facts:a')).toBeNull();
    expect(view.query('status:a')).not.toBeNull();

    const quiet = view.query('row:c')!;
    const [quietDescription, facts] = textOrder(quiet, [
      'What Dark mode',
      'mobile',
    ]);
    expect(quietDescription).toBeGreaterThanOrEqual(0);
    expect(facts).toBeGreaterThan(quietDescription);
    expect(view.query('meta:c')).not.toBeNull();
    view.unmount();
  });

  it('keeps the two-line row for an anatomy without a description', () => {
    const view = mount({
      presentation: 'list',
      anatomy: { ...described, description: undefined },
    });
    view.measure(1440);
    const row = view.query('row:a')!;
    // Without a description the byline and the reason share the second line, as before.
    expect(view.query('facts:a')).not.toBeNull();
    expect(row.textContent).toContain('Review requested');
    view.unmount();
  });

  it('draws the row action at rest and leaves it to the detail beside an open item', async () => {
    const view = mount({ presentation: 'list', anatomy: described });
    view.measure(1440);
    expect(view.query('action:b')).not.toBeNull();
    await view.setOpen('b');
    expect(visible(view.query('collection-detail'))).toBe(true);
    expect(view.query('action:a')).toBeNull();
    view.unmount();
  });
});

describe('render scope', () => {
  it('draws listColumn fields as aligned end columns on a wide page-section list, named once, and leaves them to the byline on a phone', () => {
    const bylineLayouts: Array<boolean | undefined> = [];
    const columnsAnatomy: CollectionAnatomy<Entry> = {
      ...anatomy,
      byline: (entry, layout) => {
        bylineLayouts.push(layout?.fieldColumns);
        return layout?.fieldColumns === true ? entry.repo : `${entry.repo} · ${entry.age}`;
      },
      titleMeta: (entry) => <Text testID={`meta:${entry.id}`}>{entry.age}</Text>,
      titleMetaAlign: 'row',
      fields: [{ key: 'age', title: 'Age', render: (entry) => entry.age, minWidth: 64, priority: 1, align: 'end', listColumn: true }],
    };
    const view = mount({
      presentation: 'list', scroll: 'page', anatomy: columnsAnatomy,
      // Both groups are parts of one page section: one heading, one sheet, two sub-headings.
      grouping: { ...groups, axis: groups.axis.map((group) => ({ ...group, section: { key: 'all', title: 'All work' } })) },
    });
    try {
      view.measure(1200);
      expect(view.query('row:a:column:age')?.textContent).toBe('18m');
      expect(view.query('row:c:column:age')?.textContent).toBe('1d');
      // The bar names the columns once, at the top of the section's one sheet.
      expect(view.queryAll('collection:sheet-header')).toHaveLength(1);
      expect(view.query('collection:sheet-header')?.textContent).toContain('Age');
      // The row-aligned meta gives its place to the columns; the byline is told the columns say it.
      expect(view.query('meta:a')).toBeNull();
      expect(bylineLayouts.at(-1)).toBe(true);
      expect(view.query('row:a')?.textContent).not.toContain('payments-api · 18m');

      bylineLayouts.length = 0;
      view.measure(390);
      expect(view.query('row:a:column:age')).toBeNull();
      expect(view.query('collection:sheet-header')).toBeNull();
      expect(view.query('meta:a')).not.toBeNull();
      expect(bylineLayouts.at(-1)).toBe(false);
      expect(view.query('row:a')?.textContent).toContain('payments-api · 18m');
    } finally { view.unmount(); }
  });

  it.each([
    { presentation: 'table', scroll: undefined },
    { presentation: 'list', scroll: undefined },
    { presentation: 'table', scroll: 'page' },
  ] as const)('updates only the changed $presentation item when the data window publishes ($scroll)', async ({ presentation, scroll }) => {
    const renders = new Map<string, number>();
    const counting: CollectionAnatomy<Entry> = {
      ...anatomy,
      title: entry => {
        renders.set(entry.id, (renders.get(entry.id) ?? 0) + 1);
        return entry.title;
      },
    };
    const view = mount({ presentation, anatomy: counting, scroll });
    try {
      view.measure(1440);
      renders.clear();
      await view.update({ items: entries.map(entry => entry.id === 'a' ? { ...entry, title: 'Updated title' } : entry) });
      expect(view.query('row:a')?.textContent).toContain('Updated title');
      expect(renders.get('a')).toBeGreaterThan(0);
      expect(renders.get('b') ?? 0).toBe(0);
      expect(renders.get('c') ?? 0).toBe(0);
    } finally { view.unmount(); }
  });
  it.each(['table', 'list', 'board', 'grid'] as const)(
    'keeps unrelated mounted %s rows quiet when the controlled choice changes',
    async (presentation) => {
      const renders = new Map<string, number>();
      const counting: CollectionAnatomy<Entry> = {
        ...anatomy,
        title: (entry) => {
          renders.set(entry.id, (renders.get(entry.id) ?? 0) + 1);
          return entry.title;
        },
      };
      const single = { value: 'a', onValueChange: () => undefined };
      const view = mount({
        presentation,
        anatomy: counting,
        selection: { single },
      });
      try {
        view.measure(1440);
        renders.clear();
        await view.update({ selection: { single: { ...single, value: 'b' } } });
        expect(view.query('row:b')?.getAttribute('aria-checked')).toBe('true');
        expect(view.query('row:a')?.getAttribute('aria-checked')).toBe('false');
        expect(renders.get('c') ?? 0).toBe(0);
      } finally {
        view.unmount();
      }
    },
  );
  it('re-renders only the rows whose own state changed when the open item and the focus move', async () => {
    const renders = new Map<string, number>();
    const counting: CollectionAnatomy<Entry> = {
      ...anatomy,
      title: (entry) => {
        renders.set(entry.id, (renders.get(entry.id) ?? 0) + 1);
        return entry.title;
      },
    };
    const view = mount({ anatomy: counting, pane: createPaneHost() });
    view.measure(1440);
    // Opening beside the pane recomposes every row into the list (a real change for each); moving the open
    // item from there changes only the two rows involved.
    await view.setOpen('a');
    renders.clear();
    await view.setOpen('b');
    // `c` neither opened nor closed: a row that did not change must not run again (a mounted list of 30 rows
    // otherwise re-renders all 30 on every selection change and every J/K move).
    expect(renders.get('c') ?? 0).toBe(0);
    view.unmount();
  });
});

describe('render scope (cards)', () => {
  it('re-renders only the cards whose own state changed when the open item moves', async () => {
    for (const presentation of ['grid', 'board'] as const) {
      const renders = new Map<string, number>();
      const counting: CollectionAnatomy<Entry> = {
        ...anatomy,
        title: (entry) => {
          renders.set(entry.id, (renders.get(entry.id) ?? 0) + 1);
          return entry.title;
        },
      };
      const view = mount({
        presentation,
        anatomy: counting,
        pane: createPaneHost(),
      });
      view.measure(1440);
      renders.clear();
      await view.setOpen('b');
      expect({ presentation, c: renders.get('c') ?? 0 }).toEqual({
        presentation,
        c: 0,
      });
      view.unmount();
    }
  });
});

describe('board loading', () => {
  it('holds the board with skeleton rows while loading, never its empty state', async () => {
    const view = mount({
      presentation: 'board',
      items: [],
      loading: true,
      empty: <Text testID="empty-state">Nothing here</Text>,
    });
    view.measure(1440, 420);
    expect(view.queryAll('collection:skeleton-row').length).toBeGreaterThan(0);
    expect(view.query('empty-state')).toBeNull();
    await view.update({ items: [], loading: false });
    expect(view.query('empty-state')).not.toBeNull();
    view.unmount();
  });
});

describe('a phone list', () => {
  it('lets a long title take a second line instead of truncating it on the first (lab phone list)', () => {
    const view = mount();
    view.measure(360);
    const row = view.query('row:a')!;
    const title = [...row.querySelectorAll<HTMLElement>('[dir="auto"]')].find(
      (node) => node.textContent === 'Retry idempotent payment intents',
    )!;
    expect(title).toBeDefined();
    expect(
      getComputedStyle(title).webkitLineClamp ?? title.style.webkitLineClamp,
    ).toBe('2');
    view.unmount();
  });
});

describe('resting list rows', () => {
  /** Reads the row facts the Collection gives each row, so the test sees whether the row draws its hairline. */
  function RowRule(): ReactElement {
    const row = useHappierCollectionTableRow();
    return <Text testID={row?.hairline === true ? 'rule' : 'air'}>•</Text>;
  }
  const probed: CollectionAnatomy<Entry> = {
    ...anatomy,
    glyph: () => <RowRule />,
  };
  const kinds = (view: ReturnType<typeof mount>) => ({
    ruled: view.queryAll('rule').length,
    air: view.queryAll('air').length,
  });

  it('parts rows by air on a page, and by the same hairline as the list beside a detail when the host asks for ruled rows', async () => {
    const page = mount({ presentation: 'list', anatomy: probed });
    page.measure(1440);
    expect(kinds(page)).toEqual({ ruled: 0, air: entries.length });
    page.unmount();

    const ruled = mount({
      presentation: 'list',
      anatomy: probed,
      restingRows: 'ruled',
    });
    ruled.measure(1440);
    expect(kinds(ruled)).toEqual({ ruled: entries.length, air: 0 });
    // Beside an open detail the rows were already ruled: the rhythm is one, at rest and beside.
    await ruled.setOpen(entries[0]!.id);
    ruled.measure(1440);
    expect(kinds(ruled).air).toBe(0);
    ruled.unmount();
  });
});

describe('the title suffix', () => {
  it("quietly follows the title with the item's designation in the table, and leaves the list title alone", () => {
    const view = mount({
      anatomy: {
        ...anatomy,
        titleSuffix: (entry) => (entry.id === 'a' ? '#2481' : null),
      },
    });
    view.measure(1440);
    const suffix = view.query('row:a:title-suffix');
    expect(suffix?.textContent).toBe('#2481');
    expect(view.query('row:b:title-suffix')).toBeNull();
    // On a phone the list's byline carries the designation; the title stays the title.
    view.measure(360);
    expect(view.query('row:a:title-suffix')).toBeNull();
    view.unmount();
  });

});

describe('the title controls', () => {
  it("draw a row's own controls beside its press target, never inside it, in the table and the phone list", () => {
    const pressed: string[] = [];
    const view = mount({
      anatomy: {
        ...anatomy,
        titleControls: (entry) =>
          entry.id === 'a' ? (
            <Button
              testID="row:a:chip"
              title=":5173"
              onPress={() => {
                pressed.push('chip');
              }}
            />
          ) : null,
      },
    });
    for (const width of [1440, 360]) {
      view.measure(width);
      const chip = view.query('row:a:chip');
      expect(chip).not.toBeNull();
      expect(view.query('row:a')?.contains(chip)).toBe(false);
      expect(
        view.container.querySelectorAll(
          'button button, [role="button"] [role="button"]',
        ),
      ).toHaveLength(0);
      act(() => {
        chip!.click();
      });
    }
    expect(pressed).toEqual(['chip', 'chip']);
    expect(view.openChanges).toEqual([]);
    view.unmount();
  });
});

describe('the search field', () => {
  it('carries the active filters as removable tokens inside the field, and shows the key that focuses it', async () => {
    const removed: string[] = [];
    const view = mount({
      search: {
        label: 'Search entries',
        value: '',
        onValueChange: () => undefined,
        testID: 'search',
        tokens: [
          {
            key: 'view',
            qualifier: 'view',
            label: 'My work',
            onRemove: () => {
              removed.push('view');
            },
          },
          {
            key: 'state',
            qualifier: 'is',
            label: 'open',
            onRemove: () => {
              removed.push('state');
            },
          },
        ],
      },
    });
    view.measure(1440);
    const input = view.query('search')!;
    const well = input.parentElement!;
    const tokens = [...well.querySelectorAll<HTMLElement>('[role="button"]')];
    expect(tokens.map((token) => token.getAttribute('aria-label'))).toEqual([
      'Remove view My work',
      'Remove is open',
    ]);
    // Tokens sit before the text, in the field's own well.
    expect(
      tokens[1]!.compareDocumentPosition(input) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // However many tokens there are, the query keeps room to be typed and read: the tokens give way, never the
    // input (QA-F-LISTS r133: two source tokens left a 0 px input and an invisible query).
    expect(Number.parseFloat(getComputedStyle(input).minWidth)).toBeGreaterThan(0);
    await act(async () => {
      tokens[1]!.click();
    });
    expect(removed).toEqual(['state']);
    // The field's own focus shortcut, said as a key cap after the text and hidden from assistive technology.
    const hint = view.query('search:shortcut');
    expect(hint?.textContent).toBe('/');
    expect(hint?.closest('[aria-hidden="true"]')).not.toBeNull();
    view.unmount();
  });
});

describe('the search tokens on a phone', () => {
  it('says only what tells the tokens apart where the toolbar folds, keeping their full names', async () => {
    const view = mount({
      search: {
        label: 'Search entries', value: '', onValueChange: () => undefined, testID: 'search',
        tokens: [
          { key: 'a', qualifier: 'Source', label: 'acme/ledger', onRemove: () => undefined },
          { key: 'b', qualifier: 'Source', label: 'PostHog', onRemove: () => undefined },
        ],
      },
    });
    view.measure(390);
    const well = view.query('search')!.parentElement!;
    const tokens = [...well.querySelectorAll<HTMLElement>('[role="button"]')];
    expect(tokens.map((token) => token.getAttribute('aria-label'))).toEqual(['Remove Source acme/ledger', 'Remove Source PostHog']);
    expect(tokens.map((token) => token.textContent)).toEqual(['acme/ledger', 'PostHog']);
    view.unmount();
  });
});

describe('the list row anatomy', () => {
  it('renders a contributed brand mark in the glyph badge', () => {
    const view = mount({
      anatomy: {
        ...anatomy,
        glyphBadge: () => ({
          mark: () => <Text testID="agent-logo">Agent logo</Text>,
          tone: 'attention',
        }),
      },
    });
    view.measure(360);
    expect(view.query('row:a:glyph-badge')?.textContent).toContain(
      'Agent logo',
    );
    view.unmount();
  });

  it('leads the second line with the byline and badges the glyph in the list, keeping the table to its columns', () => {
    const view = mount({
      anatomy: {
        ...anatomy,
        byline: (entry) => `${entry.repo} · Mara Oduya`,
        glyphBadge: (entry) =>
          entry.id === 'b' ? { icon: 'attention', tone: 'attention' } : null,
      },
    });
    view.measure(1440);
    // The table's Where column stays the bare place; its Agent column already says what the badge would.
    expect(view.query('row:a')?.textContent).toContain('payments-api');
    expect(view.query('row:a')?.textContent).not.toContain('Mara Oduya');
    expect(view.query('row:b:glyph-badge')).toBeNull();
    view.measure(360);
    expect(view.query('row:a')?.textContent).toContain(
      'payments-api · Mara Oduya',
    );
    expect(visible(view.query('row:b:glyph-badge'))).toBe(true);
    expect(view.query('row:a:glyph-badge')).toBeNull();
    view.unmount();
  });
});

describe('a phone-width page in a pane host', () => {
  it('recomposes the table into the two-line list where the table could show nothing beside the title', () => {
    const pane = createPaneHost();
    const view = mount({ pane });
    view.measure(1440);
    expect(headerTitles(view.container)).toContain('Where');
    // 360 still clears the list minimum, but a table there is a title column alone: the list keeps what the
    // other columns said (where, why, age) on its second line instead (COLLECTION.md "Phones").
    view.measure(360);
    expect(headerTitles(view.container)).toEqual([]);
    expect(view.query('row:a:peek')).toBeNull();
    expect(view.query('row:a')?.textContent).toContain('Review requested');
    view.unmount();
  });
});

describe('a page-sized collection (scroll page)', () => {
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
    const order = [
      view.query('page-header')!,
      view.query('row:a')!,
      row,
      view.query('page-footer')!,
    ];
    for (let index = 1; index < order.length; index += 1) {
      expect(
        order[index - 1]!.compareDocumentPosition(order[index]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    view.unmount();
  });

  it('lays its rows and search in the page content column, on the edge of the page sections around it', () => {
    const view = mount({
      presentation: 'list',
      scroll: 'page',
      detail: 'none',
      pageChrome: { showsTitle: false, columnMaxWidthPx: 850 },
      header: <Text testID="page-header">Plugins</Text>,
    });
    view.measure(1440);
    // The rows' stage sits in the same centred column as the page header and the page sections, never full-bleed.
    const column = view.query('collection:stage')!.parentElement!;
    expect(getComputedStyle(column).maxWidth).toBe('850px');
    expect(getComputedStyle(column).alignSelf).toBe('center');
    view.unmount();
  });

  it('draws its search as one field: the input inside the well paints no focus ring of its own', () => {
    const view = mount({
      search: {
        label: 'Search entries',
        value: '',
        onValueChange: () => undefined,
        testID: 'search',
      },
    });
    view.measure(1440);
    const input = view.query('search')!;
    expect(input.tagName).toBe('INPUT');
    // The well is the field's one box; a browser ring on the inner input drew a second box inside it.
    expect(input.style.outlineWidth).toBe('0px');
    // Forced-colors mode restores one system ring on product inputs through this marker.
    expect(input.getAttribute('data-happier-text-input')).toBe('true');
    view.unmount();
  });

  it('offers one action per group where the caller has one, in the list and on grid shelves', () => {
    const pressed: string[] = [];
    const groupAction = (key: string) =>
      key === 'needs'
        ? {
            label: 'See all',
            onPress: () => {
              pressed.push(key);
            },
          }
        : null;
    for (const presentation of ['list', 'grid'] as const) {
      const view = mount({
        presentation,
        scroll: 'page',
        detail: 'none',
        anatomy: described,
        groupAction,
      });
      view.measure(1440);
      const action = view.query('collection:group:needs:action');
      expect(action).not.toBeNull();
      expect(view.query('collection:group:rest:action')).toBeNull();
      act(() => {
        action!.click();
      });
      view.unmount();
    }
    expect(pressed).toEqual(['needs', 'needs']);
  });
});

describe('collapsed groups', () => {
  it('draws a collapsed group as its band alone, still counting its rows, and keeps the other groups open', () => {
    const view = mount({ collapsedGroups: new Set(['rest']) });
    view.measure(1440);
    expect(view.query('row:a')).not.toBeNull();
    // The band stays, with the count of the rows it puts away; its rows are not drawn or focusable.
    expect(view.query('row:c')).toBeNull();
    const title = Array.from(document.querySelectorAll<HTMLElement>('*'))
      .find((node) => node.children.length === 0 && node.textContent === 'Everything else');
    expect(title, document.body.textContent ?? '').toBeDefined();
    expect(title!.parentElement!.textContent).toBe('Everything else1');
    view.unmount();
  });
});

describe('the table ⇄ split transition', () => {
  it('travels with the host driver, keeps the opened row anchored, and reverses from where it is', async () => {
    const motion = createManualMotion();
    const view = mount({ motion: motion.driver });
    view.measure(1440);
    await view.setOpen('b');
    expect(motion.animations.at(-1)).toMatchObject({
      target: 1,
      durationMs: 320,
    });
    // Mid-flight the detail is laid over the list while it slides in; the list is still full width.
    const detail = view.query('collection-detail')!;
    expect(getComputedStyle(detail).position).toBe('absolute');
    // The opened row is anchored: it keeps its place but for the snap that leaves the row above it whole under
    // the sticky group band (less than a row), so it travels less than the row after it, which starts where the
    // table had it.
    motion.step(0.5);
    const travel = (key: string) =>
      Math.abs(
        Number(
          /translateY\((-?[\d.]+)px\)/.exec(
            view.query(`row:${key}:cell`)!.style.transform,
          )?.[1] ?? 0,
        ),
      );
    expect(travel('a')).toBe(0);
    expect(travel('b')).toBeGreaterThan(0);
    expect(travel('c')).toBeGreaterThan(travel('b'));

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
    expect(motion.animations.at(-1)).toMatchObject({
      target: 0.5,
      durationMs: 70,
    });
    // Still the table while it fades out: the detail has not arrived.
    expect(visible(view.query('collection-detail'))).toBe(false);
    motion.finish();
    expect(motion.animations.at(-1)).toMatchObject({
      target: 1,
      durationMs: 70,
    });
    expect(visible(view.query('collection-detail'))).toBe(true);
    expect(
      getComputedStyle(view.query('collection-detail')!).position,
    ).not.toBe('absolute');
    view.unmount();
  });
});

describe('the peek on open', () => {
  it('fades with the other columns and travels with its row instead of vanishing when an open starts', async () => {
    const motion = createManualMotion();
    const view = mount({ motion: motion.driver });
    view.measure(1440);
    act(() => {
      view.query('row:a:peek')!.click();
    });
    expect(view.query('peek-content:a')).not.toBeNull();
    await view.setOpen('b');
    motion.step(0.2);
    // Mid-way through the columns' fade the peek is still on screen, fading with them.
    expect(view.query('peek-content:a')).not.toBeNull();
    const opacity = Number(
      getComputedStyle(view.query('row:a:peek-cell')!).opacity,
    );
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
  it('lets wrapItem stand an item in place of its card, so its own controls stay live (a Board widget)', () => {
    const view = mount({ presentation: 'board', anatomy: {
      ...anatomy,
      wrapItem: (entry, card) => (entry.id === 'a' ? <Text testID="own:a">Own surface</Text> : card),
    } });
    view.measure(1440);
    expect(view.query('own:a')).not.toBeNull();
    expect(view.query('row:a:chrome')).toBeNull();
    expect(view.query('row:b:chrome')).not.toBeNull();
    view.unmount();
  });

  it.each(['board', 'grid'] as const)('keeps bounded %s body and header controls outside card-open through resize', async (presentation) => {
    let mounts = 0;
    let effects = 0;
    function Body() {
      const [value, setValue] = React.useState('draft');
      React.useEffect(() => { mounts += 1; }, []);
      return <View>
        <input data-testid="bounded-input" defaultValue={value} />
        <Button testID="bounded-body-control" title="Edit" onPress={() => { effects += 1; setValue('edited'); }} />
        <Text testID="bounded-value">{value}</Text>
      </View>;
    }
    const bounded: CollectionAnatomy<Entry> = {
      ...anatomy,
      card: {
        headerRight: (entry) => entry.id === 'a' ? <Button testID="bounded-header-control" title="Run" onPress={() => { effects += 1; }} /> : null,
        facts: (entry) => <Text testID={`bounded-facts:${entry.id}`}>{entry.repo}</Text>,
        body: { render: (entry) => entry.id === 'b' ? <Body /> : null },
      },
    };
    const view = mount({ presentation, grouped: false, anatomy: bounded });
    try {
      view.measure(1440);
      const input = view.query('bounded-input') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(view.query('bounded-facts:a')?.textContent).toBe('payments-api');
      const target = view.query('row:a')!;
      expect(view.query('row:b')!.contains(view.query('bounded-body-control'))).toBe(false);
      expect(target.contains(view.query('bounded-header-control'))).toBe(false);
      act(() => { view.query('bounded-header-control')!.click(); view.query('bounded-body-control')!.click(); });
      expect(effects).toBe(2);
      expect(view.openChanges).toEqual([]);
      expect(view.query('bounded-value')?.textContent).toBe('edited');
      act(() => { input!.focus(); });
      view.measure(390);
      expect(view.query('bounded-input')).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(mounts).toBe(1);
      act(() => { target.click(); });
      expect(view.openChanges).toEqual(['a']);
    } finally { view.unmount(); }
  });

  it('keeps five status columns on stable tracks with empty buckets still reachable', () => {
    const view = mount({
      presentation: 'board',
      boardLayout: 'columns',
      detail: 'none',
      grouping: {
        axis: [
          { key: 'empty-a', title: 'Needs you' },
          { key: 'empty-b', title: 'Working' },
          { key: 'empty-c', title: 'Finished' },
          { key: 'needs', title: 'Idle' },
          { key: 'rest', title: 'Offline' },
        ],
        groupOf: (entry) => entry.group,
        retainEmpty: true,
      },
    });
    view.measure(980);
    const columns = ['empty-a', 'empty-b', 'empty-c', 'needs', 'rest'].map(
      (key) => view.query(`collection:column:${key}`)!,
    );
    expect(columns.every((column) => column !== null)).toBe(true);
    const widths = columns.map((column) =>
      Number.parseFloat(getComputedStyle(column).width),
    );
    expect(new Set(widths).size).toBe(1);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(
      980,
    );
    // An empty column says so by its count alone: no second "None" line under "Needs you 0".
    expect(columns[0]!.textContent).not.toContain('None');
    expect(columns[0]!.querySelector('[data-testid^="row:"]')).toBeNull();
    expect(view.query('collection:hints')).toBeNull();
    view.measure(600);
    const narrowWidths = columns.map((column) =>
      Number.parseFloat(getComputedStyle(column).width),
    );
    expect(new Set(narrowWidths).size).toBe(1);
    expect(narrowWidths.reduce((sum, width) => sum + width, 0)).toBeGreaterThan(
      600,
    );
    view.unmount();
  });

  it("keeps a board's card track at the caller's narrowest card and brings the open card's column into view", async () => {
    const pane = createPaneHost();
    const items: readonly Entry[] = [
      { id: 'a', title: 'Retry idempotent payment intents', group: 'needs', repo: 'payments-api', reason: 'Review requested', age: '18m' },
      { id: 'z', title: 'Rotate staging service principals', group: 'rest', repo: 'ops', reason: '', age: '2d' },
    ];
    const view = mount({
      presentation: 'board',
      boardLayout: 'columns',
      pane,
      items,
      minCardWidth: 280,
      grouping: {
        axis: [
          { key: 'needs', title: 'Needs you' },
          { key: 'agent', title: 'With an agent' },
          { key: 'review', title: 'In review' },
          { key: 'rest', title: 'Everything else' },
        ],
        groupOf: (entry) => entry.group,
        retainEmpty: true,
      },
    });
    try {
      view.measure(1400);
      const widthOf = (key: string) => Number.parseFloat(getComputedStyle(view.query(`collection:column:${key}`)!).width);
      // Wide enough: the four columns share the width, each at least the card plus its insets.
      expect(widthOf('needs')).toBeGreaterThanOrEqual(280);
      // Narrower than four cards: the board keeps its card track rather than squeezing its columns to fit.
      view.measure(700);
      expect(widthOf('needs')).toBeGreaterThanOrEqual(280);
      const column = view.query('collection:column:rest')!;
      // The horizontal scroller is the DOM boundary: record where it is asked to scroll to.
      const scrolls: Array<Readonly<{ node: Element; left: number }>> = [];
      const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scroll');
      Object.defineProperty(Element.prototype, 'scroll', { configurable: true, writable: true,
        value(this: Element, options?: ScrollToOptions) { scrolls.push({ node: this, left: options?.left ?? 0 }); } });
      try {
        // Opening a card in the last column, off screen, scrolls its column into view.
        await view.setOpen('z');
        expect(view.query('host-pane')).not.toBeNull();
      } finally {
        if (original === undefined) delete (Element.prototype as { scroll?: unknown }).scroll;
        else Object.defineProperty(Element.prototype, 'scroll', original);
      }
      const reveal = scrolls.filter((call) => call.node.contains(column) && call.left > 0).at(-1);
      expect(reveal).toBeDefined();
      const columnEnd = ([...column.parentElement!.children].indexOf(column) + 1) * widthOf('rest');
      expect(reveal!.left + 700).toBeGreaterThanOrEqual(columnEnd);
    } finally { view.unmount(); }
  });

  it("puts a board card's state word on its facts line even beside its own control, so the title keeps the width", () => {
    const view = mount({
      presentation: 'board',
      boardLayout: 'columns',
      detail: 'none',
      anatomy: {
        ...anatomy,
        card: { headerRight: (entry) => <Text testID={`control:${entry.id}`}>⋯</Text> },
      },
    });
    try {
      view.measure(1200);
      const card = view.query('row:a:chrome')!;
      const header = view.query('row:a:chrome.header')!;
      expect(header.querySelector('[data-testid="control:a"]')).not.toBeNull();
      // Not in the header beside the title: under it, on the card's facts line.
      expect(header.textContent).not.toContain('Review requested');
      expect(card.textContent).toContain('Review requested');
    } finally { view.unmount(); }
  });

  it("says a board card's designation once, in its byline, not again after the title", () => {
    const view = mount({
      presentation: 'board',
      boardLayout: 'columns',
      detail: 'none',
      anatomy: {
        ...anatomy,
        titleSuffix: () => '#2481',
        byline: (entry) => `${entry.repo} #2481`,
      },
    });
    try {
      view.measure(1200);
      const column = view.query('collection:column:needs')!;
      expect(column.textContent).toContain('payments-api #2481');
      expect(column.textContent).toContain('Retry idempotent payment intents');
      // Two cards in the column, each saying the designation once.
      expect(column.textContent!.split('#2481')).toHaveLength(3);
    } finally { view.unmount(); }
  });

  it('stretches a stacked domain card through its primary gridcell without reserving an accessory column', () => {
    const view = mount({
      presentation: 'board',
      boardLayout: 'stacked',
      detail: 'none',
      anatomy: {
        ...anatomy,
        card: { body: { render: (entry) => (
          <View style={{ width: '100%' }} testID={`body:${entry.id}`}>
            <Text>{entry.title}</Text>
          </View>
        ) } },
      },
    });
    view.measure(390);
    const row = view.query('row:a')!;
    const cell = row.closest<HTMLElement>('[role="gridcell"]')!;
    // The full-width card must claim the row's remaining width, rather than shrink to its intrinsic title width.
    expect(getComputedStyle(cell).flexGrow).toBe('1');
    expect(
      row.closest('[role="row"]')!.querySelectorAll('[role="gridcell"]'),
    ).toHaveLength(1);
    act(() => row.click());
    expect(view.openChanges).toEqual(['a']);
    view.unmount();
  });

  it("keeps a domain card's action a sibling of its open target inside the card frame, never a button inside a button", () => {
    const pressed: string[] = [];
    const view = mount({
      presentation: 'board',
      boardLayout: 'columns',
      detail: 'none',
      anatomy: {
        ...anatomy,
        card: { body: { render: (entry) => (
          <View testID={`body:${entry.id}`}>
            <Text>{entry.title}</Text>
          </View>
        ) } },
        wrapItem: (entry, card) => (
          <View testID={`frame:${entry.id}`}>{card}</View>
        ),
        action: (entry) =>
          entry.id === 'a' ? (
            <Button
              testID="action:a"
              title="Run now"
              onPress={() => {
                pressed.push(entry.id);
              }}
            />
          ) : null,
      },
    });
    view.measure(1440);
    expect(
      view.container.querySelectorAll(
        'button button, [role="button"] [role="button"], [role="button"] button, button [role="button"]',
      ),
    ).toHaveLength(0);
    const action = view.query('action:a')!;
    const target = view.query('row:a')!;
    // One card: the frame holds the open target and the action, which stay separate press and focus targets.
    expect(
      view.query('frame:a')!.contains(target) &&
        view.query('frame:a')!.contains(action),
    ).toBe(true);
    expect(target.contains(action)).toBe(false);
    act(() => action.click());
    expect(pressed).toEqual(['a']);
    expect(view.openChanges).toEqual([]);
    act(() => target.click());
    expect(view.openChanges).toEqual(['a']);
    view.unmount();
  });

  it.each(['board', 'grid'] as const)(
    "lets a pointer on a %s card's title, description, body and facts reach the card's open target",
    (presentation) => {
      const view = mount({
        presentation,
        detail: 'none',
        anatomy: {
          ...anatomy,
          titleSuffix: (entry) => entry.repo,
          description: (entry) => `About ${entry.title}`,
          card: {
            facts: (entry) => <Text testID={`facts:${entry.id}`}>{entry.age}</Text>,
            body: { render: (entry) => (
              <View testID={`body:${entry.id}`}>
                <Text testID={`body-text:${entry.id}`}>{entry.title}</Text>
              </View>
            ) },
          },
        },
      });
      view.measure(1440);
      const target = view.query('row:a')!;
      const card = view.query('row:a:chrome')!;
      const title = [...card.querySelectorAll<HTMLElement>('[dir="auto"]')].find((node) => node.textContent === entries[0]!.title)!;
      const description = [...card.querySelectorAll<HTMLElement>('[dir="auto"]')].find((node) => node.textContent === `About ${entries[0]!.title}`)!;
      // Every part of a card that is not a control lets the pointer through to the open target beneath it, as
      // the browser resolves pointer-events (a `box-none` wrapper re-enables its children).
      for (const leaf of [title, description, view.query('body-text:a')!, view.query('facts:a')!]) {
        expect(resolvedPointerEvents(leaf)).toBe('none');
      }
      // So does every box the frame draws them in: a card without controls takes no pointer hit of its own.
      // (An empty control slot draws nothing to hit.)
      const hitTargets = [card, ...card.querySelectorAll<HTMLElement>('*')]
        .filter((node) => node.childNodes.length > 0 && resolvedPointerEvents(node) !== 'none');
      expect(hitTargets.map((node) => node.dataset.testid ?? node.tagName)).toEqual([]);
      expect(target.contains(card)).toBe(false);
      act(() => target.click());
      expect(view.openChanges).toEqual(['a']);
      view.unmount();
    },
  );

  it("draws one labelled column per group of the one axis, each holding exactly its group's cards", () => {
    const view = mount({ presentation: 'board' });
    view.measure(1440);
    const needs = view.container.querySelector<HTMLElement>(
      '[aria-label="Needs you"]',
    );
    const rest = view.container.querySelector<HTMLElement>(
      '[aria-label="Everything else"]',
    );
    expect(
      within(needs, 'row:a') &&
        within(needs, 'row:b') &&
        !within(needs, 'row:c'),
    ).toBe(true);
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
    act(() => {
      view.query('row:b')!.click();
    });
    expect(view.openChanges).toEqual(['b']);
    await view.setOpen('b');
    const hostPane = view.query('host-pane')!;
    expect(within(hostPane, 'detail:b')).toBe(true);
    // The detail lives in the pane only; the board stays on screen and usable, with the open card marked.
    expect(within(view.query('collection'), 'detail:b')).toBe(false);
    expect(visible(view.query('collection-list'))).toBe(true);
    expect(
      view
        .query('row:b')!
        .closest('[role="row"]')!
        .getAttribute('aria-selected'),
    ).toBe('true');
    await view.setOpen('a');
    expect(view.query('host-pane')).toBe(hostPane);
    expect(within(hostPane, 'detail:a')).toBe(true);
    expect(
      view
        .query('row:a')!
        .closest('[role="row"]')!
        .getAttribute('aria-selected'),
    ).toBe('true');
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
    act(() => {
      view.query('row:b')!.click();
    });
    await view.setOpen('b');
    act(() => {
      pane.close();
    });
    expect(view.openChanges).toEqual(['b', null]);
    await view.setOpen(null);
    expect(view.query('host-pane')).toBeNull();
    expect(document.activeElement).toBe(view.query('row:b'));
    view.unmount();
  });

  it('crosses columns with the arrow keys, keeping the row as near as the next column allows', () => {
    const view = mount({ presentation: 'board' });
    view.measure(1440);
    act(() => {
      view.query('row:b')!.focus();
    });
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(view.query('row:c'));
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          bubbles: true,
          cancelable: true,
        }),
      );
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

  it('lands on the first populated phone column when rows arrive after loading', async () => {
    const view = mount({
      presentation: 'board',
      items: [],
      loading: true,
      grouping: { ...groups, retainEmpty: true },
    });
    view.measure(390);
    await view.update({
      items: entries.filter((entry) => entry.group === 'rest'),
      loading: false,
    });
    expect(view.query('row:c')).not.toBeNull();
    expect(
      view.query('collection:pager')!.querySelector('[aria-checked="true"]')
        ?.textContent,
    ).toContain('Everything else');
    view.unmount();
  });

  it('keeps an explicitly chosen empty phone column through data and presentation changes', async () => {
    const view = mount({
      presentation: 'board',
      items: entries.filter((entry) => entry.group === 'rest'),
      grouping: { ...groups, retainEmpty: true },
    });
    view.measure(390);
    expect(view.query('row:c')).not.toBeNull();
    act(() => {
      (
        view
          .query('collection:pager')!
          .querySelector('[role="radio"]') as HTMLElement
      ).click();
    });
    expect(view.query('row:c')).toBeNull();
    await view.update({ presentation: 'table' });
    await view.update({
      presentation: 'board',
      items: [...entries.filter((entry) => entry.group === 'rest')],
    });
    expect(view.query('row:c')).toBeNull();
    expect(
      view.query('collection:pager')!.querySelector('[aria-checked="true"]')
        ?.textContent,
    ).toContain('Needs you');
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
  description: (entry) =>
    entry.id === 'a'
      ? 'Retries payment intents whose idempotency key was reused by a client that timed out.'
      : entry.id === 'b'
        ? 'Short.'
        : null,
  action: (entry) => (
    <Text
      testID={`action:${entry.id}`}
      role="button"
      onPress={() => {
        actionPresses.push(entry.id);
      }}
    >
      Manage
    </Text>
  ),
};
const actionPresses: string[] = [];

describe('grid', () => {
  it('lays cards out in as many equal columns as the minimum card width allows, one column on a phone', () => {
    const view = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: described,
    });
    view.measure(1440);
    const card = view.query('row:b:card')!;
    const parent = card.parentElement;
    const wideWidth = Number.parseFloat(card.style.width);
    view.measure(390);
    expect(view.query('row:b:card')).toBe(card);
    expect(card.parentElement).toBe(parent);
    expect(Number.parseFloat(card.style.width)).toBeGreaterThan(wideWidth);
    expect(new Set(['a', 'b', 'c'].map(id => view.query(`row:${id}:card`)!.style.width)).size).toBe(1);
    view.unmount();
  });

  it('pages a one-column grid sideways as one row of cards with the next card showing, and walks it with ← →', async () => {
    const view = mount({ presentation: 'grid', grouped: false, detail: 'none', anatomy: described, narrowGrid: 'page' });
    try {
      view.measure(1440);
      const wideRow = view.query('row:a:card')!.parentElement;
      expect(view.query('row:b:card')!.parentElement).toBe(wideRow);
      view.measure(390);
      const width = (id: string) => Number.parseFloat(view.query(`row:${id}:card`)!.style.width);
      // One row of equal cards, each narrower than the grid, so the next card's edge shows beside it.
      expect(new Set(['a', 'b', 'c'].map(width)).size).toBe(1);
      expect(width('a')).toBeLessThan(390 - 2 * 16 - 12);
      await act(async () => {
        view.query('row:a')!.focus();
        view.query('row:a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(view.query('row:b'));
    } finally {
      view.unmount();
    }
  });

  it('sizes a one-column grid card to its content instead of reserving two description lines', () => {
    const view = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: described,
    });
    view.measure(390);
    // One card per row has no row peers to align with: its height follows its content.
    expect(view.query('row:a:card')!.style.minHeight).toBe('');
    view.measure(1440);
    expect(view.query('row:a:card')!.style.minHeight).not.toBe('');
    view.unmount();
  });

  it('omits empty description, body and facts bands from a title-only tile', () => {
    const view = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: { ...anatomy, where: undefined, reason: undefined, age: undefined },
    });
    view.measure(1440);
    expect(view.query('row:a:description')).toBeNull();
    expect(view.query('row:a:chrome.body')).toBeNull();
    expect(view.query('row:a:chrome.footer')).toBeNull();
    view.unmount();
  });

  it('starts a new row where described cards give way to compact tiles, and moves vertically by those rows', async () => {
    const view = mount({
      presentation: 'grid',
      grouped: false,
      detail: 'none',
      anatomy: {
        ...anatomy,
        where: undefined,
        reason: undefined,
        age: undefined,
        description: (entry) =>
          entry.id === 'c' ? null : 'Retries payment intents.',
      },
    });
    try {
      view.measure(1440);
      const height = (id: string) =>
        parseFloat(view.query(`row:${id}:card`)!.style.minHeight);
      expect(height('c')).toBeLessThan(height('a'));
      // Keyboard rows are the drawn rows: ArrowDown from the second described card lands on the tile below.
      await act(async () => {
        view.query('row:b')!.focus();
        view.query('row:b')!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(document.activeElement).toBe(view.query('row:c'));
    } finally {
      view.unmount();
    }
  });

  it('omits empty bands for a shelf while retaining a common minimum track within each shelf', () => {
    const view = mount({
      presentation: 'grid',
      anatomy: {
        ...anatomy,
        description: (entry) =>
          entry.group === 'needs' ? 'Retries payment intents.' : null,
        reason: (entry) =>
          entry.reason === '' ? null : <Text>{entry.reason}</Text>,
      },
    });
    view.measure(1440);
    const height = (id: string) =>
      parseFloat(view.query(`row:${id}:card`)!.style.minHeight);
    expect(height('a')).toBe(height('b'));
    // "Everything else" has neither a description nor a status: its card is just its head.
    expect(height('c')).toBeLessThan(height('a'));
    view.unmount();
  });

  it('aligns minimum tracks without clipping growing content and bounds a description to two lines', () => {
    const view = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: described,
    });
    view.measure(1440);
    const heights = ['a', 'b', 'c'].map(
      (id) => view.query(`row:${id}:card`)!.style.minHeight,
    );
    expect(heights[0]).not.toBe('');
    expect(new Set(heights).size).toBe(1);
    const description = view.query('row:a:description')!;
    expect(
      getComputedStyle(description).webkitLineClamp ??
        description.style.webkitLineClamp,
    ).toBe('2');
    view.unmount();
  });

  it('makes the default header action its own target that never opens the item', () => {
    actionPresses.length = 0;
    const view = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: described,
    });
    view.measure(1440);
    const action = view.query('action:a')!;
    expect(within(view.query('row:a'), 'action:a')).toBe(false);
    act(() => {
      action.click();
    });
    expect(actionPresses).toEqual(['a']);
    expect(view.openChanges).toEqual([]);
    act(() => {
      view.query('row:a')!.click();
    });
    expect(view.openChanges).toEqual(['a']);
    view.unmount();
  });

  it('keeps a long warning from displacing its independent header action at phone width', () => {
    actionPresses.length = 0;
    const warning =
      'This plugin needs a repository to watch before it can run on this machine.';
    const view = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: {
        ...described,
        reason: (entry) => (
          <Text testID={`warning:${entry.id}`} numberOfLines={1}>
            {warning}
          </Text>
        ),
      },
    });
    view.measure(390);
    const status = view.query('warning:a')!;
    const action = view.query('action:a')!;
    // The warning gives way before the independent action does.
    const statusSlot = status.parentElement!;
    const actionSlot = action.parentElement!;
    expect(statusSlot.parentElement).toBe(actionSlot.parentElement);
    expect(getComputedStyle(statusSlot).flexShrink).toBe('1');
    expect(getComputedStyle(actionSlot).flexShrink).toBe('0');
    expect(getComputedStyle(actionSlot.parentElement!).flexDirection).toBe(
      'row',
    );
    expect(
      Number.parseFloat(getComputedStyle(actionSlot.parentElement!).gap),
    ).toBeGreaterThan(0);
    expect(within(view.query('row:a'), 'action:a')).toBe(false);
    act(() => {
      action.click();
    });
    expect(actionPresses).toEqual(['a']);
    expect(view.openChanges).toEqual([]);
    act(() => {
      view.query('row:a')!.click();
    });
    expect(view.openChanges).toEqual(['a']);
    view.unmount();
  });

  it('draws shelves only when the consumer groups', () => {
    const grouped = mount({ presentation: 'grid', anatomy: described });
    grouped.measure(1440);
    expect(grouped.query('collection:shelf:needs')!.textContent).toContain(
      'Needs you',
    );
    expect(grouped.query('collection:shelf:needs')!.textContent).toContain(
      'You act next',
    );
    grouped.unmount();
    const flat = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: described,
    });
    flat.measure(1440);
    expect(flat.query('collection:shelf:needs')).toBeNull();
    flat.unmount();
  });

  it('holds the table geometry with skeleton rows while loading, never its empty state', async () => {
    const view = mount({
      items: [],
      loading: true,
      empty: <Text testID="empty-state">Nothing here</Text>,
    });
    view.measure(1440, 420);
    // The rows that are coming stand in their own height, filling what is on screen; "empty" would be a lie.
    expect(view.queryAll('collection:skeleton-row').length).toBeGreaterThan(3);
    expect(view.query('empty-state')).toBeNull();
    await view.update({ items: entries, loading: false });
    expect(view.queryAll('collection:skeleton-row')).toHaveLength(0);
    expect(view.query('row:a')).not.toBeNull();
    await view.update({ items: [], loading: false });
    expect(view.query('empty-state')).not.toBeNull();
    view.unmount();
  });

  it("stands the table's loading frame without a plugin environment: ruled column band, then rows as tall as the table's fill the view", () => {
    // The host draws this before any plugin bundle has loaded, so it carries its own theme and needs no provider.
    const mount = mountThroughReactNativeWeb(
      <CollectionLoadingRows
        testID="loading"
        theme={SURFACE_CONTEXT_THEME_FIXTURE}
        accessibilityLabel="Loading"
      />,
    );
    const frame = mount.container.querySelector<HTMLElement>(
      '[data-testid="loading"]',
    )!;
    const layout = Reflect.get(frame, '__reactLayoutHandler') as (
      event: HappierLayoutChangeEvent,
    ) => void;
    act(() =>
      layout({
        nativeEvent: { layout: { x: 0, y: 0, width: 1300, height: 420 } },
      }),
    );
    const rows = [
      ...mount.container.querySelectorAll<HTMLElement>(
        '[data-testid="loading:skeleton-row"]',
      ),
    ];
    expect(rows.length).toBeGreaterThan(3);
    // One exact row height, the table's (a plain list placeholder draws four two-line rows).
    expect(new Set(rows.map((row) => row.style.height)).size).toBe(1);
    expect(rows[0]!.style.paddingLeft).toBe('20px');
    expect(mount.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    mount.unmount();
  });

  it('holds the grid geometry with skeleton cards while loading: the last known count, else what fills the view', async () => {
    const view = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: described,
      items: [],
      loading: true,
    });
    view.measure(1440, 800);
    // Nothing known yet: as many rows of the measured column count (1440 fits 4) as fill what is on screen,
    // like the table's skeleton rows; a phone's one column is never a single lonely card.
    const wide = view.queryAll('collection:skeleton-card').length;
    expect(wide % 4).toBe(0);
    expect(wide).toBeGreaterThan(4);
    view.measure(390, 800);
    expect(view.queryAll('collection:skeleton-card').length).toBeGreaterThan(1);
    view.measure(1440, 800);
    await view.update({ items: entries, loading: false });
    expect(view.queryAll('collection:skeleton-card').length).toBe(0);
    await view.update({ items: [], loading: true });
    expect(view.queryAll('collection:skeleton-card').length).toBe(3);
    view.unmount();
  });

  it('fills the page viewport without feeding skeleton content height back into loading geometry', () => {
    const view = mount({
      presentation: 'grid',
      scroll: 'page',
      grouped: false,
      anatomy: described,
      items: [],
      loading: true,
    });
    const viewport = view.query('collection') as unknown as {
      __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void;
    };
    act(() => {
      viewport.__reactLayoutHandler?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 800 } },
      });
    });
    view.measure(1440, 800);
    const count = view.queryAll('collection:skeleton-card').length;
    expect(count).toBeGreaterThan(4);
    view.measure(1440, 9000);
    expect(view.queryAll('collection:skeleton-card')).toHaveLength(count);
    view.unmount();
  });

  it('reserves only the rows a page grid will render when the caller knows them (a shelf\'s one row)', () => {
    const view = mount({
      presentation: 'grid',
      scroll: 'page',
      grouped: false,
      anatomy: described,
      items: [],
      loading: true,
      loadingRows: 1,
    });
    const viewport = view.query('collection') as unknown as {
      __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void;
    };
    act(() => {
      viewport.__reactLayoutHandler?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 800 } },
      });
    });
    view.measure(1440, 800);
    // 1440 fits four cards: one row of them, not the rows that would fill the page.
    expect(view.queryAll('collection:skeleton-card')).toHaveLength(4);
    view.unmount();
  });

  it('rings every card in a bulk selection, since the card body draws no selection fill of its own', () => {
    const store = createListMultiSelectionStore({
      scopeKey: 'entries',
      visibleOrderedKeys: [],
    });
    const view = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: described,
      detail: 'none',
      selection: { multiple: { store } },
    });
    try {
      view.measure(1440);
      act(() => {
        store.setSelectedKeys(['a', 'c']);
      });
      expect(view.query('row:a:selected')).not.toBeNull();
      expect(view.query('row:c:selected')).not.toBeNull();
      expect(view.query('row:b:selected')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('marks the open card when the caller shows its detail elsewhere (detail none)', async () => {
    const view = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: described,
      detail: 'none',
      openKey: 'b',
    });
    view.measure(1440);
    expect(view.query('row:b:selected')).not.toBeNull();
    expect(view.query('row:a:selected')).toBeNull();
    // Nothing of the detail is drawn by the Collection itself.
    expect(view.query('detail:b')).toBeNull();
    await view.update({ presentation: 'list' });
    expect(
      view
        .query('row:b')!
        .closest('[role="row"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
    view.unmount();
  });

  it('keeps a common minimum track for populated descriptions without reserving an empty band', () => {
    const cardHeight = (view: ReturnType<typeof mount>) =>
      Number.parseFloat(view.query('row:a:card')!.style.minHeight);
    const full = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: described,
    });
    full.measure(1440);
    const bare = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: { ...anatomy, reason: undefined },
    });
    bare.measure(1440);
    // An empty slot does not reserve a facts or description band.
    expect(cardHeight(bare)).toBeLessThan(cardHeight(full));
    for (const description of [null, '']) {
      const absent = mount({ presentation: 'grid', grouped: false,
        anatomy: { ...anatomy, reason: undefined, description: () => description } });
      absent.measure(1440);
      expect(absent.query('row:a:description')).toBeNull();
      expect(cardHeight(absent)).toBe(cardHeight(bare));
      absent.unmount();
    }
    // One described card is enough for every card in the grid to keep the two lines (equal heights, aligned rows).
    const one = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: {
        ...anatomy,
        reason: undefined,
        description: (entry) => (entry.id === 'c' ? 'Only this one.' : null),
      },
    });
    one.measure(1440);
    expect(cardHeight(one)).toBeGreaterThan(cardHeight(bare));
    expect(Number.parseFloat(one.query('row:c:card')!.style.minHeight)).toBe(
      cardHeight(one),
    );
    full.unmount();
    bare.unmount();
    one.unmount();
  });

  it('draws the item itself in a preview band above every card, at one height, and never in a list', () => {
    const cardHeight = (view: ReturnType<typeof mount>) =>
      Number.parseFloat(view.query('row:a:card')!.style.minHeight);
    const previewed: CollectionAnatomy<Entry> = {
      ...anatomy,
      preview: (entry) => <Text>{`Preview of ${entry.id}`}</Text>,
    };
    const plain = mount({ presentation: 'grid', grouped: false, anatomy });
    plain.measure(1440);
    const grid = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: previewed,
    });
    grid.measure(1440);
    expect(grid.query('row:b:preview')?.textContent).toBe('Preview of b');
    // The preview contributes to every card's minimum track.
    expect(cardHeight(grid)).toBeGreaterThan(cardHeight(plain));
    expect(Number.parseFloat(grid.query('row:c:card')!.style.minHeight)).toBe(
      cardHeight(grid),
    );
    const list = mount({
      presentation: 'list',
      grouped: false,
      anatomy: previewed,
    });
    list.measure(1440);
    expect(list.query('row:b:preview')).toBeNull();
    plain.unmount();
    grid.unmount();
    list.unmount();
  });

  it('stands a preview card on its band: mark beside the title, where under it, kind and age at the foot (lab artifacts A1)', () => {
    const previewed: CollectionAnatomy<Entry> = {
      ...anatomy,
      preview: (entry) => <Text>{`Preview of ${entry.id}`}</Text>,
    };
    const grid = mount({ presentation: 'grid', grouped: false, anatomy: previewed });
    grid.measure(1440);
    const header = grid.query('row:a:chrome.header')!;
    const titleBlock = grid.query('row:a:chrome.titleBlock')!;
    const foot = grid.query('row:a:chrome.footer')!;
    // The band already identifies the item, so its mark needs no row of its own above the title.
    expect(getComputedStyle(header).flexDirection).toBe('row');
    expect(titleBlock.textContent).toContain('payments-api');
    expect(foot.textContent).toContain('Review requested');
    expect(foot.textContent).toContain('18m');
    expect(foot.textContent).not.toContain('payments-api');
    expect(header.textContent).not.toContain('Review requested');
    grid.unmount();
    // A card with no band keeps the one card: its reason stays in the right slot, its mark on its own row.
    const plain = mount({ presentation: 'grid', grouped: false, anatomy });
    plain.measure(1440);
    expect(getComputedStyle(plain.query('row:a:chrome.header')!).flexDirection).toBe('column-reverse');
    expect(plain.query('row:a:chrome.header')!.textContent).toContain('Review requested');
    plain.unmount();
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
      for (
        let node = element?.parentElement ?? null;
        node !== null;
        node = node.parentElement
      ) {
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
    const view = mount({
      presentation: 'grid',
      grouped: false,
      anatomy: described,
      pane,
    });
    view.measure(1440);
    act(() => {
      view.query('row:c')!.click();
    });
    await view.setOpen('c');
    expect(within(view.query('host-pane'), 'detail:c')).toBe(true);
    // Escape from the grid closes it as well.
    act(() => {
      view.query('row:a')!.focus();
    });
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(view.openChanges).toEqual(['c', null]);
    await view.setOpen(null);
    expect(document.activeElement).toBe(view.query('row:c'));
    view.unmount();
  });
});

describe('named table orders', () => {
  it('offers the named orders in the title header, checks the active order and delegates selection to the caller', async () => {
    const changes: string[] = [];
    const sort = {
      key: 'newest',
      direction: 'descending' as const,
      orders: [
        { key: 'newest', label: 'Newest' },
        { key: 'oldest', label: 'Oldest' },
        { key: 'smart', label: 'Smart' },
      ],
      onChange: (key: string) => {
        changes.push(key);
      },
    };
    const view = mount({
      sort,
      renderPopover: (input) =>
        input.open
          ? input.content({
              requestClose: input.onRequestClose,
              maxHeight: 400,
            })
          : null,
    });
    view.measure(1440);
    const trigger = view.query('collection:sort:title')!;
    expect(trigger).not.toBeNull();
    expect(trigger.closest('[aria-sort]')!.getAttribute('aria-sort')).toBe(
      'descending',
    );
    // The order is part of the column's own title, quiet like its neighbours: no button face in the header row.
    expect(getComputedStyle(trigger).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    act(() => {
      trigger.click();
    });
    const options = [
      ...view.container.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ];
    expect(options.map((option) => option.textContent)).toEqual([
      'Newest',
      'Oldest',
      'Smart',
    ]);
    expect(
      options.map((option) => option.getAttribute('aria-checked')),
    ).toEqual(['true', 'false', 'false']);
    act(() => {
      options[1]!.click();
    });
    expect(changes).toEqual(['oldest']);
    await view.update({
      sort: { ...sort, key: 'oldest', direction: 'ascending' },
    });
    expect(
      view
        .query('collection:sort:title')!
        .closest('[aria-sort]')!
        .getAttribute('aria-sort'),
    ).toBe('ascending');
    await view.update({ sort: { ...sort, key: 'memory' } });
    expect(
      view
        .query('collection:sort:title')!
        .closest('[aria-sort]')!
        .getAttribute('aria-sort'),
    ).toBe('none');
    act(() => {
      view.query('collection:sort:title')!.click();
    });
    expect(
      [...view.container.querySelectorAll('[role="menuitemradio"]')].every(
        (option) => option.getAttribute('aria-checked') === 'false',
      ),
    ).toBe(true);
    act(() => {
      view.query('collection:sort:title')!.click();
    });
    await view.update({ items: [] });
    expect(view.query('collection:sort:title')).not.toBeNull();
    await view.update({ presentation: 'list' });
    expect(view.query('collection:sort:title')).toBeNull();
    await view.update({ presentation: 'board' });
    expect(view.query('collection:sort:title')).toBeNull();
    await view.update({ presentation: 'table' });
    view.measure(360);
    expect(view.query('collection:sort:title')).toBeNull();
    view.unmount();
  });
});

// ---- nesting (owners and their processes), sortable columns, totals rows ----

type Proc = Readonly<{
  id: string;
  title: string;
  group: 'happier' | 'left';
  parent: string | null;
  cpu: string;
  memory: string;
}>;

const procs: readonly Proc[] = [
  {
    id: 's1',
    title: 'Refactor glass pipeline',
    group: 'happier',
    parent: null,
    cpu: '6.1%',
    memory: '4.1 GB',
  },
  {
    id: 'agent',
    title: 'Agent claude',
    group: 'happier',
    parent: 's1',
    cpu: '0.9%',
    memory: '620 MB',
  },
  {
    id: 'shell',
    title: 'Tool shell',
    group: 'happier',
    parent: 's1',
    cpu: '2.3%',
    memory: '1.1 GB',
  },
  {
    id: 'runner',
    title: 'Test runner',
    group: 'happier',
    parent: 'shell',
    cpu: '2.3%',
    memory: '1.1 GB',
  },
  {
    id: 'checker',
    title: 'Type checker',
    group: 'happier',
    parent: 's1',
    cpu: '1.8%',
    memory: '1.3 GB',
  },
  {
    id: 's2',
    title: 'Fix relay retry budget',
    group: 'happier',
    parent: null,
    cpu: '0.1%',
    memory: '1.8 GB',
  },
  {
    id: 's2-agent',
    title: 'Agent codex',
    group: 'happier',
    parent: 's2',
    cpu: '0.1%',
    memory: '300 MB',
  },
  {
    id: 'orphan',
    title: 'Dev server',
    group: 'left',
    parent: null,
    cpu: '0.1%',
    memory: '640 MB',
  },
];

const procGroups: HappierCollectionGrouping<Proc> = {
  axis: [
    { key: 'happier', title: 'Started by Happier' },
    { key: 'left', title: 'Left behind' },
  ],
  groupOf: (proc) => proc.group,
};

const procAnatomy: CollectionAnatomy<Proc> = {
  glyph: () => <Text>•</Text>,
  title: (proc) => proc.title,
  fields: [
    {
      key: 'cpu',
      title: 'CPU',
      render: (proc) => proc.cpu,
      minWidth: 64,
      priority: 2,
      align: 'end',
      sortable: true,
    },
    {
      key: 'memory',
      title: 'Memory',
      render: (proc) => proc.memory,
      minWidth: 80,
      priority: 3,
      align: 'end',
      sortable: true,
    },
  ],
  peek: (proc) => (
    <Text testID={`proc-peek:${proc.id}`}>{`About ${proc.title}`}</Text>
  ),
  accessibilityLabel: (proc) => proc.title,
  testID: (proc) => `proc:${proc.id}`,
  columnTitles: { title: 'Started by Happier' },
};

type TreeHarnessProps = Readonly<{
  presentation?: 'table' | 'list';
  query?: string;
  initialOpen?: readonly string[];
  sort?: CollectionProps<Proc>['sort'];
  summaryRows?: CollectionProps<Proc>['summaryRows'];
  groupAction?: CollectionProps<Proc>['groupAction'];
  scroll?: 'page';
  ungrouped?: boolean;
  onOpenChange: (key: string | null) => void;
}>;

function TreeHarness(props: TreeHarnessProps): ReactElement {
  const query = props.query ?? '';
  const filter = React.useMemo(
    () =>
      query === ''
        ? undefined
        : (proc: Proc) =>
            proc.title.toLowerCase().includes(query.toLowerCase()),
    [query],
  );
  const model = useHappierCollection({
    items: procs,
    keyOf: (proc: Proc) => proc.id,
    ...(props.ungrouped ? {} : { groups: procGroups }),
    parentKey: (proc: Proc) => proc.parent,
    ...(filter === undefined ? {} : { filter }),
    ...(props.initialOpen === undefined
      ? {}
      : { initialOpenBranches: props.initialOpen }),
    openKey: null,
    onOpenChange: props.onOpenChange,
    expandable: true,
  });
  return (
    <Collection
      model={model}
      anatomy={procAnatomy}
      accessibilityLabel="Processes"
      presentation={props.presentation ?? 'table'}
      detail="none"
      minListWidth={240}
      minDetailWidth={400}
      preferredListRatio={0.3}
      {...(props.sort === undefined ? {} : { sort: props.sort })}
      {...(props.summaryRows === undefined
        ? {}
        : { summaryRows: props.summaryRows })}
      {...(props.groupAction === undefined
        ? {}
        : { groupAction: props.groupAction })}
      {...(props.scroll === undefined ? {} : { scroll: props.scroll })}
      testID="procs"
    />
  );
}

function mountTree(options: Omit<TreeHarnessProps, 'onOpenChange'> = {}) {
  const context = createSurfaceContext({ reducedMotion: false });
  const hostApi = createHostApiStub(context);
  const openChanges: Array<string | null> = [];
  let harness = options;
  const wrap = () => (
    <PluginUiProviderInternal
      hostApi={hostApi}
      context={context}
      presentationHost={{
        ...presentationHost(undefined),
        focusTarget: (target: { focus: () => void }) => {
          target.focus();
          return true;
        },
      }}
    >
      <TreeHarness
        {...harness}
        onOpenChange={(key) => {
          openChanges.push(key);
        }}
      />
    </PluginUiProviderInternal>
  );
  const mounted = mountThroughReactNativeWeb(wrap());
  const query = (testID: string) =>
    mounted.container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  return {
    container: mounted.container,
    openChanges,
    query,
    /** The process rows on screen, in reading order. */
    rows: () =>
      [
        ...mounted.container.querySelectorAll<HTMLElement>(
          '[data-testid^="proc:"]',
        ),
      ]
        .map((node) => node.getAttribute('data-testid')!)
        .filter((id) => /^proc:[^:]+$/u.test(id))
        .map((id) => id.slice('proc:'.length)),
    rowElement: (id: string) =>
      query(`proc:${id}`)!.closest<HTMLElement>('[role="row"]')!,
    update: (next: Omit<TreeHarnessProps, 'onOpenChange'>) => {
      harness = { ...harness, ...next };
      return mounted.render(wrap());
    },
    measure: (width: number, height = 800) => {
      const root = query('procs:stage');
      const onLayout = (
        root as unknown as {
          __reactLayoutHandler: (event: HappierLayoutChangeEvent) => void;
        }
      ).__reactLayoutHandler;
      act(() =>
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }),
      );
    },
    unmount: mounted.unmount,
  };
}

function press(element: HTMLElement, key: string) {
  act(() => {
    element.focus();
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

describe('Collection nesting', () => {
  it('draws children under their open owner in input order, with treegrid facts, and the disclosure never opens the row', () => {
    const view = mountTree({
      groupAction: (key) =>
        key === 'left'
          ? { label: 'Clean up 1', onPress: () => undefined }
          : null,
    });
    view.measure(1440);
    expect(view.rows()).toEqual(['s1', 's2', 'orphan']);
    expect(view.container.querySelector('[role="treegrid"]')).not.toBeNull();
    const owner = view.rowElement('s1');
    expect(owner.getAttribute('aria-level')).toBe('1');
    expect(owner.getAttribute('aria-expanded')).toBe('false');
    // A row without children states no expanded state.
    expect(view.rowElement('orphan').getAttribute('aria-expanded')).toBeNull();
    expect(view.query('proc:orphan:branch')).toBeNull();

    act(() => {
      view.query('proc:s1:branch')!.click();
    });
    expect(view.rows()).toEqual([
      's1',
      'agent',
      'shell',
      'checker',
      's2',
      'orphan',
    ]);
    expect(view.rowElement('s1').getAttribute('aria-expanded')).toBe('true');
    const child = view.rowElement('shell');
    expect(child.getAttribute('aria-level')).toBe('2');
    expect(child.getAttribute('aria-posinset')).toBe('2');
    expect(child.getAttribute('aria-setsize')).toBe('3');
    // Pressing the disclosure neither opens nor peeks the row.
    expect(view.openChanges).toEqual([]);
    expect(view.query('proc-peek:s1')).toBeNull();

    act(() => {
      view.query('proc:shell:branch')!.click();
    });
    expect(view.rows()).toEqual([
      's1',
      'agent',
      'shell',
      'runner',
      'checker',
      's2',
      'orphan',
    ]);
    expect(view.rowElement('runner').getAttribute('aria-level')).toBe('3');

    // Closing the owner hides every descendant; their own open state is kept for the next opening.
    act(() => {
      view.query('proc:s1:branch')!.click();
    });
    expect(view.rows()).toEqual(['s1', 's2', 'orphan']);
    act(() => {
      view.query('proc:s1:branch')!.click();
    });
    expect(view.rows()).toEqual([
      's1',
      'agent',
      'shell',
      'runner',
      'checker',
      's2',
      'orphan',
    ]);

    // The table's group header keeps its one action and counts the group's items (nested ones included).
    expect(view.query('procs:group:left:action')).not.toBeNull();
    expect(view.query('virtualizer')!.textContent).toContain(
      'Started by Happier7',
    );
    view.unmount();
  });

  it('opens and enters an owner with Right, and leaves and closes it with Left', () => {
    const view = mountTree();
    view.measure(1440);
    press(view.query('proc:s1')!, 'ArrowRight');
    expect(view.rows()).toEqual([
      's1',
      'agent',
      'shell',
      'checker',
      's2',
      'orphan',
    ]);
    expect(document.activeElement).toBe(view.query('proc:s1'));
    press(view.query('proc:s1')!, 'ArrowRight');
    expect(document.activeElement).toBe(view.query('proc:agent'));
    press(view.query('proc:agent')!, 'ArrowLeft');
    expect(document.activeElement).toBe(view.query('proc:s1'));
    press(view.query('proc:s1')!, 'ArrowLeft');
    expect(view.rows()).toEqual(['s1', 's2', 'orphan']);
    // Down skips what is closed.
    press(view.query('proc:s1')!, 'ArrowDown');
    expect(document.activeElement).toBe(view.query('proc:s2'));
    expect(view.openChanges).toEqual([]);
    view.unmount();
  });

  it("keeps a match inside its shown owner while searching, without forcing a matching owner's other children", async () => {
    const view = mountTree({ query: 'runner' });
    view.measure(1440);
    // Both ancestors are shown as context and held open; the match's non-matching siblings stay out.
    expect(view.rows()).toEqual(['s1', 'shell', 'runner']);
    expect(view.rowElement('s1').getAttribute('aria-expanded')).toBe('true');
    await view.update({ query: 'refactor' });
    expect(view.rows()).toEqual(['s1']);
    expect(view.query('proc:s1:branch')).toBeNull();
    await view.update({ query: '' });
    expect(view.rows()).toEqual(['s1', 's2', 'orphan']);
    view.unmount();
  });

  it('draws owners only in the list presentation', () => {
    const view = mountTree({ presentation: 'list', initialOpen: ['s1'] });
    view.measure(1440);
    expect(view.rows()).toEqual(['s1', 's2', 'orphan']);
    view.unmount();
    // A phone recomposes the table into the same owners-only list.
    const phone = mountTree({ initialOpen: ['s1'] });
    phone.measure(360);
    expect(phone.rows()).toEqual(['s1', 's2', 'orphan']);
    phone.unmount();
  });

  it('makes sortable column titles buttons that state the active order and leave the data to the caller', () => {
    const changes: string[] = [];
    const view = mountTree({
      sort: {
        key: 'memory',
        direction: 'descending',
        onChange: (key) => {
          changes.push(key);
        },
      },
    });
    view.measure(1440);
    const memory = view.query('procs:sort:memory')!;
    const cpu = view.query('procs:sort:cpu')!;
    expect(memory.getAttribute('role')).toBe('button');
    expect(memory.closest('[aria-sort]')!.getAttribute('aria-sort')).toBe(
      'descending',
    );
    expect(cpu.closest('[aria-sort]')!.getAttribute('aria-sort')).toBe('none');
    expect(view.query('procs:sort:memory:arrow')).not.toBeNull();
    expect(view.query('procs:sort:cpu:arrow')).toBeNull();
    act(() => {
      cpu.click();
    });
    expect(changes).toEqual(['cpu']);
    // The Collection does not reorder.
    expect(view.rows()).toEqual(['s1', 's2', 'orphan']);
    view.unmount();
  });

  it('draws totals rows after the last group, aligned under the field columns and never focusable', () => {
    const summaryRows = [
      {
        key: 'total',
        title: 'Happier in total',
        cells: { cpu: '6.9%', memory: '9.9 GB' },
        testID: 'total',
      },
      {
        key: 'else',
        title: 'Everything else',
        cells: { memory: '47.1 GB' },
        testID: 'else',
      },
    ];
    const view = mountTree({ summaryRows });
    view.measure(1440);
    const total = view.query('total')!;
    expect(total.textContent).toContain('Happier in total');
    expect(view.query('total:cpu')!.textContent).toBe('6.9%');
    expect(view.query('total:memory')!.style.width).toBe('80px');
    expect(view.query('total:cpu')!.style.width).toBe('64px');
    // After the last group's rows.
    expect(
      view.query('proc:orphan')!.compareDocumentPosition(total) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      total.querySelector('[tabindex], [role="button"], [role="row"]'),
    ).toBeNull();
    expect(total.getAttribute('tabindex')).toBeNull();
    view.unmount();
    // In the list the title stays left and the highest-priority value right.
    const list = mountTree({ presentation: 'list', summaryRows });
    list.measure(1440);
    expect(list.query('total')!.textContent).toBe('Happier in total9.9 GB');
    list.unmount();
  });
});

/**
 * Where `node` stands in `region` (jsdom has no layout, so this reads the flex facts that decide it): whether
 * anything laid out before it grows into the region's free space (which pushes it to the region's bottom), and
 * whether every box from it up to the region grows to fill what the region has left.
 */
function placementIn(
  node: HTMLElement,
  region: HTMLElement,
): Readonly<{ pushedDown: boolean; fills: boolean }> {
  const grows = (element: Element) =>
    Number.parseFloat(getComputedStyle(element).flexGrow || '0') > 0;
  let pushedDown = false;
  let fills = true;
  for (
    let child: HTMLElement = node;
    child !== region;
    child = child.parentElement!
  ) {
    for (
      let sibling = child.previousElementSibling;
      sibling !== null;
      sibling = sibling.previousElementSibling
    ) {
      if (grows(sibling)) pushedDown = true;
    }
    if (child !== node && !grows(child)) fills = false;
  }
  return { pushedDown, fills };
}

describe('state placement in the rows region', () => {
  it("stands the first window's skeleton rows from the top of the rows region, under the table's own column titles", () => {
    const view = mount({
      items: [],
      loading: true,
      empty: <Text testID="empty-state">Nothing here</Text>,
    });
    view.measure(1440, 800);
    const skeleton = view.queryAll('collection:skeleton-row')[0]!;
    // Where the rows will land: nothing above the skeleton takes the free space, so it never sits at the bottom.
    expect(
      placementIn(skeleton, view.query('collection-list')!).pushedDown,
    ).toBe(false);
    // The column titles stand while the rows load, so the first rows land exactly where the skeleton stood.
    const list = view.query('collection-list')!;
    const whereTitle = [...list.querySelectorAll('[dir="auto"]')].find(
      (node) => node.textContent === 'Where',
    );
    expect(whereTitle).toBeDefined();
    expect(
      skeleton.compareDocumentPosition(whereTitle!) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    view.unmount();
  });

  it.each(['table', 'list', 'board'] as const)(
    'fills the same rows region with the empty state in the %s',
    (presentation) => {
      const view = mount({
        presentation,
        items: [],
        empty: <Text testID="empty-state">Nothing here</Text>,
      });
      view.measure(1440, 800);
      const placement = placementIn(
        view.query('empty-state')!,
        view.query('collection-list')!,
      );
      expect(placement).toEqual({ pushedDown: false, fills: true });
      view.unmount();
    },
  );
});

describe('an empty table cell', () => {
  it('says "—" rather than leaving a blank that reads as a column that failed to load', () => {
    const view = mount({});
    view.measure(1440);
    const withReason = view.query('row:a')!;
    const withoutReason = view.query('row:c')!;
    expect(withReason.textContent).not.toContain('—');
    expect(withoutReason.textContent).toContain('—');
    view.unmount();
  });
});

describe("the search in the caller's header row", () => {
  const search = {
    label: 'Search entries',
    value: '',
    onValueChange: () => undefined,
    testID: 'search',
    tokens: [
      {
        key: 'state',
        qualifier: 'is',
        label: 'open',
        onRemove: () => undefined,
      },
    ],
  };

  it('hands the search, tokens and all, to a header render at a bounded width, and leaves the list pane without it', () => {
    const view = mount({
      search,
      header: (slots) => (
        <View testID="toolbar">
          {slots.search}
          <Text testID="trailing">Updated just now</Text>
        </View>
      ),
    });
    view.measure(1440);
    const toolbar = view.query('toolbar')!;
    const input = view.query('search')!;
    expect(toolbar.contains(input)).toBe(true);
    expect(view.query('collection-list')!.contains(input)).toBe(false);
    expect(view.queryAll('search')).toHaveLength(1);
    // The narrowings stay inside the field's well.
    expect(
      input.parentElement!.querySelector('[aria-label="Remove is open"]'),
    ).not.toBeNull();
    // Search first, the caller's trailing controls after it.
    expect(
      input.compareDocumentPosition(view.query('trailing')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // A bounded field: it never takes the whole row, and narrows (to the row) rather than overflowing it.
    let slot: HTMLElement = input;
    while (slot.parentElement !== toolbar) slot = slot.parentElement!;
    // A readable basis it grows from, up to a readable measure; it gives way before the trailing controls wrap.
    expect(Number.parseFloat(getComputedStyle(slot).flexBasis)).toBeGreaterThan(0);
    expect(Number.parseFloat(getComputedStyle(slot).maxWidth)).toBeGreaterThan(Number.parseFloat(getComputedStyle(slot).flexBasis));
    // A wrapping row breaks its line on each control's own width before anything narrows. The field counts at its
    // narrowest, not at its input's content width, so the trailing controls wrap (and the toolbar folds) only when
    // the row cannot hold them beside the narrowest field (a 1440 Tasks page folded with room to spare).
    expect(Number.parseFloat(getComputedStyle(slot).width)).toBe(Number.parseFloat(getComputedStyle(slot).flexBasis));
    expect(
      Number.parseFloat(getComputedStyle(slot).flexShrink),
    ).toBeGreaterThan(0);
    view.unmount();
  });

  it("names the page at the head of the caller's row as its heading, unless the host's navigation already shows the title", () => {
    const header: CollectionProps<Entry>['header'] = (slots) => (
      <View testID="toolbar">
        {slots.title}
        {slots.search}
      </View>
    );
    const desk = mount({
      search,
      title: 'PRs & Issues',
      header,
      pageChrome: { showsTitle: false },
    });
    desk.measure(1440);
    const heading = desk.query('toolbar')!.querySelector('[role="heading"]');
    expect(heading?.textContent).toBe('PRs & Issues');
    // It is drawn in the theme's ink like the row titles, never the platform's default colour (black on a dark
    // theme). Compared with a row title so the assertion follows whatever theme the surface carries.
    const rowTitle = [
      ...desk.container.querySelectorAll<HTMLElement>('div, span'),
    ].find(
      (node) =>
        node.childElementCount === 0 &&
        node.textContent === 'Retry idempotent payment intents',
    );
    expect(getComputedStyle(heading!).color).not.toBe('');
    expect(getComputedStyle(heading!).color).toBe(
      getComputedStyle(rowTitle!).color,
    );
    // It leads the row: the search comes after it.
    expect(
      heading!.compareDocumentPosition(desk.query('search')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    desk.unmount();

    // A phone's navigation header already says it; the row does not say it twice.
    const phone = mount({
      search,
      title: 'PRs & Issues',
      header,
      pageChrome: { showsTitle: true },
    });
    phone.measure(390);
    expect(
      phone.query('toolbar')!.querySelector('[role="heading"]'),
    ).toBeNull();
    expect(phone.query('toolbar')!.textContent).not.toContain('PRs & Issues');
    phone.unmount();
  });

  it('hands the selection control to a header render, so the list pane draws no row of its own for it', () => {
    const store = createListMultiSelectionStore({
      scopeKey: 'entries',
      visibleOrderedKeys: [],
    });
    const view = mount({
      search,
      selection: { multiple: { store } },
      header: (slots) => (
        <View testID="toolbar">
          {slots.search}
          {slots.selection}
        </View>
      ),
    });
    view.measure(1440);
    const mode = view.query('happier-list-selection-mode')!;
    expect(view.query('toolbar')!.contains(mode)).toBe(true);
    expect(view.query('collection-list')!.contains(mode)).toBe(false);
    expect(view.queryAll('happier-list-selection-mode')).toHaveLength(1);
    view.unmount();
  });

  it('on a pointer device selects by click and keys alone: no Select button, only the way back out while selecting', async () => {
    const matchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
    (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
      matches: query === '(hover: hover) and (pointer: fine)',
    });
    let view: ReturnType<typeof mount> | null = null;
    try {
      const store = createListMultiSelectionStore({
        scopeKey: 'entries',
        visibleOrderedKeys: [],
      });
      view = mount({ search, selection: { multiple: { store } } });
      view.measure(1440);
      expect(view.query('happier-list-selection-mode')).toBeNull();
      await act(async () => {
        view!.query('row:a')!.dispatchEvent(
          new MouseEvent('click', {
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(store.getSnapshot().isSelectionMode).toBe(true);
      expect([...store.getSnapshot().selectedKeys]).toEqual(['a']);
      expect(view.query('happier-list-selection-mode')?.textContent).toContain(
        'Done',
      );
      expect(view.openChanges).toEqual([]);
      await act(async () => {
        view!.query('happier-list-selection-mode')!.click();
      });
      expect(store.getSnapshot().isSelectionMode).toBe(false);
      expect([...store.getSnapshot().selectedKeys]).toEqual([]);
      expect(view.query('happier-list-selection-mode')).toBeNull();
      await act(async () => {
        view!.query('row:b')!.focus();
        view!.query('row:b')!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'x',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(store.getSnapshot().isSelectionMode).toBe(true);
      expect([...store.getSnapshot().selectedKeys]).toEqual(['b']);
      expect(view.query('happier-list-selection-mode')?.textContent).toContain(
        'Done',
      );
      expect(view.openChanges).toEqual([]);
      await act(async () => {
        view!.query('happier-list-selection-mode')!.click();
      });
      expect(store.getSnapshot().isSelectionMode).toBe(false);
      expect([...store.getSnapshot().selectedKeys]).toEqual([]);
    } finally {
      view?.unmount();
      (globalThis as { matchMedia?: unknown }).matchMedia = matchMedia;
    }
  });

  it('keeps the touch selection control on the search row and enters and exits selection through it', async () => {
    const store = createListMultiSelectionStore({
      scopeKey: 'entries',
      visibleOrderedKeys: [],
    });
    const view = mount({ search, selection: { multiple: { store } } });
    view.measure(1440);
    const mode = view.query('happier-list-selection-mode')!;
    const input = view.query('search')!;
    let row: HTMLElement = mode;
    while (!row.contains(input)) row = row.parentElement!;
    // The nearest container holding both lays them out side by side.
    expect(getComputedStyle(row).flexDirection).toBe('row');
    await act(async () => {
      mode.click();
    });
    expect(store.getSnapshot().isSelectionMode).toBe(true);
    await act(async () => {
      view.query('row:a')!.click();
    });
    expect([...store.getSnapshot().selectedKeys]).toEqual(['a']);
    expect(view.openChanges).toEqual([]);
    await act(async () => {
      view.query('happier-list-selection-mode')!.click();
    });
    expect(store.getSnapshot().isSelectionMode).toBe(false);
    expect([...store.getSnapshot().selectedKeys]).toEqual([]);
    expect(view.query('happier-list-selection-mode')).not.toBeNull();
    view.unmount();
  });

  it('draws its search in the one search field, keeping the key hint', () => {
    const view = mount({ search });
    view.measure(1440);
    expect(view.query('search.field')).not.toBeNull();
    expect(view.query('search:shortcut')).not.toBeNull();
    view.unmount();
  });

  it('keeps the search in the list pane for a header given as content', () => {
    const view = mount({
      search,
      header: (
        <View testID="toolbar">
          <Text>Toolbar</Text>
        </View>
      ),
    });
    view.measure(1440);
    expect(view.query('collection-list')!.contains(view.query('search'))).toBe(
      true,
    );
    expect(view.query('toolbar')!.contains(view.query('search'))).toBe(false);
    view.unmount();
  });
});

describe('the Collection toolbar', () => {
  const search = {
    label: 'Search entries',
    value: '',
    onValueChange: () => undefined,
    testID: 'search',
  };
  // A phone host: a requested sheet is drawn as the sheet (titled, the rows, the pinned footer).
  const openPopover: PluginUiPresentationHost['renderPopover'] = (input) =>
    input.sheet === undefined ? (
      input.content({
        maxHeight: 600,
        requestClose: () => input.onRequestClose(),
      })
    ) : (
      <View testID="sheet" aria-label={input.sheet.title} {...{ dataSet: { sheetHeader: input.sheet.header ?? 'band' } }}>
        {input.content({
          maxHeight: 600,
          requestClose: () => input.onRequestClose(),
          presentation: 'sheet',
        })}
        <View testID="sheet:footer">{input.sheet.footer}</View>
      </View>
    );

  function toolbarHeader(
    calls: string[],
    freshness: Readonly<{
      tone: 'muted' | 'warning' | 'neutral';
      label: string;
      indicator?: boolean;
      pulsing?: boolean;
    }> = {
      tone: 'muted',
      label: 'Up to date',
      indicator: false,
    },
  ): CollectionProps<Entry>['header'] {
    return (slots) => (
      <CollectionToolbar
        slots={slots}
        lens={<Text testID="lens">My work</Text>}
        refine={{
          label: 'Filters',
          activeCount: 2,
          render: () => <Text testID="refine:toolbar">Refine</Text>,
          // Folded, the same narrowing form opens in the sheet (a page's condition editor); it closes itself.
          sheet: {
            header: 'none',
            render: ({ close }) => (
              <View testID="refine:form">
                <Text>State is Open</Text>
                <Button title="Show 3 results" onPress={() => { calls.push('done'); close(); }} />
              </View>
            ),
          },
          // The wide row's Order picker joins ⋯ when the toolbar folds.
          foldedChoices: {
            groups: [{
              id: 'order',
              accessibilityLabel: 'Order',
              items: [
                { id: 'order:newest', label: 'Newest', kind: 'radio', radioGroupId: 'order' },
                { id: 'order:oldest', label: 'Oldest', kind: 'radio', radioGroupId: 'order' },
              ],
            }],
            radioGroups: [{ id: 'order', accessibilityLabel: 'Order', selectedId: 'order:newest' }],
            onSelect: (id) => calls.push(`select:${id}`),
          },
        }}
        freshness={freshness}
        refresh={{ label: 'Refresh', onPress: () => calls.push('refresh') }}
        more={{
          label: 'More',
          items: [{ id: 'manage-sources', label: 'Manage sources' }],
          onSelect: (id) => calls.push(id),
        }}
        views={{
          label: 'View',
          value: 'list',
          options: [
            { value: 'list', label: 'List', icon: 'list' },
            { value: 'board', label: 'Board', icon: 'board' },
          ],
          onChange: (value) => calls.push(`view:${value}`),
        }}
        primary={{ label: 'New task', onPress: () => calls.push('primary') }}
        testID="toolbar"
      />
    );
  }

  const button = (container: HTMLElement, label: string) =>
    [
      ...container.querySelectorAll<HTMLElement>('[role="button"], button'),
    ].find((node) => node.getAttribute('aria-label') === label) ?? null;

  function reportToolbarLayout(view: ReturnType<typeof mount>, id: string, y: number, width: number, height: number) {
    const node = view.query(id) as unknown as {
      measureInWindow: (callback: (...values: number[]) => void) => void;
      __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void;
    };
    // jsdom supplies no layout: the native measurement and layout event expose the same platform box.
    node.measureInWindow = (callback) => callback(0, y, width, height);
    act(() => node.__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y, width, height } } }));
  }

  it('uses the current boxes when freshness arrives, instead of folding on an earlier row height', () => {
    const view = mount({ search, header: toolbarHeader([]), renderPopover: openPopover });
    view.measure(1440);
    // Native layout delivery can lag the boxes being read: the trailing cluster has settled on the first line
    // by the time the earlier, two-line row report arrives. Keep the native measurement boundary real in shape.
    const boxes: Record<string, { width: number; height: number }> = {
      toolbar: { width: 1300.4, height: 36 },
      'toolbar:lead': { width: 850.6, height: 36 },
      'toolbar:trail': { width: 441.8, height: 32 },
    };
    let nativeReads = 0;
    for (const id of Object.keys(boxes)) {
      const node = view.query(id)! as HTMLElement & { measureInWindow: (callback: (...values: number[]) => void) => void };
      node.measureInWindow = (callback) => {
        nativeReads += 1;
        callback(0, 0, boxes[id]!.width, boxes[id]!.height);
      };
    }
    const layout = (id: string, height: number) => act(() => {
      const node = view.query(id) as unknown as { __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void };
      node.__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y: 0, width: 1300, height } } });
    });
    layout('toolbar:lead', 36);
    layout('toolbar:trail', 32);
    layout('toolbar', 76);
    expect(view.query('refine:toolbar')).not.toBeNull();
    expect(button(view.query('toolbar')!, 'Refresh')).not.toBeNull();
    // Each event reads the three real boxes, independent of how many controls their clusters contain.
    expect(nativeReads).toBe(9);
    boxes['toolbar:lead'] = { width: 850, height: 76 };
    boxes.toolbar = { width: 1300, height: 76 };
    layout('toolbar', 76);
    expect(view.query('refine:toolbar')).not.toBeNull();
    // True outer wrapping fills the leading line (flexGrow: 1); even maxWidth-constrained clusters overflow
    // their shared room. Internal wrapping inside a cluster keeps its existing composition policy.
    boxes['toolbar:lead'] = { width: 1300, height: 36 };
    layout('toolbar', 76);
    // A healthy freshness gives its words up first; the row lays out again without them and still does not fit.
    layout('toolbar', 76);
    expect(view.query('refine:toolbar')).toBeNull();
    view.unmount();
  });

  it('keeps every control in one row on a wide page', () => {
    const calls: string[] = [];
    const view = mount({
      search,
      header: toolbarHeader(calls),
      renderPopover: openPopover,
    });
    view.measure(1440);
    const toolbar = view.query('toolbar')!;
    expect(toolbar.contains(view.query('search'))).toBe(true);
    expect(toolbar.contains(view.query('lens'))).toBe(true);
    // Filters and order sit in the row itself, not behind a button.
    expect(view.query('refine:toolbar')).not.toBeNull();
    expect(view.query('sheet')).toBeNull();
    expect(toolbar.textContent).toContain('Up to date');
    expect(button(toolbar, 'Refresh')).not.toBeNull();
    expect(button(toolbar, 'More')).not.toBeNull();
    expect(
      toolbar.querySelector('[role="radiogroup"], [role="tablist"]'),
    ).not.toBeNull();
    // The page's one primary action ends the row, in words.
    const primary = button(toolbar, 'New task')!;
    expect(primary.textContent).toBe('New task');
    act(() => {
      primary.click();
    });
    expect(calls).toEqual(['primary']);
    view.unmount();
  });

  it('puts the primary inside the host page actions, so the column Hide stays the last control', () => {
    const calls: string[] = [];
    const view = mount({
      search,
      header: toolbarHeader(calls),
      renderPopover: openPopover,
      pageChrome: {
        showsTitle: false,
        renderNavigationActions: (actions: React.ReactNode) => (
          <><button aria-label="Runs on">Runs on</button>{actions}<button aria-label="Hide Tasks" /></>
        ),
      },
    });
    view.measure(1440);
    const toolbar = view.query('toolbar')!;
    const order = ['Runs on', 'New task', 'Hide Tasks'].map((label) => button(toolbar, label)!);
    expect(order.every(Boolean)).toBe(true);
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toolbar.querySelectorAll('[aria-label="Hide Tasks"]')).toHaveLength(1);
    view.unmount();
  });

  it('folds into its two rows when the list is narrowed beside a details pane, instead of wrapping control by control', () => {
    const view = mount({
      search,
      header: toolbarHeader([]),
      renderPopover: openPopover,
    });
    // A 1440 window with the app's details pane open leaves the list about this wide.
    view.measure(780);
    const toolbar = view.query('toolbar')!;
    expect(toolbar.contains(view.query('search'))).toBe(true);
    expect(toolbar.contains(view.query('lens'))).toBe(true);
    // Filters and order fold behind the one counted Filters button; the arrangement switch stays.
    expect(view.query('refine:toolbar')).toBeNull();
    expect(button(toolbar, 'Filters: 2')).not.toBeNull();
    expect(toolbar.querySelector('[role="radiogroup"], [role="tablist"]')).not.toBeNull();
    view.unmount();
  });

  it('keeps its one row on a page beside the open Projects column, where the controls still fit', () => {
    const view = mount({
      search,
      header: toolbarHeader([]),
      renderPopover: openPopover,
    });
    // A 1440 window with the Projects column open leaves a plugin page about this wide (lab a2 draws one row).
    view.measure(1028);
    expect(view.query('refine:toolbar')).not.toBeNull();
    expect(button(view.query('toolbar')!, 'Filters: 2')).toBeNull();
    view.unmount();
  });

  it('gives up a healthy freshness\'s words before it gives up the one row, and keeps them one tap away', () => {
    const view = mount({ search, header: toolbarHeader([], { tone: 'muted', label: 'Updated 10 minutes ago' }), renderPopover: openPopover });
    view.measure(1120);
    const toolbar = view.query('toolbar')!;
    expect(toolbar.textContent).toContain('Updated 10 minutes ago');
    reportToolbarLayout(view, 'toolbar:lead', 0, 650, 36);
    reportToolbarLayout(view, 'toolbar', 0, 1000, 36);
    reportToolbarLayout(view, 'toolbar:trail', 0, 450, 32);
    expect(view.query('refine:toolbar')).not.toBeNull();
    expect(toolbar.textContent).not.toContain('Updated 10 minutes ago');
    // Without the words the row holds, and stays one row.
    reportToolbarLayout(view, 'toolbar:trail', 0, 300, 32);
    expect(view.query('refine:toolbar')).not.toBeNull();
    // Only a row that still does not fit folds.
    reportToolbarLayout(view, 'toolbar:trail', 0, 450, 32);
    expect(view.query('refine:toolbar')).toBeNull();
    view.unmount();
  });

  it('never hides a freshness that is warning the reader to keep the one row', () => {
    const view = mount({ search, header: toolbarHeader([], { tone: 'warning', label: 'Stale since 09:00' }), renderPopover: openPopover });
    view.measure(1120);
    reportToolbarLayout(view, 'toolbar:lead', 0, 650, 36);
    reportToolbarLayout(view, 'toolbar', 0, 1000, 36);
    reportToolbarLayout(view, 'toolbar:trail', 0, 450, 32);
    expect(view.query('refine:toolbar')).toBeNull();
    expect(view.query('toolbar')!.textContent).toContain('Stale since 09:00');
    view.unmount();
  });

  it('keeps the host\'s page actions on one line in the folded toolbar, not stacked under each other', () => {
    const header: CollectionProps<Entry>['header'] = (slots) => (
      <CollectionToolbar slots={{ ...slots, pageActions: <><Text testID="run-on">Run on</Text><Text testID="hide-column">Hide</Text></> }}
        lens={<Text testID="lens">My work</Text>} testID="toolbar" />
    );
    const view = mount({ search, header });
    view.measure(780);
    expect(getComputedStyle(view.query('run-on')!.parentElement!).flexDirection).toBe('row');
    expect(view.query('run-on')!.parentElement).toBe(view.query('hide-column')!.parentElement);
    view.unmount();
  });

  it('folds as soon as its one row no longer fits its real controls, not at a guessed width', () => {
    const view = mount({
      search,
      header: toolbarHeader([]),
      renderPopover: openPopover,
    });
    // Wider than the fold width, but this page's controls (a long freshness, Run on) need more than one row.
    view.measure(1120);
    expect(view.query('refine:toolbar')).not.toBeNull();
    const layout = (testID: string, y: number, height: number, width: number) => {
      reportToolbarLayout(view, testID, y, width, height);
    };
    layout('toolbar:lead', 0, 36, 650);
    // A shorter trailing group centred on the same line: the row is as tall as its taller group, one row.
    layout('toolbar:trail', 2, 32, 300);
    layout('toolbar', 0, 36, 1000);
    expect(view.query('refine:toolbar')).not.toBeNull();
    // Freshness makes the trailing cluster wider; the current widths no longer fit the same 1000px row.
    layout('toolbar:trail', 44, 32, 450);
    // A healthy freshness gives its words up first; the row lays out again without them and still does not fit.
    layout('toolbar:trail', 44, 32, 450);
    const toolbar = view.query('toolbar')!;
    expect(view.query('refine:toolbar')).toBeNull();
    expect(button(toolbar, 'Filters: 2')).not.toBeNull();
    // Narrowing and widening within what it already needed keeps the fold; it never flips back and forth.
    view.measure(1100);
    view.measure(1120);
    expect(view.query('refine:toolbar')).toBeNull();
    // A window wide enough for the row it needed gets the one row back once the folded row reports that room.
    view.measure(1440);
    act(() => (view.query('toolbar') as unknown as { __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void })
      .__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 80 } } }));
    expect(view.query('refine:toolbar')).not.toBeNull();
    view.unmount();
  });

  it('judges the fit by sizes, never by a position a group reported before it moved', () => {
    const view = mount({ search, header: toolbarHeader([]), renderPopover: openPopover });
    view.measure(1120);
    const layout = (testID: string, y: number, height: number) => {
      reportToolbarLayout(view, testID, y, testID === 'toolbar' ? 1120 : 400, height);
    };
    // The trailing group once sat under the leading one; it moved back up without resizing, so it said nothing more.
    // The row itself is one line tall: it fits, and the toolbar keeps its one row.
    layout('toolbar:trail', 44, 32);
    layout('toolbar:lead', 0, 36);
    layout('toolbar', 0, 36);
    expect(view.query('refine:toolbar')).not.toBeNull();
    view.unmount();
  });

  it('folds at the width its row wrapped at, never at a width the page reported before it narrowed', () => {
    const view = mount({ search, header: toolbarHeader([]), renderPopover: openPopover });
    view.measure(1300);
    expect(view.query('refine:toolbar')).not.toBeNull();
    const layout = (testID: string, y: number, height: number, width: number) => {
      reportToolbarLayout(view, testID, y, width, height);
    };
    // The window narrows: the wide row lays out at its new width and wraps before the page reports its own width.
    layout('toolbar:lead', 0, 36, 620);
    layout('toolbar:trail', 44, 32, 620);
    layout('toolbar', 0, 76, 620);
    view.measure(620);
    expect(view.query('refine:toolbar')).toBeNull();
    // Widened again, the folded row reports the room it now has: the one row comes back.
    view.measure(1300);
    layout('toolbar', 0, 80, 1300);
    expect(view.query('refine:toolbar')).not.toBeNull();
    view.unmount();
  });

  it('measures its one row again when the folded controls get shorter at the same width, and settles', async () => {
    const long = { tone: 'neutral' as const, label: 'Updated 4 minutes ago · 2 sources could not be read' };
    const view = mount({ search, header: toolbarHeader([], long), renderPopover: openPopover });
    view.measure(1120);
    const layout = (testID: string, y: number, height: number) => {
      reportToolbarLayout(view, testID, y, 400, height);
    };
    layout('toolbar:lead', 0, 36);
    layout('toolbar:trail', 44, 32);
    layout('toolbar', 0, 76);
    expect(view.query('refine:toolbar')).toBeNull();
    // The long freshness is gone: the controls the row needed room for got shorter, so the wide row is tried again.
    await view.update({ search, header: toolbarHeader([]), renderPopover: openPopover });
    expect(view.query('refine:toolbar')).not.toBeNull();
    // It still does not fit: its healthy freshness gives its words up, then it folds and stays folded while nothing shrinks.
    layout('toolbar:lead', 0, 36);
    layout('toolbar:trail', 44, 32);
    layout('toolbar', 0, 76);
    layout('toolbar', 0, 76);
    expect(view.query('refine:toolbar')).toBeNull();
    await view.update({ search, header: toolbarHeader([]), renderPopover: openPopover });
    expect(view.query('refine:toolbar')).toBeNull();
    view.unmount();
  });

  it('on a phone folds filters, order, freshness and refresh behind two round buttons, keeping the lens and the view switch', () => {
    const calls: string[] = [];
    const view = mount({
      search,
      header: toolbarHeader(calls),
      renderPopover: openPopover,
    });
    view.measure(390);
    const toolbar = view.query('toolbar')!;
    expect(toolbar.contains(view.query('search'))).toBe(true);
    expect(toolbar.contains(view.query('lens'))).toBe(true);
    expect(
      toolbar.querySelector('[role="radiogroup"], [role="tablist"]'),
    ).not.toBeNull();
    expect(view.query('refine:toolbar')).toBeNull();
    // Healthy freshness is quiet on a phone; the refresh icon leaves the row.
    expect(toolbar.textContent).not.toContain('Up to date');
    expect(button(toolbar, 'Refresh')).toBeNull();
    // On a phone the primary action is a round "+" beside Filters and ⋯, still named by its words.
    expect(button(toolbar, 'New task')!.textContent).toBe('');

    // The folded Filters: a named, counted button that opens the page's own narrowing form as the bottom sheet —
    // the same form the wide row opens, never a second set of checkbox groups.
    const filters = button(toolbar, 'Filters: 2')!;
    expect(filters).not.toBeNull();
    expect(filters.textContent).toBe('2');
    act(() => {
      filters.click();
    });
    const sheet = view.query('sheet')!;
    expect(sheet.getAttribute('aria-label')).toBe('Filters');
    expect(sheet.getAttribute('data-sheet-header')).toBe('none');
    expect(sheet.contains(view.query('refine:form'))).toBe(true);
    expect(sheet.querySelector('[role="menuitemcheckbox"], [role="menuitemradio"]')).toBeNull();
    // The form closes the sheet itself.
    act(() => {
      button(sheet, 'Show 3 results')!.click();
    });
    expect(calls).toEqual(['done']);
    expect(view.query('sheet')).toBeNull();
    calls.length = 0;

    // The folded More: Refresh, carrying the freshness, then the page's own items, as menu items.
    const more = button(toolbar, 'More')!;
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    act(() => {
      more.click();
    });
    const items = [
      ...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ];
    expect(items.map((item) => item.textContent)).toEqual([
      'RefreshUp to date',
      'Manage sources',
    ]);
    // The wide row's Order picker follows them, as a named radio group carrying the current choice.
    const order = [...view.container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(order.map((item) => [item.getAttribute('aria-label'), item.getAttribute('aria-checked')])).toEqual([
      ['Newest', 'true'],
      ['Oldest', 'false'],
    ]);
    expect(order[0]!.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Order');
    act(() => {
      order[1]!.click();
    });
    expect(calls).toEqual(['select:order:oldest']);
    calls.length = 0;
    act(() => {
      more.click();
    });
    act(() => {
      [...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]!.click();
    });
    expect(calls).toEqual(['refresh']);
    view.unmount();
  });

  it('on a phone keeps a stale list visible in the toolbar, not only inside a menu', () => {
    const view = mount({
      search,
      header: toolbarHeader([], {
        tone: 'warning',
        label: 'Showing the last known list',
        indicator: true,
      }),
      renderPopover: openPopover,
    });
    view.measure(390);
    expect(view.query('toolbar')!.textContent).toContain(
      'Showing the last known list',
    );
    view.unmount();
  });

  it('composes for a phone from the first frame when the host navigation shows the title', () => {
    const view = mount({
      search,
      header: toolbarHeader([]),
      pageChrome: { showsTitle: true },
    });
    expect(button(view.query('toolbar')!, 'Filters: 2')).not.toBeNull();
    expect(view.query('refine:toolbar')).toBeNull();
    view.unmount();
  });
});

describe('an ungrouped page list (a phone)', () => {
  const sort = {
    key: 'memory',
    direction: 'descending' as const,
    onChange: () => undefined,
  };
  const summaryRows = [
    {
      key: 'total',
      title: 'Happier in total',
      cells: { memory: '9.9 GB' },
      testID: 'procs:total',
    },
  ];

  it("keeps the table's header on its one sheet: what the rows are, their order, then the rows and totals", () => {
    const view = mountTree({
      presentation: 'list',
      scroll: 'page',
      ungrouped: true,
      sort,
      summaryRows,
    });
    view.measure(390);
    const bar = view.query('procs:sheet-header');
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain('Started by Happier');
    expect(view.query('procs:sort:memory')?.textContent).toContain('Memory');
    expect(view.query('procs:sort:memory:arrow')?.textContent).toBe('↓');
    // One sheet: the bar leads the rows and the totals inside the same sheet body.
    const sheetBody = bar!.parentElement!;
    expect(sheetBody.contains(view.rowElement(view.rows()[0]!))).toBe(true);
    expect(sheetBody.textContent).toContain('Happier in total');
    view.unmount();
  });

  it('leaves grouped and unsorted page lists to their section titles', () => {
    const grouped = mountTree({ presentation: 'list', scroll: 'page', sort });
    grouped.measure(390);
    expect(grouped.query('procs:sheet-header')).toBeNull();
    grouped.unmount();
    const unsorted = mountTree({
      presentation: 'list',
      scroll: 'page',
      ungrouped: true,
    });
    unsorted.measure(390);
    expect(unsorted.query('procs:sheet-header')).toBeNull();
    unsorted.unmount();
  });
});
