import * as React from 'react';
import { PluginUiSurfaceNoticeContext } from '../presentationHost/surfaceNotice.js';
import { DragSource } from './EntityDragDrop.js';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

const scrollCapture = vi.hoisted(() => ({
  offsets: [] as number[],
  reveals: [] as Array<Readonly<{ sectionIndex: number; itemIndex: number }>>,
  failNextReveal: false,
  contentSizeChange: null as null | ((width: number, height: number) => void),
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
        onContentSizeChange?: (width: number, height: number) => void;
        onScrollToIndexFailed?: (info: Readonly<{ averageItemLength: number; index: number }>) => void;
      }>,
    ) {
      scrollCapture.observe = props.onScroll ?? null;
      scrollCapture.contentSizeChange = props.onContentSizeChange ?? null;
      React.useImperativeHandle(
        props.ref,
        () => ({
          scrollToLocation(input: Readonly<{ sectionIndex: number; itemIndex: number }>) {
            // Native cannot resolve an offscreen index before its first cell measurement.
            if (scrollCapture.failNextReveal) {
              scrollCapture.failNextReveal = false;
              const precedingCells = props.sections.slice(0, input.sectionIndex)
                .reduce((count, section) => count + section.data.length + 2, 0);
              props.onScrollToIndexFailed?.({ averageItemLength: 0, index: precedingCells + input.itemIndex });
              return;
            }
            scrollCapture.reveals.push({ sectionIndex: input.sectionIndex, itemIndex: input.itemIndex });
          },
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
import { usePluginUiEphemeralSharedScope } from '../hostApi/context.js';
import type { PluginUiEphemeralSharedScope } from '../hostApi/ephemeralSharedScope.public.js';

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
  HostCollection as Collection,
  CollectionLoadingRows,
  type CollectionAnatomy,
  type CollectionProps,
  type CollectionRowActions,
} from './Collection.js';
import { CollectionToolbar, CollectionToolbarCompactContext } from './CollectionToolbar.js';
import { DetailsPaneFooter, useDetailPageLead } from './DetailsPane.js';
import { Button } from './Button.js';
import { Heading } from './Foundation.js';
import { usePluginUiFocusTarget } from './Focus.js';
import { PageHeader } from './PageHeader.js';
import { Tabs } from './Tabs.js';
import { HappierText } from '../presentation/text/Text.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { HappierColumnEdgeContext } from '../presentation/layout/columnEdge.js';
import { HappierPageSheet } from '../presentation/layout/PageSection.js';
import { HAPPIER_COLLECTION_LIST_METRICS } from '../presentation/collection/CollectionList.js';
import { capabilityCollectionAnatomy } from './Capabilities.js';
import { HappierCollectionNavigationBackClosesDetailContext } from '../presentation/collection/collectionLayout.js';
import {
  HappierCollectionRestingRowsContext,
  useHappierCollectionTableRow,
  type HappierCollectionRestingRows,
} from '../presentation/collection/CollectionList.js';
import { createListMultiSelectionStore } from './ListMultiSelection.js';
import { HAPPIER_PAGE_TEXT } from '../presentation/layout/pageText.js';
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
function createPaneHost(useAvailable = () => true) {
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
    useAvailable,
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
        {input.breadcrumb === undefined ? null : <Text testID="host-pane-breadcrumb">{input.breadcrumb.join(' › ')}</Text>}
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
  viewportScopeKey?: string;
  retainedRowKeys?: readonly string[];
  presentation?: 'table' | 'list' | 'board' | 'grid';
  items?: readonly Entry[];
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
  narrowGrid?: CollectionProps<Entry>['narrowGrid'];
  minCardWidth?: number;
  groupAction?: (
    groupKey: string,
  ) => Readonly<{ label: string; onPress: () => void }> | null;
  collapsedGroups?: ReadonlySet<string>;
  detailHeader?: (key: string) => Readonly<{
    title: string;
    subtitle?: string;
    breadcrumb?: readonly string[];
    actions?: React.ReactNode;
  }>;
  useDetailHeader?: CollectionProps<Entry>['useDetailHeader'];
  useRowActions?: CollectionProps<Entry>['useRowActions'];
  rowActionsAtRest?: CollectionProps<Entry>['rowActionsAtRest'];
  useRowItem?: CollectionProps<Entry>['useRowItem'];
  selection?: CollectionProps<Entry>['selection'];
  modelSelection?: (
    model: HappierCollectionModel<Entry>,
  ) => CollectionProps<Entry>['selection'];
  search?: CollectionProps<Entry>['search'];
  create?: CollectionProps<Entry>['create'];
  sort?: CollectionProps<Entry>['sort'];
  tableCells?: CollectionProps<Entry>['tableCells'];
  tableColumnSizing?: CollectionProps<Entry>['tableColumnSizing'];
  summaryRows?: CollectionProps<Entry>['summaryRows'];
  sheetAfter?: CollectionProps<Entry>['sheetAfter'];
  renderDetail?: CollectionProps<Entry>['renderDetail'];
  title?: CollectionProps<Entry>['title'];
  titleKind?: CollectionProps<Entry>['titleKind'];
  detailBackLabel?: CollectionProps<Entry>['detailBackLabel'];
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
  const sharedScope = usePluginUiEphemeralSharedScope();
  const model = useHappierCollection({
    items: props.items ?? entries,
    ...(props.viewportScopeKey === undefined ? {} : { retainedViewport: { scope: sharedScope, key: props.viewportScopeKey } }),
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
      useRowItem={props.useRowItem}
      {...(props.useRowActions === undefined
        ? {}
        : { useRowActions: props.useRowActions })}
      {...(props.rowActionsAtRest === undefined ? {} : { rowActionsAtRest: props.rowActionsAtRest })}
      {...(props.modelSelection === undefined
        ? props.selection === undefined
          ? {}
          : { selection: props.selection }
        : { selection: props.modelSelection(model) })}
      {...(props.search === undefined ? {} : { search: props.search })}
      {...(props.create === undefined ? {} : { create: props.create })}
      {...(props.sort === undefined ? {} : { sort: props.sort })}
      {...(props.tableCells === undefined ? {} : { tableCells: props.tableCells })}
      {...(props.tableColumnSizing === undefined ? {} : { tableColumnSizing: props.tableColumnSizing })}
      {...(props.summaryRows === undefined ? {} : { summaryRows: props.summaryRows })}
      {...(props.sheetAfter === undefined ? {} : { sheetAfter: props.sheetAfter })}
      {...(props.scroll === undefined ? {} : { scroll: props.scroll })}
      {...(props.retainedRowKeys === undefined ? {} : { retainedRowKeys: props.retainedRowKeys })}
      {...(props.narrowGrid === undefined ? {} : { narrowGrid: props.narrowGrid })}
      {...(props.minCardWidth === undefined ? {} : { minCardWidth: props.minCardWidth })}
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
      useDetailHeader={props.useDetailHeader}
      windowStatement="3 loaded · complete"
      {...(props.loading === undefined ? {} : { loading: props.loading })}
      {...(props.loadingRows === undefined ? {} : { loadingRows: props.loadingRows })}
      {...(props.empty === undefined ? {} : { empty: props.empty })}
      {...(props.afterRows === undefined ? {} : { afterRows: props.afterRows })}
      {...(props.header === undefined ? {} : { header: props.header })}
      {...(props.footer === undefined ? {} : { footer: props.footer })}
      {...(props.title === undefined ? {} : { title: props.title })}
      {...(props.titleKind === undefined ? {} : { titleKind: props.titleKind })}
      {...(props.detailBackLabel === undefined ? {} : { detailBackLabel: props.detailBackLabel })}
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
    surfaceNotice?: React.ContextType<typeof PluginUiSurfaceNoticeContext>;
    renderDestinationRow?: PluginUiPresentationHost['renderDestinationRow'];
    renderPopover?: PluginUiPresentationHost['renderPopover'];
    motion?: HappierCollectionMotionDriver;
    reducedMotion?: boolean;
    /** The reader's text size (1 = normal). */
    textScale?: number;
    dialog?: boolean;
    openKey?: string | null;
    pane?: ReturnType<typeof createPaneHost>;
    scrollTracker?: PluginUiScrollActivityTracker;
    pageChrome?: import('../presentation/layout/pageChrome.js').HappierPageChromeInternal;
    hostApiOverrides?: Parameters<typeof createHostApiStub>[1];
    ephemeralSharedScope?: PluginUiEphemeralSharedScope;
    /** The page edge the host's column already draws around the surface (a plugin page's gutter). */
    columnEdgePx?: number;
    /** The collection sits in a page section's sheet, after these rows (a notice above the table). */
    enclosingSheet?: Readonly<{ before?: React.ReactNode }>;
  }> &
    HarnessOptions = {},
) {
  const context = createSurfaceContext({
    reducedMotion: options.reducedMotion ?? false,
    ...(options.textScale === undefined ? {} : { textScale: options.textScale }),
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
  const content = () => (
    <>
      <PluginUiProviderInternal
        hostApi={hostApi}
        context={context}
        presentationHost={host}
        {...(options.ephemeralSharedScope === undefined ? {} : { ephemeralSharedScope: options.ephemeralSharedScope })}
      >
        <PluginUiSurfaceNoticeContext.Provider value={options.surfaceNotice ?? null}>
        <PluginUiScrollActivityProvider tracker={options.scrollTracker ?? null}>
          <HappierColumnEdgeContext.Provider value={options.columnEdgePx ?? 0}>
          {options.enclosingSheet === undefined ? (
            <Harness {...harness} openKey={openKey} onOpenChange={(key) => { openChanges.push(key); }} />
          ) : (
            <HappierPageSheet colors={{ sheet: '#ffffff', sheetBorder: '#d0d0d0', rowDivider: '#e0e0e0', groupDivider: '#eeeeee' }}>
              {options.enclosingSheet.before}
              <Harness {...harness} openKey={openKey} onOpenChange={(key) => { openChanges.push(key); }} />
            </HappierPageSheet>
          )}
          </HappierColumnEdgeContext.Provider>
        </PluginUiScrollActivityProvider>
        </PluginUiSurfaceNoticeContext.Provider>
      </PluginUiProviderInternal>
      <Slot />
    </>
  );
  const wrap = () => options.dialog ? <div role="dialog">{content()}</div> : content();
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

describe('Collection table', () => {
  it('draws an identifier title and its quiet lead alike in the table and the list (one route, one face)', async () => {
    const routes = { ...anatomy, title: (entry: Entry) => `/${entry.id}/:id`, titleLead: () => 'GET', titleIdentifier: true };
    const routeNode = () => [...document.querySelectorAll<HTMLElement>('div, span')]
      .find((node) => node.textContent === 'GET /a/:id' && node.querySelector('span') !== null && node.style.fontFamily !== '');
    const view = mount({ anatomy: routes, detail: 'none', reducedMotion: true });
    try {
      view.measure(1200);
      const table = routeNode();
      expect(table).toBeDefined();
      // The method is quiet text inside the title, in the title's own face.
      expect([...table!.querySelectorAll('span')].some((node) => node.textContent === 'GET ' && node.style.fontFamily === '')).toBe(true);
      view.measure(360);
      expect(routeNode()).toBeDefined();
    } finally {
      view.unmount();
    }
  });

  it('selects and edits the focused row field with the keyboard without opening the row', async () => {
    const onEdit = vi.fn(() => true);
    const onSelect = vi.fn();
    const anatomyWithField = { ...anatomy, columnsOverflow: 'scroll' as const, fields: [
      { key: 'subject', title: 'Subject', minWidth: 100, priority: 1, render: (item: Entry) => item.title },
    ] };
    const held = (columnKey: string | null) => ({ rowKey: 'a', columnKey });
    const view = mount({
      anatomy: anatomyWithField, detail: 'none', reducedMotion: true,
      tableCells: { selected: held(null), onSelect, onEdit },
    });
    try {
      view.measure(1200);
      const row = view.query('row:a')!;
      act(() => {
        row.focus();
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(held('subject'));
      await view.update({ tableCells: { selected: held('subject'), onSelect, onEdit } });
      act(() => {
        view.query('row:a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
      });
      expect(onEdit).toHaveBeenCalledExactlyOnceWith(held('subject'));
      expect(view.openChanges).toEqual([]);
    } finally {
      view.unmount();
    }
  });

  it('draws the selected cell on the focused row and carries its column when the focus moves rows', async () => {
    const onEdit = vi.fn(() => true);
    const onSelect = vi.fn();
    const anatomyWithField = { ...anatomy, columnsOverflow: 'scroll' as const, fields: [
      { key: 'subject', title: 'Subject', minWidth: 100, priority: 1, render: (item: Entry) => item.title },
    ] };
    const view = mount({
      anatomy: anatomyWithField, detail: 'none', reducedMotion: true,
      tableCells: { selected: null, onSelect, onEdit },
    });
    try {
      view.measure(1200);
      expect(view.container.querySelector('[data-testid$=":selected-cell"]')).toBeNull();
      await view.update({ tableCells: { selected: { rowKey: 'a', columnKey: 'subject' }, onSelect, onEdit } });
      const ringA = view.query('row:a:selected-cell');
      expect(ringA).not.toBeNull();
      expect(ringA!.closest('[data-testid="row:a"]')?.textContent).toContain('Retry idempotent payment intents');
      act(() => {
        const row = view.query('row:a')!;
        row.focus();
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      });
      expect(view.query('row:a:selected-cell')).toBeNull();
      expect(view.query('row:b:selected-cell')).not.toBeNull();
      act(() => {
        view.query('row:b')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
      });
      expect(onEdit).toHaveBeenCalledExactlyOnceWith({ rowKey: 'b', columnKey: 'subject' });
    } finally {
      view.unmount();
    }
  });

  it('commits a pointer resize once after displaying its preview', async () => {
    const onResizeEnd = vi.fn();
    const anatomyWithField = { ...anatomy, columnsOverflow: 'scroll' as const, fields: [
      { key: 'subject', title: 'Subject', minWidth: 100, priority: 1, render: (item: Entry) => item.title },
    ] };
    const view = mount({
      anatomy: anatomyWithField, detail: 'none', reducedMotion: true,
      tableColumnSizing: { widths: new Map([['subject', 220]]), onResizeEnd },
    });
    try {
      view.measure(1200);
      const handle = view.container.querySelector<HTMLElement>('[aria-label="Resize Subject"]');
      expect(handle).not.toBeNull();
      act(() => {
        handle!.dispatchEvent(new MouseEvent('pointerdown', { clientX: 320, bubbles: true, cancelable: true }));
      });
      await act(async () => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 368 }));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
      expect(handle!.getAttribute('aria-valuenow')).toBe('268');
      expect(onResizeEnd).not.toHaveBeenCalled();
      act(() => { window.dispatchEvent(new MouseEvent('pointerup')); });
      expect(onResizeEnd).toHaveBeenCalledExactlyOnceWith({ columnKey: 'subject', width: 268 });
      await view.update({ tableColumnSizing: { widths: new Map([['subject', 268]]), onResizeEnd } });
      expect(handle!.getAttribute('aria-valuenow')).toBe('268');
      act(() => {
        handle!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      });
      expect(onResizeEnd).toHaveBeenCalledTimes(2);
      expect(onResizeEnd).toHaveBeenLastCalledWith({ columnKey: 'subject', width: 276 });
    } finally {
      view.unmount();
    }
  });

  it('returns a column width only when its resize treatment submits an end intent', () => {
    const onResizeEnd = vi.fn();
    const anatomyWithField = { ...anatomy, columnsOverflow: 'scroll' as const, fields: [
      { key: 'subject', title: 'Subject', minWidth: 100, priority: 1, render: (item: Entry) => item.title },
    ] };
    const view = mount({
      anatomy: anatomyWithField, detail: 'none', reducedMotion: true,
      tableColumnSizing: {
        widths: new Map([['subject', 220]]),
        onResizeEnd,
        renderHandle: ({ columnKey, width, resizeEnd }) => columnKey === 'subject'
          ? <button aria-label="Resize Subject" onClick={() => resizeEnd(width + 25)} />
          : null,
      },
    });
    try {
      view.measure(1200);
      expect(onResizeEnd).not.toHaveBeenCalled();
      const resize = view.container.querySelector<HTMLButtonElement>('[aria-label="Resize Subject"]')!;
      act(() => { resize.click(); });
      expect(onResizeEnd).toHaveBeenCalledExactlyOnceWith({ columnKey: 'subject', width: 245 });
    } finally {
      view.unmount();
    }
  });

  it.each(['list', 'table'] as const)('starts a right-to-left %s row title on the page side, keeping its own reading order', (presentation) => {
    const title = 'تعطل تسجيل الدخول — QA-F fixture';
    const view = mount({ items: [{ ...entries[0]!, title }], presentation, detail: 'none', reducedMotion: true });
    try {
      view.measure(presentation === 'table' ? 1200 : 360);
      const titles = [...view.container.querySelectorAll<HTMLElement>('[dir="auto"]')].filter((node) => node.textContent === title);
      expect(titles.length).toBeGreaterThan(0);
      // An Arabic first word would otherwise take the far side of the LTR row (the text's own start).
      for (const node of titles) expect(node.style.textAlign).toBe('left');
    } finally {
      view.unmount();
    }
  });

  it('fulfills a route reveal after native content measurement when the first location is unmeasured', async () => {
    scrollCapture.reveals.length = 0;
    scrollCapture.failNextReveal = true;
    const outside = document.createElement('button');
    document.body.append(outside);
    act(() => { outside.focus(); });
    const view = mount({ items: entries, openKey: 'c', presentation: 'list', detail: 'none', reducedMotion: true });
    try {
      view.measure(1200);
      expect(scrollCapture.reveals).toEqual([]);
      act(() => { scrollCapture.contentSizeChange?.(1200, 900); });
      expect(scrollCapture.reveals).toEqual([{ sectionIndex: 1, itemIndex: 0 }]);
      expect(document.activeElement).toBe(outside);
      act(() => { scrollCapture.contentSizeChange?.(1200, 950); });
      expect(scrollCapture.reveals).toHaveLength(1);
      expect(view.openChanges).toEqual([]);
    } finally {
      scrollCapture.failNextReveal = false;
      outside.remove();
      view.unmount();
    }
  });

  it('reveals the route-open row on arrival without moving focus or the keyboard cursor', async () => {
    scrollCapture.reveals.length = 0;
    const view = mount({ items: entries.slice(0, 2), openKey: 'b', presentation: 'list', detail: 'none', reducedMotion: true });
    const outside = document.createElement('button');
    document.body.append(outside);
    try {
      act(() => { outside.focus(); });
      view.measure(1200);
      await act(async () => {});
      expect(scrollCapture.reveals).toEqual([{ sectionIndex: 0, itemIndex: 1 }]);
      expect(document.activeElement).toBe(outside);
      act(() => { view.query('row:a')!.focus(); });
      act(() => { outside.focus(); });
      const rowA = view.query('row:a')!;
      expect(rowA.tabIndex).toBe(0);
      await view.setOpen('c');
      expect(scrollCapture.reveals).toHaveLength(1);
      await view.update({ items: entries });
      await act(async () => {});
      expect(scrollCapture.reveals).toEqual([
        { sectionIndex: 0, itemIndex: 1 },
        { sectionIndex: 1, itemIndex: 0 },
      ]);
      expect(document.activeElement).toBe(outside);
      expect(view.query('row:a')!.tabIndex).toBe(0);
      expect(view.query('row:c')!.tabIndex).toBe(-1);
      await view.update({ items: [...entries] });
      expect(scrollCapture.reveals).toHaveLength(2);
      expect(view.openChanges).toEqual([]);
    } finally {
      outside.remove();
      view.unmount();
    }
  });
  it('keeps a stacked Board header in its page scroll owner with independently mounted controls', async () => {
    let mounts = 0;
    function BoardHeader() {
      const [edited, setEdited] = React.useState(false);
      React.useEffect(() => { mounts += 1; }, []);
      return <button data-testid="board-header-control" onClick={() => setEdited(true)}>{edited ? 'Edited note' : 'Edit note'}</button>;
    }
    const view = mount({ presentation: 'board', boardLayout: 'stacked', detail: 'none', scroll: 'page', header: <BoardHeader /> });
    try {
      view.measure(390);
      const control = view.query('board-header-control');
      expect(control).not.toBeNull();
      expect(scroller(control)).not.toBeNull();
      expect(scroller(control)).toBe(scroller(view.query('row:a')));
      await act(async () => control!.click());
      await view.update({ items: entries.map(entry => ({ ...entry })) });
      expect(view.query('board-header-control')).toBe(control);
      expect(control!.textContent).toBe('Edited note');
      expect(mounts).toBe(1);
      expect(view.openChanges).toEqual([]);
    } finally { view.unmount(); }
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
  it.each([true, false])('windows a catalog directory by line in its columns and reveals keyboard focus (grouped: %s)', async (grouped) => {
    const listeners = new Set<() => void>();
    let window = { top: 0, bottom: 600 };
    const offsets: number[] = [];
    const tracker: PluginUiScrollActivityTracker & { scrollToOffset(offset: number): void } = {
      onScroll() {}, onLayout() {}, onContentSizeChange() {}, invalidateLayout() {},
      getLayoutRevision: () => 0,
      getWindow: () => window,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      measureSpan: async () => ({ top: 0 }),
      scrollToOffset: (offset) => {
        offsets.push(offset);
        window = { top: offset, bottom: offset + 600 };
        listeners.forEach((listener) => listener());
      },
    };
    const catalog = Array.from({ length: 241 }, (_, index): Entry => ({
      id: `item-${index}`, title: `Server ${index}`, group: index < 120 ? 'needs' : 'rest', repo: '', reason: '', age: '',
    }));
    const view = mount({
      items: catalog,
      grouped,
      presentation: 'list',
      scroll: 'page-virtualized',
      scrollTracker: tracker,
      detail: 'none',
      anatomy: { ...anatomy, rowRole: 'catalogRow', description: (entry) => `What ${entry.title} does` },
      selection: { single: { value: 'item-0', onValueChange() {} } },
    });
    try {
      view.measure(1440);
      await act(async () => {});
      const mounted = () => view.container.querySelectorAll('[role="radio"]').length;
      expect(mounted()).toBeGreaterThan(0);
      expect(mounted()).toBeLessThan(catalog.length / 4);
      expect(view.query('row:item-240')).toBeNull();
      // Row-major columns hold under windowing: a line is two neighbouring rows, in reading order.
      const lineOf = (key: string) => view.query(`row:${key}`)!.closest('[data-testid="collection:directory-line"]');
      expect(lineOf('item-0')).not.toBeNull();
      expect(lineOf('item-0')).toBe(lineOf('item-1'));
      expect(lineOf('item-2')).not.toBe(lineOf('item-0'));
      // The last row is an odd one out (241 rows, two columns, in one section when ungrouped): it stands in its column.
      await act(async () => {
        view.query('row:item-0')!.focus();
        view.query('row:item-0')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
      });
      expect(offsets.at(-1)).toBeGreaterThan(600);
      expect(document.activeElement).toBe(view.query('row:item-240'));
      expect(mounted()).toBeLessThan(catalog.length / 4);
      // One column when two cannot fit: a row per line, and the focused row stays mounted through the recomposition.
      const focused = view.query('row:item-240');
      view.measure(500);
      await act(async () => {});
      expect(view.query('row:item-240')).toBe(focused);
      expect(document.activeElement).toBe(focused);
      expect(lineOf('item-240')).toBeNull();
    } finally {
      view.unmount();
    }
  });
  it('windows a sheet-sectioned page list without losing its sections, dividers or keyboard reach', async () => {
    const listeners = new Set<() => void>();
    let window = { top: 0, bottom: 800 };
    const tracker: PluginUiScrollActivityTracker & { scrollToOffset(offset: number): void } = {
      onScroll() {}, onLayout() {}, onContentSizeChange() {}, invalidateLayout() {},
      getLayoutRevision: () => 0,
      getWindow: () => window,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      measureSpan: async () => ({ top: 0 }),
      scrollToOffset: (offset) => {
        window = { top: offset, bottom: offset + 800 };
        listeners.forEach((listener) => listener());
      },
    };
    const catalog = Array.from({ length: 300 }, (_, index): Entry => ({
      id: `w-${index}`, title: `Workflow ${index}`, group: index < 200 ? 'needs' : 'rest', repo: '', reason: '', age: '',
    }));
    const view = mount({
      items: catalog,
      grouped: true,
      presentation: 'list',
      scroll: 'page-virtualized',
      scrollTracker: tracker,
      detail: 'none',
      retainedRowKeys: ['w-250'],
      selection: { single: { value: 'w-0', onValueChange() {} } },
    });
    try {
      view.measure(1000);
      await act(async () => {});
      const mounted = () => view.container.querySelectorAll('[role="radio"]').length;
      // The rows stand on the page's own sheets, never in the collection scroller.
      expect(view.query('virtualizer')).toBeNull();
      expect(mounted()).toBeGreaterThan(0);
      expect(mounted()).toBeLessThan(catalog.length / 4);
      expect(view.query('row:w-299')).toBeNull();
      // The retained row stands far outside the first viewport, in its own place.
      expect(view.query('row:w-250')).not.toBeNull();
      // Both groups keep their headings, each with its own sheet of rows.
      expect(view.container.textContent).toContain('Needs');
      // Keyboard reach: End lands focus on the last row even though it was not mounted.
      await act(async () => {
        view.query('row:w-0')!.focus();
        view.query('row:w-0')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(view.query('row:w-299'));
      expect(mounted()).toBeLessThan(catalog.length / 4);
      // A row a live interaction anchors to stays mounted wherever the viewport moves.
      expect(view.query('row:w-250')).not.toBeNull();
    } finally {
      view.unmount();
    }
  });
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
  it.each([['table', 1440], ['list', 390], ['grid', 1440]] as const)(
    'holds a pending title in %s as the shared skeleton, never a word, while the rest of the row is live',
    async (presentation, width) => {
      const view = mount({
        presentation,
        anatomy: { ...anatomy, titlePending: (entry) => entry.id === 'a' },
      });
      try {
        view.measure(width);
        const pending = view.query('row:a:title-pending');
        expect(pending).not.toBeNull();
        expect(view.container.textContent).not.toContain(entries[0]!.title);
        // The row still names its item to assistive tech, and its neighbours keep their titles.
        expect(view.query('row:a')?.getAttribute('aria-label') ?? '').toContain(entries[0]!.title);
        expect(view.container.textContent).toContain(entries[2]!.title);
        expect(view.query('row:c:title-pending')).toBeNull();
      } finally {
        view.unmount();
      }
    },
  );

  it.each(['list', 'table', 'board', 'grid'] as const)(
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
  it('restores a logical Collection viewport when returning through another page mount', async () => {
    // Separate page mounts borrow from the same host-owned plugin occurrence.
    const retainedValues = new Map<string, unknown>();
    const ephemeralSharedScope: PluginUiEphemeralSharedScope = {
      acquire<T>(key: string, create: () => Readonly<{ value: T; retainWhenIdle?: true }>) {
        const retained = retainedValues.get(key) as T | undefined;
        if (retained !== undefined) return { value: retained, release() {} };
        const created = create();
        return { value: created.value, release() {
          if (created.retainWhenIdle) retainedValues.set(key, created.value);
        } };
      },
    };
    const options = { presentation: 'list' as const, detail: 'none' as const, ephemeralSharedScope };
    const standalone = mount({ ...options, viewportScopeKey: 'tasks:mine' });
    try {
      standalone.measure(1440);
      act(() => scrollCapture.observe!({ nativeEvent: { contentOffset: { y: 350 } } }));
    } finally {
      standalone.unmount();
    }
    const beforeReviews = scrollCapture.offsets.length;
    const canonical = mount({ ...options, viewportScopeKey: 'reviews' });
    try {
      canonical.measure(1440);
      expect(scrollCapture.offsets.slice(beforeReviews)).not.toContain(350);
      act(() => scrollCapture.observe!({ nativeEvent: { contentOffset: { y: 17 } } }));
      const before = scrollCapture.offsets.length;
      await canonical.update({ viewportScopeKey: 'tasks:mine' });
      expect(scrollCapture.offsets.slice(before)).toContain(350);
    } finally {
      canonical.unmount();
    }
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

  it('sizes each grid card to its own content: nothing inside a card grows', async () => {
    // React Native's Yoga errata stretch a growing child of a wrapped grid row to the whole grid's height, so every
    // card took the full grid height with its content centred (iOS "Start from an example" looked empty). The web
    // stacks it correctly, so the contract is checked at its cause: nothing inside a card grows.
    const view = mount({ presentation: 'grid', grouped: false, detail: 'none' });
    try {
      view.measure(700);
      const row = view.query('row:a')!;
      const growing: string[] = [];
      for (let node: HTMLElement | null = row; node !== null && node.getAttribute('data-testid') !== 'collection'; node = node.parentElement) {
        // Only height growth stretches a card: a grow along a row parent fills width, which is fine.
        const parent = node.parentElement;
        const growsInHeight = parent !== null && !getComputedStyle(parent).flexDirection.startsWith('row');
        if (getComputedStyle(node).flexGrow === '1' && growsInHeight && parent?.getAttribute('data-testid')?.endsWith(':grid-row') !== true) {
          growing.push(node.getAttribute('data-testid') ?? `${node.getAttribute('role') ?? node.tagName}:${(node.getAttribute('style') ?? '').slice(0, 120)}`);
        }
        if (node.getAttribute('data-testid')?.endsWith(':grid-row')) break;
      }
      expect(growing).toEqual([]);
    } finally {
      view.unmount();
    }
  });

  it('marks a single-choice grid card by its ring alone, keeping the card own glyph', async () => {
    // A visual picker's chosen card wears the ring; a radio beside it said the same fact twice (Themes library).
    const view = mount({
      presentation: 'grid',
      grouped: false,
      detail: 'none',
      anatomy: { ...anatomy, glyph: (entry) => <Text testID={`glyph:${entry.id}`}>•</Text> },
      selection: { single: { value: 'a', onValueChange() {} } },
    });
    try {
      view.measure(700);
      expect(view.query('glyph:a')).not.toBeNull();
      expect(view.query('row:a:selected')).not.toBeNull();
      expect(view.query('row:b:selected')).toBeNull();
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

  // DBW review R5 M2: a pushed detail's way back names the list it returns to, not a bare Back glyph.
  it('names the list a pushed detail returns to', async () => {
    const view = mount({ detailBackLabel: 'Traces', renderDetail: (key) => <Text testID={`detail:${key}`} value={`Detail ${key}`} /> });
    try {
      view.measure(390);
      act(() => { view.query('row:b')!.click(); });
      await view.setOpen('b');
      expect(view.query('detail:b')).not.toBeNull();
      const back = [...document.querySelectorAll<HTMLElement>('[role="button"], button')]
        .find((node) => node.textContent === 'Traces');
      expect(back).toBeDefined();
      act(() => { back!.click(); });
      expect(view.openChanges.at(-1)).toBeNull();
    } finally {
      view.unmount();
    }
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
      const onAction = vi.fn<NonNullable<CollectionRowActions['onSecondaryAction']>>((id) => { actions.push(id); });
      const queries: string[] = [];
      const view = mount({
        presentation,
        detail: 'none',
        useRowActions: () => ({
          secondaryActions: [{ id: 'pin', label: 'Pin' }],
          onSecondaryAction: onAction,
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
      const trigger = view.container.querySelector('[aria-haspopup="menu"][aria-expanded="true"]');
      expect(trigger).not.toBeNull();
      act(() => {
        pin!.click();
      });
      expect(actions).toEqual(['pin']);
      const selection = onAction.mock.calls[0]?.[1];
      const anchor = selection?.anchorRef?.current;
      expect(anchor instanceof HTMLElement && anchor.contains(trigger)).toBe(true);
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
      matches: query === '(pointer: fine)' || query === '(hover: hover)',
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
      ) => ({ matches: query === '(pointer: fine)' || query === '(hover: hover)' });
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

  // DESIGN-1118-B M1: on touch a table row's actions overlaid its last column (the cells kept the row's full width).
  // A table keeps the ⋯ in the cell its header reserves, out of sight at rest, on every pointer.
  it("keeps a touch table row's actions in their reserved cell, out of sight at rest, never over the last column", () => {
    const matchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
    const viewportWidth = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1440 });
    window.dispatchEvent(new Event('resize'));
    (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false });
    const view = mount({
      presentation: 'table',
      detail: 'none',
      anatomy: { ...anatomy, peek: undefined },
      useRowActions: () => ({
        secondaryActions: [{ id: 'pin', label: 'Pin' }],
        onSecondaryAction: () => undefined,
      }),
    });
    try {
      view.measure(1440);
      const trigger = view.container.querySelector<HTMLElement>('[aria-label="More actions"]')!;
      const row = view.query('row:a')!;
      const along = (read: (node: HTMLElement) => string, skip: string) => {
        for (let node: HTMLElement | null = trigger; node !== null && node !== row; node = node.parentElement) {
          const value = read(node);
          if (value !== '' && value !== skip) return value;
        }
        return skip;
      };
      const overlaid = () => {
        for (let node: HTMLElement | null = trigger; node !== null && node !== row; node = node.parentElement) {
          if (getComputedStyle(node).position === 'absolute') return true;
        }
        return false;
      };
      expect(overlaid()).toBe(false);
      expect(along((node) => getComputedStyle(node).opacity, '1')).toBe('0');
    } finally {
      view.unmount();
      (globalThis as { matchMedia?: unknown }).matchMedia = matchMedia;
      if (viewportWidth) Object.defineProperty(document.documentElement, 'clientWidth', viewportWidth);
      else Reflect.deleteProperty(document.documentElement, 'clientWidth');
      window.dispatchEvent(new Event('resize'));
    }
  });

  // A collection of few rows that people act on (a storage pane's files, lab storage-view-1119 fixes 2, 11, 12) shows
  // each row's ⋯ at rest on every pointer, laid out in the row (never overlaying its end); the default is unchanged.
  it.each([
    ['table', 1440, true],
    ['list', 390, true],
    ['list', 390, false],
  ] as const)("shows a %s row's actions at rest when the Collection asks for them (width %s, precise pointer %s)", (presentation, width, precise) => {
    const matchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
    const viewportWidth = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
    window.dispatchEvent(new Event('resize'));
    (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
      matches: precise && (query === '(pointer: fine)' || query === '(hover: hover)'),
    });
    const view = mount({
      presentation,
      detail: 'none',
      anatomy: { ...anatomy, peek: undefined },
      rowActionsAtRest: true,
      useRowActions: () => ({
        secondaryActions: [{ id: 'pin', label: 'Pin' }],
        onSecondaryAction: () => undefined,
      }),
    });
    try {
      view.measure(width);
      const row = view.query('row:a')!;
      const trigger = view.container.querySelector<HTMLElement>('[aria-label="More actions"]')!;
      expect(trigger).not.toBeNull();
      let item: HTMLElement = row;
      while (!item.contains(trigger)) item = item.parentElement!;
      const along = (read: (node: HTMLElement) => string, skip: string) => {
        for (let node: HTMLElement | null = trigger; node !== null && node !== item; node = node.parentElement) {
          const value = read(node);
          if (value !== '' && value !== skip) return value;
        }
        return skip;
      };
      // Drawn at rest, with nothing hovered, focused, selected or open.
      expect(along((node) => getComputedStyle(node).opacity, '1')).toBe('1');
      // In the row's flow: the row's end keeps a place for it instead of the ⋯ covering the row's last figure.
      expect(along((node) => getComputedStyle(node).position, 'static')).not.toBe('absolute');
    } finally {
      view.unmount();
      (globalThis as { matchMedia?: unknown }).matchMedia = matchMedia;
      if (viewportWidth) Object.defineProperty(document.documentElement, 'clientWidth', viewportWidth);
      else Reflect.deleteProperty(document.documentElement, 'clientWidth');
      window.dispatchEvent(new Event('resize'));
    }
  });

  it("gives a resting list's rows the full width on a precise pointer: the actions overlay the row's end, revealed by hover", () => {
    const matchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
    (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
      matches: query === '(pointer: fine)' || query === '(hover: hover)',
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

  it("recomposes a narrow resting row's wrapping accessory under its title, keeping the ⋯ on the title line", () => {
    const pressed: string[] = [];
    const view = mount({
      presentation: 'list',
      detail: 'none',
      useRowActions: (entry) => ({
        accessoryWraps: true,
        accessory: (
          <Button testID={`badge:${entry.id}`} title="Needs you" onPress={() => pressed.push(entry.id)} />
        ),
        secondaryActions: [{ id: 'pin', label: 'Pin' }],
        onSecondaryAction: () => undefined,
      }),
    });
    const lowestCommonAncestor = (a: HTMLElement, b: HTMLElement) => {
      let node: HTMLElement = a;
      while (!node.contains(b)) node = node.parentElement!;
      return node;
    };
    const parts = () => {
      const row = view.query('row:a')!;
      let item: HTMLElement = row;
      const badge = view.query('badge:a')!;
      while (!item.contains(badge) || item.querySelector('[aria-label="More actions"]') === null) item = item.parentElement!;
      const title = [...item.querySelectorAll<HTMLElement>('div')].find(
        (node) => node.textContent === 'Retry idempotent payment intents',
      )!;
      const glyph = [...item.querySelectorAll<HTMLElement>('div')].find((node) => node.textContent === '•')!;
      const trigger = item.querySelector<HTMLElement>('[aria-label="More actions"]')!;
      return { item, badge, title, glyph, trigger };
    };
    view.measure(390);
    const narrow = parts();
    // Under the title, in the text column: the title's and the badge's nearest shared node holds neither the
    // row's mark (so the badge never starts under it) nor the ⋯ (which keeps its own trailing cell).
    const textColumn = lowestCommonAncestor(narrow.title, narrow.badge);
    expect(textColumn.contains(narrow.glyph)).toBe(false);
    expect(textColumn.contains(narrow.trigger)).toBe(false);
    // Nothing on the ⋯'s way up to the row wraps: it stays pinned at the title line's end.
    for (let node = narrow.trigger.parentElement; node !== null && node !== narrow.item; node = node.parentElement)
      expect(getComputedStyle(node).flexWrap).not.toBe('wrap');
    // The badge stays its own control: pressing it never opens the row.
    act(() => {
      narrow.badge.click();
    });
    expect(pressed).toEqual(['a']);
    expect(view.openChanges).toEqual([]);
    // A wide row keeps the accessory at its end, beside the ⋯.
    view.measure(1440);
    const wide = parts();
    expect(lowestCommonAncestor(wide.badge, wide.trigger).contains(wide.title)).toBe(false);
    view.unmount();
  });

  // TH-VISUAL-ACCEPT-17 N1 (Machines → Presets, live 1440): a row whose owner offers no actions reserved no ⋯ place
  // in a list that draws columns, so its figures started 40 px right of the header and of the rows that carry a ⋯.
  it("keeps a row without actions on the ⋯ rows' grid: its reserved place stands in the same trailing cell", () => {
    const { peek: _peek, ...rowWithoutPeek } = anatomy;
    const view = mount({
      presentation: 'list', scroll: 'page', detail: 'none',
      anatomy: { ...rowWithoutPeek, byline: (entry) => entry.repo,
        fields: [{ key: 'age', title: 'Age', render: (entry) => entry.age, minWidth: 64, priority: 1, align: 'end', listColumn: true }] },
      grouping: { ...groups, axis: groups.axis.map((group) => ({ ...group, section: { key: 'all', title: 'All work' } })) },
      useRowActions: (entry) => entry.id === 'a'
        ? { secondaryActions: [{ id: 'pin', label: 'Pin' }], onSecondaryAction: () => undefined }
        : {},
    });
    try {
      view.measure(1200);
      const trigger = view.query('row:a:cell')!.querySelector<HTMLElement>('[aria-label="More actions"]')!;
      const reserved = [...view.query('row:b:cell')!.querySelectorAll<HTMLElement>('[aria-hidden="true"]')]
        .find((node) => getComputedStyle(node).width === '28px')!;
      expect(trigger).not.toBeNull();
      expect(reserved).toBeDefined();
      // Both trailing places stand beside the row's press target, not inside it.
      expect(view.query('row:a')!.contains(trigger)).toBe(false);
      expect(view.query('row:b')!.contains(reserved)).toBe(false);
      // And both keep the row's trailing inset, so the cells before them end on one edge.
      const trailingInset = (node: HTMLElement, row: HTMLElement) => {
        for (let cell: HTMLElement | null = node; cell !== null && !cell.contains(row); cell = cell.parentElement) {
          const inset = getComputedStyle(cell).paddingInlineEnd || getComputedStyle(cell).paddingRight;
          if (inset !== '' && inset !== '0px') return inset;
        }
        return '0px';
      };
      expect(trailingInset(reserved, view.query('row:b')!)).toBe(trailingInset(trigger, view.query('row:a')!));
      // TH-REPLAY-191 row 6: the cells' own content keeps the same end padding before that cell, or the reserved row's
      // figures stand 7 px right of the ⋯ rows' (a page row's 15 against the table's 8).
      const contentEnd = (id: string) => getComputedStyle(view.query(`row:${id}:column:age`)!.parentElement!).paddingRight;
      expect(contentEnd('b')).toBe(contentEnd('a'));
    } finally {
      view.unmount();
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
        wrapItem: (entry, children) => (
          <View testID={`menu-wrapper:${entry.id}`}>{children}</View>
        ),
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
    expect(view.query('menu-wrapper:a')?.contains(view.query('row:a'))).toBe(true);
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
      try {
        view.measure(1440);
        expect(
          view.query('destination-row:a')?.contains(view.query('core-row:a')),
        ).toBe(true);
        expect(
          view.query('core-row:a')?.contains(view.query('row:a')),
        ).toBe(true);
        act(() => view.query('row:a')!.click());
        expect(view.openChanges).toEqual(['a']);
      } finally {
        view.unmount();
      }
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

  it('keeps Signal and gives up the Agent column first when the table cannot hold both', () => {
    const facts: CollectionAnatomy<Entry> = {
      ...anatomy,
      signal: () => 'SIGNAL-CELL',
      agent: () => 'AGENT-CELL',
      columnTitles: { ...anatomy.columnTitles, signal: 'Signal', agent: 'Agent' },
    };
    const table = mount({ presentation: 'table', anatomy: facts, peek: false } as never);
    table.measure(980);
    const text = table.query('virtualizer')?.textContent ?? '';
    expect(text).toContain('SIGNAL-CELL');
    expect(text).not.toContain('AGENT-CELL');
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

  it('keeps an empty group that has something to say, with its count at 0 and one quiet line', () => {
    const quiet: readonly Entry[] = entries.filter((entry) => entry.group === 'rest');
    const grouping = {
      axis: [
        { key: 'needs', title: 'Needs you', emptyStatement: 'Nothing needs you right now.' },
        { key: 'other', title: 'With an agent' },
        { key: 'rest', title: 'Everything else' },
      ],
      groupOf: (entry: Entry) => entry.group,
    };
    for (const [presentation, width] of [['table', 1440], ['list', 390]] as const) {
      const view = mount({ items: quiet, grouping, presentation, detail: 'none' });
      view.measure(width);
      const text = view.query('virtualizer')?.textContent ?? '';
      expect(text).toContain('Needs you');
      expect(text).toContain('Nothing needs you right now.');
      expect(text.indexOf('Nothing needs you right now.')).toBeLessThan(text.indexOf('Everything else'));
      expect(text).not.toContain('With an agent');
      view.unmount();
    }
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

  // Owner 2026-11-19 (COMPETITOR-1118, BOARD 14:17Z; it reverses WAVE-ACCEPT-1117C's bare, ruled index table): a table on
  // its page, page-scrolled or not, sits in one bordered sheet, and its groups are filled bands inside it.
  const chromeBetween = (from: HTMLElement, stage: HTMLElement) => {
    const found: string[] = [];
    for (let node: HTMLElement | null = from; node !== null && node !== stage.parentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.borderTopWidth !== '' && style.borderTopWidth !== '0px') found.push(`border ${style.borderTopWidth}`);
      if (style.backgroundColor !== '' && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') {
        found.push(`fill ${style.backgroundColor}`);
      }
    }
    return found;
  };

  it('sits a page table in one bordered sheet, a group title on a filled band inside it', () => {
    const view = mount({ scroll: 'page' });
    try {
      view.measure(1440);
      const stage = view.query('collection:stage')!;
      const band = view.container.querySelector<HTMLElement>('[aria-label="Needs you"]')!;
      const around = chromeBetween(band, stage);
      expect(around.some((entry) => entry.startsWith('border'))).toBe(true);
      expect(around.filter((entry) => entry.startsWith('fill')).length).toBeGreaterThanOrEqual(2);
    } finally {
      view.unmount();
    }
  });

  it('sits a wide ungrouped page list in its sheet, where a phone lays it flat', () => {
    const view = mount({ presentation: 'list', scroll: 'page', grouped: false });
    try {
      const borders = () => {
        const stage = view.query('collection:stage')!;
        const firstRow = view.container.querySelector<HTMLElement>('[data-testid^="row:"]')!;
        return chromeBetween(firstRow.parentElement!, stage).filter((entry) => entry.startsWith('border'));
      };
      view.measure(1440);
      expect(borders()).not.toEqual([]);
      view.measure(390);
      expect(borders()).toEqual([]);
    } finally {
      view.unmount();
    }
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

  it('names the add key on a desktop table and runs it from C, never from a field', async () => {
    let created = 0;
    const view = mount({
      create: { hint: 'new task', onPress: () => { created += 1; } },
      search: { label: 'Search', value: '', onValueChange: () => {}, testID: 'search' },
    });
    view.measure(1440);
    expect(view.query('collection:hints')!.textContent).toContain('new task');
    const press = (target: HTMLElement) => act(async () => {
      target.focus();
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true }));
    });
    await press(view.query('search')!);
    expect(created).toBe(0);
    await press(view.query('row:a')!);
    expect(created).toBe(1);
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
  it('does not offer escape to a table for a dialog-hosted list', () => {
    const view = mount({ dialog: true, presentation: 'list', openKey: 'a' });
    view.measure(1440);
    expect(view.query('collection')!.closest('[role="dialog"]')).not.toBeNull();
    const hints = view.query('collection:hints');
    expect(hints).not.toBeNull();
    expect(hints!.textContent).toContain('close');
    expect(hints!.textContent).not.toContain('table');
    view.unmount();
  });

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

  it('lets a pushed detail carry its hosted title in its own story, so the title scrolls away with the page', async () => {
    // Lab merged-detail-*-phone: the title leads the story and scrolls with it; no second, fixed title band.
    function Story(props: Readonly<{ itemKey: string }>) {
      const lead = useDetailPageLead();
      return <View testID="detail-story">{lead}<Text testID={`detail:${props.itemKey}`}>{`Detail ${props.itemKey}`}</Text></View>;
    }
    const view = mount({
      detailHeader: (key) => ({ title: `Entry ${key}` }),
      renderDetail: (key) => <Story itemKey={key} />,
    });
    view.measure(390);
    await view.setOpen('a');
    const detail = view.query('collection-detail')!;
    const headings = [...detail.querySelectorAll('[role="heading"]')].filter((node) => node.textContent === 'Entry a');
    expect(headings).toHaveLength(1);
    expect(view.query('detail-story')!.contains(headings[0]!)).toBe(true);
    view.unmount();
  });

  it('keeps the way back in the band and the one title in the story, never a second title in the band', async () => {
    // Live READY150 (390): with the title in the story, the band lost its Back. DESIGN-LIVE-225: the band then also
    // repeated the title the story shows (lab merged-detail-pr phone: "‹ PRs & Issues" alone above the large title).
    const backs: Array<(() => void) | null> = [];
    const titles: Array<string | undefined> = [];
    function Story(props: Readonly<{ itemKey: string }>) {
      const lead = useDetailPageLead();
      return <View testID="detail-story">{lead}<Text testID={`detail:${props.itemKey}`}>{`Detail ${props.itemKey}`}</Text></View>;
    }
    const view = mount({
      detailHeader: (key) => ({ title: `Entry ${key}` }),
      renderDetail: (key) => <Story itemKey={key} />,
      pageChrome: { showsTitle: true, publishBack: (press) => { backs.push(press); }, publishTitle: (title) => { titles.push(title); } },
    });
    view.measure(390);
    await view.setOpen('a');
    expect(typeof backs.at(-1)).toBe('function');
    expect(titles.filter((title) => title !== undefined)).toEqual([]);
    const detail = view.query('collection-detail')!;
    const headings = [...detail.querySelectorAll('[role="heading"]')].filter((node) => node.textContent === 'Entry a');
    expect(headings).toHaveLength(1);
    expect(view.query('detail-story')!.contains(headings[0]!)).toBe(true);
    expect(detail.textContent?.split('Entry a').length).toBe(2);
    view.unmount();
  });

  it.each([
    ['pushed, the page itself', 390, 0],
    ['beside the list, a column of its own', 1200, HAPPIER_PAGE_METRICS.sheetInsetPx],
  ] as const)('stands a hosted detail\'s body on the page edge once when %s', async (_label, width, ownInsetPx) => {
    // A plugin page's host column already draws the page edge (PluginPageContent): the pushed detail is that page and
    // adds nothing; beside the list the detail is a new column and draws the edge itself (DESIGN-LIVE-225: 16 + 16).
    function Story(props: Readonly<{ itemKey: string }>) {
      return (
        <View testID="detail-story">
          <Text testID={`detail:${props.itemKey}`}>{`Detail ${props.itemKey}`}</Text>
          <DetailsPaneFooter testID="detail-footer"><Text>Fix with Claude</Text></DetailsPaneFooter>
        </View>
      );
    }
    const view = mount({
      columnEdgePx: HAPPIER_PAGE_METRICS.sheetInsetPx,
      presentation: 'list',
      detailHeader: (key) => ({ title: `Entry ${key}` }),
      renderDetail: (key) => <Story itemKey={key} />,
    });
    view.measure(width);
    await view.setOpen('a');
    const detail = view.query('collection-detail')!;
    let insetPx = 0;
    for (let node: HTMLElement | null = view.query('detail-story'); node !== null && node !== detail; node = node.parentElement) {
      insetPx += Number.parseFloat(node.style.paddingLeft || '0') || 0;
    }
    expect(insetPx).toBe(ownInsetPx);
    // The pinned footer reaches back across exactly the body's own padding, so it spans the detail, never past it.
    expect(-(Number.parseFloat(view.query('detail-footer')!.style.marginLeft || '0') || 0) || 0).toBe(ownInsetPx);
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
        breadcrumb: ['tidewater/checkout-web', `#${key}`],
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
    // The item's place above its title travels to the host band with the rest of its identity.
    expect(view.query('host-pane-breadcrumb')?.textContent).toBe('tidewater/checkout-web › #b');
    act(() => {
      view.query('header-action')!.click();
    });
    expect(acted).toEqual(['b']);
    view.unmount();
  });

  it('keeps the hosted Files panel and its selected detail through phone width and landscape (QB55)', async () => {
    let beside = true;
    const pane = createPaneHost(() => beside);
    function Detail(props: Readonly<{ pushed: boolean }>) {
      const [panel, setPanel] = React.useState('overview');
      return (
        <View testID="selected-detail">
          <Text testID="detail-presentation">{props.pushed ? 'page' : 'pane'}</Text>
          <Tabs value={panel} onValueChange={setPanel} ariaLabel="Entry detail"
            presentation="page" pageKind={{ pluginId: 'happier.test', localId: 'entry' }}
            phonePresented={props.pushed}>
            <Tabs.Item value="overview" title="Overview"><Text>Entry overview</Text></Tabs.Item>
            <Tabs.Item value="files" title="Files"><Text testID="files-panel">src/index.ts</Text></Tabs.Item>
          </Tabs>
        </View>
      );
    }
    const view = mount({ pane, renderDetail: (_key, { pushed }) => <Detail pushed={pushed} /> });
    try {
      view.measure(1440, 960);
      await view.setOpen('b');
      await act(async () => view.container.querySelector<HTMLElement>('[role="tab"][aria-label="Files"]')!.click());
      const detail = view.query('selected-detail');
      const files = view.query('files-panel');
      expect(detail).not.toBeNull();
      expect(files).not.toBeNull();
      for (const [width, height, besidePage] of [[900, 960, true], [390, 960, false], [320, 960, false],
        [844, 390, true], [1440, 960, true]] as const) {
        beside = besidePage;
        await view.update({});
        view.measure(width, height);
        expect(view.query('selected-detail')).toBe(detail);
        expect(view.query('files-panel')).toBe(files);
        expect(view.query('detail-presentation')?.textContent).toBe(besidePage ? 'pane' : 'page');
      }
    } finally {
      view.unmount();
    }
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
  it('keeps a narrow capability description beside an independent toggle, yielding only to the actual status fix', () => {
    const toggle = vi.fn();
    const fix = vi.fn();
    const capabilityAnatomy = capabilityCollectionAnatomy<Entry>({
      title: entry => entry.title,
      description: entry => `Description for ${entry.id}`,
      facts: () => ({}),
      status: entry => entry.id === 'a' ? { kind: 'offline' }
        : { kind: 'signin', fix: { kind: 'sign_in', onPress: fix } },
      action: () => <Button title="Enable" onPress={toggle} testID="independent-toggle" />,
      accessibilityLabel: entry => `${entry.title}. Description for ${entry.id}`,
      testID: entry => `row:${entry.id}`,
    });
    const view = mount({ presentation: 'list', grouped: false, items: entries.slice(0, 2), anatomy: capabilityAnatomy });
    view.measure(300);
    // Layout is a native boundary: deliver its measured narrow width to the real public row subtree.
    act(() => {
      for (const cell of view.queryAll('row:a:cell').concat(view.queryAll('row:b:cell'))) {
        for (const node of cell.querySelectorAll<HTMLElement>('div')) {
          const host = node as HTMLElement & { __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void };
          host.__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 80 } } });
        }
      }
    });
    try {
      expect(view.query('row:a:cell')!.textContent).toContain('Description for a');
      expect(view.query('row:b:cell')!.textContent).not.toContain('Description for b');
      expect(view.query('row:b')!.getAttribute('aria-label')).toContain('Description for b');
      act(() => view.query('independent-toggle')!.click());
      act(() => view.query('row:b:status:fix')!.click());
      expect(toggle).toHaveBeenCalledOnce();
      expect(fix).toHaveBeenCalledOnce();
    } finally { view.unmount(); }
  });

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

  it('keeps author and version facts visible in catalog rows with a description', () => {
    const view = mount({ presentation: 'list', scroll: 'page', detail: 'none', anatomy: {
      ...described, rowRole: 'catalogRow',
      byline: () => <Text testID="catalog-release-facts">Ana · 1.2.3</Text>,
    } });
    try {
      view.measure(1440);
      expect(view.query('row:a')!.textContent).toContain('Ana · 1.2.3');
      view.measure(390);
      expect(view.query('row:a')!.textContent).toContain('Ana · 1.2.3');
    } finally { view.unmount(); }
  });

  function textOrder(row: HTMLElement, needles: readonly string[]): number[] {
    const text = row.textContent ?? '';
    return needles.map((needle) => text.indexOf(needle));
  }

  it('selects catalog anatomy for described collections, retaining full text with status before description', () => {
    const view = mount({ presentation: 'list', anatomy: described });
    try {
      view.measure(1440);
      const withStatus = view.query('row:a')!;
      const [title, meta, description, status, facts] = textOrder(withStatus, [
        'Retry idempotent payment intents',
        'Everywhere a',
        'What Retry',
        'Review requested',
        'payments-api',
      ]);
      expect(title).toBeGreaterThanOrEqual(0);
      expect(meta).toBeGreaterThan(title);
      expect(description).toBeGreaterThan(meta);
      expect(status).toBeGreaterThan(meta);
      expect(description).toBeGreaterThan(status);
      expect(withStatus.getAttribute('aria-label')).toContain('What Retry idempotent payment intents does');
      expect(facts).toBeGreaterThan(description);
      expect(view.query('facts:a')?.textContent).toBe('payments-api');
      expect(view.query('status:a')).not.toBeNull();

      const quiet = view.query('row:c')!;
      const [quietDescription, quietFacts] = textOrder(quiet, ['What Dark mode', 'mobile']);
      expect(quietDescription).toBeGreaterThanOrEqual(0);
      expect(quietFacts).toBeGreaterThan(quietDescription);
      expect(view.query('facts:c')?.textContent).toBe('mobile');
      expect(view.query('meta:c')).not.toBeNull();
    } finally { view.unmount(); }
  });

  it('keeps a missing-description peer in the same catalog anatomy', () => {
    const view = mount({ presentation: 'list', anatomy: {
      ...described,
      kindLabel: () => 'MCP server',
      description: entry => entry.id === 'c' ? null : `What ${entry.title} does`,
    } });
    try {
      view.measure(1440);
      expect(view.query('row:c')!.textContent).toContain('Dark mode date picker');
      expect(view.query('row:a')!.textContent).toContain('MCP server');
      expect(view.query('row:c')!.textContent).toContain('MCP server');
      expect(view.query('facts:c')?.textContent).toBe('mobile');
      expect(view.query('row:c')!.textContent).not.toContain('What Dark mode');
    } finally { view.unmount(); }
  });

  it('shows a caller-supplied kind in catalog rows only', () => {
    const kindAnatomy = { ...described, kindLabel: () => 'MCP server' };
    const catalog = mount({ presentation: 'list', anatomy: kindAnatomy });
    catalog.measure(1440);
    expect(catalog.query('row:a')!.textContent).toContain('MCP server');
    catalog.unmount();
    const compact = mount({ presentation: 'list', anatomy: { ...kindAnatomy, rowRole: 'item' } });
    compact.measure(1440);
    expect(compact.query('row:a')!.textContent).not.toContain('MCP server');
    compact.unmount();
  });

  it.each(['item', 'menu'] as const)('retains explicit %s anatomy for a described collection', rowRole => {
    const view = mount({ presentation: 'list', anatomy: { ...described, rowRole } });
    view.measure(1440);
    expect(view.query('facts:c')).not.toBeNull();
    expect(view.query('row:c')!.textContent).toContain('What Dark mode');
    view.unmount();
  });

  it('updates mounted catalog rows when the declared role changes', async () => {
    const kindAnatomy = { ...described, kindLabel: () => 'MCP server' };
    const view = mount({ presentation: 'list', anatomy: kindAnatomy });
    try {
      view.measure(1440);
      const row = view.query('row:c');
      expect(row!.textContent).toContain('MCP server');
      expect(view.query('facts:c')?.textContent).toBe('mobile');
      await view.update({ anatomy: { ...kindAnatomy, rowRole: 'item' } });
      expect(view.query('row:c')).toBe(row);
      expect(row!.textContent).not.toContain('MCP server');
      expect(view.query('facts:c')?.textContent).toBe('mobile');
      await view.update({ anatomy: kindAnatomy });
      expect(view.query('row:c')).toBe(row);
      expect(row!.textContent).toContain('MCP server');
      expect(view.query('facts:c')?.textContent).toBe('mobile');
    } finally { view.unmount(); }
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

  it('keeps the catalog action independently reachable beside an open detail', async () => {
    const invoke = vi.fn();
    const view = mount({ presentation: 'list', anatomy: { ...described,
      action: entry => <Button title={`Add ${entry.id}`} testID={`action:${entry.id}`} onPress={() => invoke(entry.id)} />,
    } });
    view.measure(1440);
    expect(view.query('action:b')).not.toBeNull();
    await view.setOpen('b');
    expect(visible(view.query('collection-detail'))).toBe(true);
    expect(view.query('action:a')).not.toBeNull();
    await act(async () => { view.query('action:a')!.click(); });
    expect(invoke).toHaveBeenCalledWith('a');
    expect(view.openChanges).toEqual([]);
    view.unmount();
  });
});

describe('render scope', () => {
  it.each([['peek-0', 'peek-1'], ['peek-249', 'peek-499']])('renders only the toggled row when table Peeks open and close (%s, %s)', (first, second) => {
    // The existing heavy Workflow Library fixture holds 500 rows.
    const items = Array.from({ length: 500 }, (_, index): Entry => ({
      ...entries[0]!, id: `peek-${index}`, title: `Workflow ${index}`,
      group: index < 250 ? 'needs' : 'rest',
    }));
    const renders = new Map<string, number>();
    const useRowActions = (item: Entry): CollectionRowActions => {
      renders.set(item.id, (renders.get(item.id) ?? 0) + 1);
      return {};
    };
    const view = mount({ items, useRowActions, reducedMotion: true });
    try {
      view.measure(1440);
      const sibling = view.query('row:peek-1');
      for (const [key, expanded] of [[first, true], [second, true], [first, false], [second, false]] as const) {
        renders.clear();
        act(() => { view.query(`row:${key}:peek`)!.click(); });
        expect(view.query(`row:${key}:peek`)?.getAttribute('aria-expanded')).toBe(String(expanded));
        expect(view.query(`peek-content:${key}`) !== null).toBe(expanded);
        expect(renders.get(key)).toBeGreaterThan(0);
        expect(renders.get(key)).toBeLessThanOrEqual(2);
        expect([...renders.keys()].filter(id => id !== key)).toEqual([]);
        expect(view.query('row:peek-1')).toBe(sibling);
      }
    } finally { view.unmount(); }
  // Rendering 500 real RNW rows and four interactions exceeded Vitest's 5s default.
  }, 30_000);
  it.each([false, true])('publishes the selected header below the container (host pane: %s)', async (inPane) => {
    let title = 'Open entry';
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const read = () => title;
    function useDetailHeader() {
      return { title: React.useSyncExternalStore(subscribe, read, read) };
    }
    const header = vi.fn(() => null);
    const rows = vi.fn((): CollectionRowActions => ({}));
    const view = mount({ openKey: 'a', useDetailHeader, header, useRowActions: rows,
      ...(inPane ? { pane: createPaneHost() } : {}), reducedMotion: true });
    try {
      view.measure(inPane ? 1440 : 560);
      expect(view.container.textContent).toContain('Open entry');
      header.mockClear();
      rows.mockClear();
      await act(async () => { title = 'Closed entry'; for (const listener of listeners) listener(); });
      expect(view.container.textContent).toContain('Closed entry');
      expect(view.container.textContent).not.toContain('Open entry');
      expect(header).not.toHaveBeenCalled();
      expect(rows).not.toHaveBeenCalled();
    } finally { view.unmount(); }
  });
  it.each(['table', 'board', 'grid'] as const)('publishes same-key row facts without rendering the %s container or siblings', async (presentation) => {
    const held = new Map(entries.map(item => [item.id, item]));
    const listeners = new Map<string, Set<() => void>>();
    const renders = new Map<string, number>();
    const header = vi.fn(() => null);
    function useRowItem(item: Entry): Entry {
      const subscribe = React.useCallback((listener: () => void) => {
        const rowListeners = listeners.get(item.id) ?? new Set<() => void>();
        listeners.set(item.id, rowListeners);
        rowListeners.add(listener);
        return () => { rowListeners.delete(listener); };
      }, [item.id]);
      const read = React.useCallback(() => held.get(item.id)!, [item.id]);
      return React.useSyncExternalStore(subscribe, read, read);
    }
    const useRowActions = (item: Entry): CollectionRowActions => {
      renders.set(item.id, (renders.get(item.id) ?? 0) + 1);
      return {};
    };
    const publish = (item: Entry) => {
      held.set(item.id, item);
      for (const listener of listeners.get(item.id) ?? []) listener();
    };
    const view = mount({ presentation, useRowItem, useRowActions, header });
    try {
      view.measure(1440);
      if (presentation === 'table') {
        await act(async () => { view.query('row:a:peek')!.click(); });
        expect(view.query('peek-content:a')?.textContent).toContain(entries[0]!.title);
      }
      renders.clear();
      header.mockClear();
      const sibling = view.query('row:b');
      const changed = { ...entries[0]!, title: 'Closed after native write' };
      await act(async () => { publish(changed); });
      expect(view.container.textContent).toContain(changed.title);
      expect(view.query('row:a')?.getAttribute('aria-label')).toBe(changed.title);
      if (presentation === 'table') expect(view.query('peek-content:a')?.textContent).toContain(changed.title);
      expect(renders.get('a')).toBe(1);
      expect([...renders].filter(([key]) => key !== 'a')).toEqual([]);
      expect(header).not.toHaveBeenCalled();
      expect(view.query('row:b')).toBe(sibling);
      renders.clear();
      await act(async () => { publish(changed); });
      expect([...renders]).toEqual([]);
      expect(header).not.toHaveBeenCalled();
      // Structural ownership stays with the model: removing a key still removes its row.
      await view.update({ items: entries.filter(item => item.id !== 'a') });
      expect(view.query('row:a')).toBeNull();
      expect(view.query('row:b')).toBe(sibling);
    } finally { view.unmount(); }
  });
  it.each([false, true])('executes zero unchanged rows in a 500-item page list while divider membership is unchanged (totals: %s)', async (totals) => {
    // The heavy Workflow Library fixture that exposed this broadcast holds 500 rows.
    const items = Array.from({ length: 500 }, (_, index): Entry => ({
      ...entries[0]!, id: `window-${index}`, title: `Workflow ${index}`,
      group: index < 250 ? 'needs' : 'rest',
    }));
    const renders = new Map<string, number>();
    const useRowActions: NonNullable<CollectionProps<Entry>['useRowActions']> = item => {
      renders.set(item.id, (renders.get(item.id) ?? 0) + 1);
      return {};
    };
    const single = { value: 'window-0', onValueChange: () => undefined };
    const view = mount({
      items, presentation: 'list', scroll: 'page', useRowActions,
      selection: { single },
      ...(totals ? { summaryRows: [{ key: 'total', title: 'Total', cells: {} }] } : {}),
    });
    try {
      view.measure(390);
      const selected = view.query('row:window-0')!;
      const unchanged = view.query('row:window-1');
      act(() => selected.focus());
      renders.clear();
      const changed = items.map(item => item.id === 'window-0' ? { ...item, title: 'Updated workflow' } : item);
      await view.update({ items: changed });
      expect(view.query('row:window-0')?.textContent).toContain('Updated workflow');
      expect(renders.get('window-0')).toBe(1);
      expect([...renders].reduce((sum, [key, count]) => sum + (key === 'window-0' ? 0 : count), 0)).toBe(0);
      expect(view.query('row:window-1')).toBe(unchanged);
      expect(view.query('row:window-0')).toBe(selected);
      expect(selected.getAttribute('aria-checked')).toBe('true');
      expect(document.activeElement).toBe(selected);

      renders.clear();
      await view.update({ items: [...changed] });
      expect([...renders]).toEqual([]);
    } finally { view.unmount(); }
  });
  it.each([[1, ['low', 'mid', 'high']], [1.5, ['mid', 'high']]] as const)(
    'admits listColumn fields by their total at text scale %s: the lowest priority gives way and the title keeps its minimum',
    (textScale, shown) => {
      const field = (key: string, priority: number) => ({ key, title: key, render: (entry: Entry) => entry.age, minWidth: 120, priority,
        listColumn: true as const });
      const view = mount({
        presentation: 'list', scroll: 'page', textScale,
        anatomy: { ...anatomy, byline: (entry) => entry.repo, fields: [field('low', 1), field('mid', 2), field('high', 3)] },
        grouping: { ...groups, axis: groups.axis.map((group) => ({ ...group, section: { key: 'all', title: 'All work' } })) },
      });
      try {
        // Wide enough for every column at normal text; at 1.5x the columns alone would leave the title no room.
        view.measure(700);
        expect(['low', 'mid', 'high'].filter((key) => view.query(`row:a:column:${key}`) !== null)).toEqual(shown);
        // The bar names exactly the admitted columns.
        const bar = view.query('collection:sheet-header')?.textContent ?? '';
        for (const key of ['low', 'mid', 'high']) expect(bar.includes(key), key).toBe((shown as readonly string[]).includes(key));
      } finally { view.unmount(); }
    },
  );
  it('admits listColumn fields after the rows\' ⋯ slot: the title keeps its minimum beside the row action', () => {
    // Presets (live 1440): the admission ignored the 40 pt ⋯ slot, so every column stayed and the names fell to 82 pt.
    const field = (key: string, priority: number) => ({ key, title: key, render: (entry: Entry) => entry.age, minWidth: 120, priority,
      listColumn: true as const });
    const shownAt = (withActions: boolean) => {
      const view = mount({
        presentation: 'list', scroll: 'page',
        anatomy: { ...anatomy, peek: undefined, byline: (entry) => entry.repo, fields: [field('low', 1), field('mid', 2), field('high', 3)] },
        grouping: { ...groups, axis: groups.axis.map((group) => ({ ...group, section: { key: 'all', title: 'All work' } })) },
        ...(withActions ? { useRowActions: () => ({ secondaryActions: [{ id: 'pin', label: 'Pin' }], onSecondaryAction: () => undefined }) } : {}),
      });
      try {
        // Title floor 120 + three 120 columns + their gaps + the row's insets and mark: 610 fits only without the ⋯.
        view.measure(610);
        return ['low', 'mid', 'high'].filter((key) => view.query(`row:a:column:${key}`) !== null);
      } finally { view.unmount(); }
    };
    expect(shownAt(false)).toEqual(['low', 'mid', 'high']);
    expect(shownAt(true)).toEqual(['mid', 'high']);
  });
  it('names list columns over their figures when each row ends in its ⋯: the bar keeps the rows\' action slot', () => {
    // A Services row: no peek chevron, so the ⋯ is the row's only end control.
    const { peek: _peek, ...rowWithoutPeek } = anatomy;
    const columnsAnatomy: CollectionAnatomy<Entry> = {
      ...rowWithoutPeek,
      byline: (entry) => entry.repo,
      fields: [{ key: 'age', title: 'Age', render: (entry) => entry.age, minWidth: 64, priority: 1, align: 'end', listColumn: true }],
    };
    const barEnd = (withActions: boolean) => {
      const view = mount({
        presentation: 'list', scroll: 'page', anatomy: columnsAnatomy,
        grouping: { ...groups, axis: groups.axis.map((group) => ({ ...group, section: { key: 'all', title: 'All work' } })) },
        ...(withActions ? { useRowActions: () => ({ secondaryActions: [{ id: 'pin', label: 'Pin' }], onSecondaryAction: () => undefined }) } : {}),
      });
      try {
        view.measure(1200);
        return Number.parseFloat(getComputedStyle(view.query('collection:sheet-header')!).paddingRight);
      } finally { view.unmount(); }
    };
    // Services → Apps (live 1440): every head stood 40 px right of its figures, the State head over the ⋯. A row's ⋯
    // slot is the action's 28 pt cell plus its 12 pt end inset; the bar keeps the same slot after its last head.
    expect(barEnd(true) - barEnd(false)).toBe(40);
  });
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
  it('leads a row\'s second line with the state word its anatomy names, on one line with the byline after a separator', () => {
    const view = mount({
      presentation: 'list', scroll: 'page',
      anatomy: {
        ...anatomy,
        byline: (entry) => entry.repo,
        // The anatomy says when the state leads (here: a phone row, where no State column says it).
        bylineLead: (entry, layout) => entry.id === 'a' && layout?.fieldColumns !== true
          ? <Text testID={`lead:${entry.id}`}>Failed</Text> : null,
      },
    });
    try {
      view.measure(390);
      const lead = view.query('lead:a')!;
      expect(lead).not.toBeNull();
      // The state word (in its own unshrinking frame) and the byline after it share one line.
      expect(lead.parentElement!.parentElement!.textContent).toBe('Failed· payments-api');
      // A row with no lead keeps its byline as it was.
      expect(view.query('lead:c')).toBeNull();
      expect(view.query('row:c')?.textContent).not.toContain('·');
    } finally { view.unmount(); }
  });
  it('keeps an element line after a state word inside the row\'s trailing inset: its frame gives way and clips', () => {
    // A phone Checks row: "Not checked since …" leads, then a run of bars that cannot shrink (r11-f3-checks-390).
    const view = mount({
      presentation: 'list', scroll: 'page',
      anatomy: {
        ...anatomy,
        byline: (entry) => <View testID={`bars:${entry.id}`} style={{ width: 600, flexShrink: 0 }} />,
        bylineLead: (entry, layout) => entry.id === 'a' && layout?.fieldColumns !== true
          ? <Text testID={`lead:${entry.id}`}>Not checked since Nov 15, 4:26 PM</Text> : null,
      },
    });
    try {
      view.measure(390);
      const lead = view.query('lead:a')!;
      const line = lead.parentElement!.parentElement!;
      const bars = view.query('bars:a')!;
      // Between the line and the bars sits one frame that shrinks to what is left of the row and clips the rest.
      let frame: HTMLElement | null = bars.parentElement;
      const frames: HTMLElement[] = [];
      while (frame !== null && frame !== line) { frames.push(frame); frame = frame.parentElement; }
      const clipping = frames.find((node) => getComputedStyle(node).overflowX === 'hidden');
      expect(clipping).toBeDefined();
      expect(getComputedStyle(clipping!).flexShrink).toBe('1');
      expect(getComputedStyle(clipping!).minWidth).toBe('0px');
    } finally { view.unmount(); }
  });
  it.each([[390, false], [1200, true]] as const)('a shared sheet band at %ipx keeps its name on line 1 and its fact with its action %s on the same line', (width, sameLine) => {
    const view = mount({
      presentation: 'list', scroll: 'page',
      grouping: { ...groups, axis: [{ key: 'needs', title: 'Needs you', description: "Couldn't read services" }, { key: 'rest', title: 'Everything else' }]
        .map((group) => ({ ...group, section: { key: 'all', title: '' } })) },
      groupAction: (key) => key === 'needs' ? { kind: 'link', label: 'Retry', onPress: () => undefined } : null,
    });
    try {
      view.measure(width);
      // The deepest element saying exactly this (a middle-ellipsized title is two runs inside it).
      const leaf = (text: string) => [...view.container.querySelectorAll('*')].filter((node) => node.textContent?.replace(/\s/gu, ' ') === text)
        .find((node) => ![...node.children].some((child) => child.textContent?.replace(/\s/gu, ' ') === text));
      const title = leaf('Needs you')!;
      const retry = leaf('Retry')!;
      expect(title).toBeDefined();
      expect(retry).toBeDefined();
      // A phone row puts what the band shares and its action on line 2 (DESIGN "Phones recompose"); wide, one line.
      expect(title.parentElement!.contains(retry)).toBe(sameLine);
      // The band (a phone's sub-heading, a wide table sheet's filled band) holds its name, its fact and its action,
      // and none of its rows.
      let band: HTMLElement | null = title.parentElement;
      while (band !== null && !band.contains(retry)) band = band.parentElement;
      expect(band?.textContent).toContain("Couldn't read services");
      expect(band?.textContent).not.toContain('Retry idempotent payment intents');
    } finally { view.unmount(); }
  });
  it('keeps the focused row mounted when a windowed shared sheet recomposes for a phone', async () => {
    const tracker: PluginUiScrollActivityTracker = {
      onScroll() {},
      onLayout() {},
      onContentSizeChange() {},
      invalidateLayout() {},
      getLayoutRevision: () => 0,
      getWindow: () => null,
      subscribe: () => () => {},
      measureSpan: async () => ({ top: 0 }),
    };
    const view = mount({
      presentation: 'list', scroll: 'page', scrollTracker: tracker,
      grouping: { ...groups, axis: groups.axis.map((group) => ({ ...group, section: { key: 'all', title: '' } })) },
      anatomy: { ...anatomy, fields: [{ key: 'memory', title: 'Memory', minWidth: 64, priority: 1, listColumn: true,
        render: () => '64 MB' }] },
    });
    try {
      view.measure(900);
      await act(async () => {});
      const row = view.query('row:b')!;
      expect(view.query('row:b:column:memory')).not.toBeNull();
      await act(async () => { row.focus(); });
      expect(document.activeElement).toBe(row);
      view.measure(390);
      await act(async () => {});
      expect(view.query('row:b:column:memory')).toBeNull();
      expect(view.query('row:b') === row).toBe(true);
      expect(document.activeElement).toBe(row);
      view.measure(900);
      await act(async () => {});
      expect(view.query('row:b:column:memory')).not.toBeNull();
      expect(view.query('row:b') === row).toBe(true);
      expect(document.activeElement).toBe(row);
    } finally { view.unmount(); }
  });
  it('draws an empty list column cell as the table does: a quiet dash, never a blank', () => {
    const view = mount({
      presentation: 'list', scroll: 'page',
      anatomy: { ...anatomy, fields: [{ key: 'memory', title: 'Memory', minWidth: 64, priority: 1, align: 'end', listColumn: true,
        render: (entry) => entry.id === 'a' ? '64 MB' : null }] },
    });
    try {
      view.measure(1200);
      expect(view.query('row:a:column:memory')?.textContent).toBe('64 MB');
      expect(view.query('row:b:column:memory')?.textContent).toBe('—');
    } finally { view.unmount(); }
  });
  it('leaves a control list column empty on a row without the control (a missing step is not a missing value)', () => {
    const view = mount({
      presentation: 'list', scroll: 'page',
      anatomy: { ...anatomy, fields: [{ key: 'next', title: '', minWidth: 88, priority: 1, align: 'end', listColumn: true, control: true,
        render: (entry) => entry.id === 'a' ? 'Retry' : null }] },
    });
    try {
      view.measure(1200);
      expect(view.query('row:a:column:next')?.textContent).toBe('Retry');
      expect(view.query('row:b:column:next')?.textContent).toBe('');
    } finally { view.unmount(); }
  });
  it('leads a shared sheet with an untitled group under no sub-heading of its own', () => {
    const view = mount({
      presentation: 'list', scroll: 'page',
      // The untitled group's rows lead the sheet; the titled group keeps its sub-heading.
      grouping: { ...groups, axis: [{ key: 'needs', title: '' }, { key: 'rest', title: 'Everything else' }]
        .map((group) => ({ ...group, section: { key: 'all', title: '' } })) },
    });
    try {
      // A phone's shared sheet (wider, the list is a table in one sheet whose groups are bands: owner 2026-11-19).
      view.measure(390);
      // The sheet both groups share: the nearest ancestor of a row of each.
      let sheet = view.query('row:a')!.parentElement!;
      while (!sheet.contains(view.query('row:c'))) sheet = sheet.parentElement!;
      const subHeadings = [...sheet.querySelectorAll('[role="group"][aria-label]')].map((group) => group.getAttribute('aria-label'));
      expect(subHeadings).toContain('Everything else');
      expect(subHeadings).not.toContain('');
    } finally { view.unmount(); }
  });
  it.each([false, true])('publishes real divider membership changes even when the membership size is unchanged (totals: %s)', async totals => {
    const items = [...entries, { ...entries[2]!, id: 'd' }];
    const view = mount({
      items, presentation: 'list', scroll: 'page',
      ...(totals ? { summaryRows: [{ key: 'total', title: 'Total', cells: {} }] } : {}),
    });
    try {
      view.measure(390);
      // Page-list cells paint their own row rule. A grid row still has no semantic separator (C77).
      const hasDivider = (key: string) => view.query(`row:${key}:cell`)!
        .querySelector('[data-testid="happier-list-row-rule"]') !== null;
      expect(view.container.querySelector('[role="row"] [role="separator"]')).toBeNull();
      expect(hasDivider('a')).toBe(true);
      expect(hasDivider('b')).toBe(totals);
      expect(hasDivider('c')).toBe(true);
      expect(hasDivider('d')).toBe(false);
      // Reordering the final two rows keeps the Set's size but changes which row ends the sheet.
      await view.update({ items: [items[0]!, items[1]!, items[3]!, items[2]!] });
      expect(hasDivider('c')).toBe(false);
      expect(hasDivider('d')).toBe(true);
      // Switching between separate section sheets and one totals sheet changes the group boundary.
      await view.update({ summaryRows: totals ? [] : [{ key: 'total', title: 'Total', cells: {} }] });
      expect(hasDivider('b')).toBe(!totals);
      await view.update({ items: entries });
      expect(view.query('row:d')).toBeNull();
      expect(hasDivider('c')).toBe(false);
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
  it('lets a long authored title wrap whole instead of truncating it (lab phone list, FIN-QA-LARGETEXT T1)', () => {
    const view = mount();
    view.measure(360);
    const row = view.query('row:a')!;
    const title = [...row.querySelectorAll<HTMLElement>('[dir="auto"]')].find(
      (node) => node.textContent === 'Retry idempotent payment intents',
    )!;
    expect(title).toBeDefined();
    // Never clamped: the row grows with the name (ST-5), as a catalog name does.
    expect(['', 'none']).toContain(getComputedStyle(title).webkitLineClamp ?? title.style.webkitLineClamp ?? '');
    view.unmount();
  });

  it('keeps a record name the anatomy marks as truncating on one line with an end ellipsis, in the body face', () => {
    const view = mount({ anatomy: { ...anatomy, titleTruncates: true } });
    view.measure(360);
    const row = view.query('row:a')!;
    const title = [...row.querySelectorAll<HTMLElement>('[dir="auto"]')].find(
      (node) => node.textContent === 'Retry idempotent payment intents',
    )!;
    expect(title).toBeDefined();
    const style = getComputedStyle(title);
    // One line, cut at its end: a file name ("checkout-bug-repro.mov") never breaks mid-word across two lines.
    expect(style.webkitLineClamp === '1' || style.whiteSpace === 'nowrap' || title.style.webkitLineClamp === '1').toBe(true);
    // Not an identifier: the name keeps the body face, never the mono one.
    expect(style.fontFamily).not.toMatch(/mono/i);
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

  it("stands the resting list on the page's text edge: group label and row mark on it, the title one page row column after (PHONE-GEOMETRY-1110)", () => {
    // The Collection stands on the column's sheet edge. A flat list's text sits on the page text edge just inside
    // it (lab phone-system: label and mark 18, title 50), not on the sheet edge (Machines measured 16 / 51).
    const textEdge = HAPPIER_PAGE_METRICS.pageTextInsetPx - HAPPIER_PAGE_METRICS.sheetInsetPx;
    const marked: CollectionAnatomy<Entry> = { ...anatomy, glyph: (entry) => <Text testID={`mark:${entry.id}`}>•</Text> };
    const view = mount({ presentation: 'list', anatomy: marked });
    view.measure(360);
    const px = (value: string | undefined) => Number.parseFloat(value || '0');
    const label = [...view.container.querySelectorAll<HTMLElement>('*')]
      .find((node) => node.children.length === 0 && node.textContent === 'Needs you')!;
    const band = (() => {
      let node: HTMLElement | null = label;
      while (node !== null && px(node.style.paddingLeft) === 0 && node.style.height === '') node = node.parentElement;
      return node!;
    })();
    expect(px(band.style.paddingLeft)).toBe(textEdge);
    const markCell = view.query('mark:a')!.parentElement!;
    const rowContent = markCell.parentElement!;
    // The row's press target draws a 1 pt edge of its own before its content.
    expect(px(rowContent.style.paddingLeft) + 1).toBe(textEdge);
    expect(px(markCell.style.width) + px(rowContent.style.columnGap || rowContent.style.gap))
      .toBe(HAPPIER_PAGE_METRICS.rowLeadingColumnPx + HAPPIER_PAGE_METRICS.rowLeadingGapPx);
    view.unmount();
  });
});

describe('the group band', () => {
  const px = (value: string | undefined) => Number.parseFloat(value || '0');
  function bandOf(view: ReturnType<typeof mount>, title: string): HTMLElement {
    const label = [...view.container.querySelectorAll<HTMLElement>('*')]
      .find((node) => node.children.length === 0 && node.textContent === title)!;
    let band: HTMLElement | null = label;
    while (band !== null && (band.style.backgroundColor === '' || band.style.backgroundColor === 'transparent')) band = band.parentElement;
    expect(band).not.toBeNull();
    return band!;
  }

  it("draws a group label as a quiet rounded band in the rows' own box: the same edge left and right, a breath off the rows (owner 2026-11-11)", async () => {
    // PRs & Issues "Pinned / Needs you": radii derive from one base (DESIGN.md). The band stands where a row's fill
    // does, so its ends meet the rows' (a one-sided gutter cut its right end off), and a selected row under it
    // keeps a small gap rather than touching it.
    const view = mount({ presentation: 'table' });
    view.measure(1440);
    for (const presentation of ['table', 'list'] as const) {
      if (presentation === 'list') await view.setOpen('c');
      const band = bandOf(view, 'Needs you');
      expect(band.style.borderTopLeftRadius).toBe(`${HAPPIER_COLLECTION_LIST_METRICS.rowRadius}px`);
      expect(px(band.style.marginLeft)).toBe(0);
      expect(px(band.style.marginRight)).toBe(0);
      expect(px(band.style.marginTop)).toBeGreaterThan(0);
      expect(px(band.style.marginBottom)).toBe(px(band.style.marginTop));
      expect(Number.parseFloat(band.style.borderBottomWidth || '0')).toBe(0);
      // Its words stand on the rows' leading edge, where each row's glyph starts (the row's content padding plus
      // its press target's 1 pt ring).
      const rowContent = [...view.query('row:a:cell')!.querySelectorAll<HTMLElement>('*')]
        .find((node) => node.children.length === 0 && node.textContent === '•')!.parentElement!.parentElement!;
      expect(px(band.style.paddingLeft)).toBe(px(rowContent.style.paddingLeft) + 1);
    }
    view.unmount();
  });

  it("stands a row's glyph as far in from the row's edge as down from its top (owner 2026-11-11)", async () => {
    // Triage tasks: the status dot sat 20 in but 11 down. One inset: the row's top padding plus its 1 pt ring.
    const view = mount({ presentation: 'table' });
    view.measure(1440);
    await view.setOpen('c');
    const glyphText = [...view.query('row:a:cell')!.querySelectorAll<HTMLElement>('*')]
      .find((node) => node.children.length === 0 && node.textContent === '•')!;
    const rowContent = glyphText.parentElement!.parentElement!;
    expect(px(rowContent.style.paddingLeft)).toBe(px(rowContent.style.paddingTop));
    view.unmount();
  });
});

describe('row hairlines', () => {
  /** The hairline a ruled row draws at its foot: an overlay, absolutely placed along the row's bottom edge. */
  // The table's full-bleed line, or a list row's inset rule (from its text column).
  const hasHairline = (cell: HTMLElement) => cell.querySelector('[data-testid="happier-list-row-rule"]') !== null
    || [...cell.querySelectorAll<HTMLElement>('*')].some((node) =>
      node.style.position === 'absolute' && node.style.bottom === '0px' && node.style.left === '0px'
      && node.style.right === '0px' && Number.parseFloat(node.style.height || '9') <= 1 && node.children.length === 0);
  const ruled = (view: ReturnType<typeof mount>) =>
    Object.fromEntries(entries.map((entry) => [entry.id, hasHairline(view.query(`row:${entry.id}:cell`)!)]));

  it('draws no hairline where a band already parts the groups, around a selected row, or under the open one', async () => {
    // Owner 03: the selected row kept a separator under it, and every band seemed to have a top border (the hairline
    // of the row above it). Rows a, b · band · c. The last row ends the table's sheet, whose edge closes it (owner 11-19).
    const view = mount({ presentation: 'table' });
    view.measure(1440);
    expect(ruled(view)).toEqual({ a: true, b: false, c: false });
    await view.setOpen('b');
    view.measure(1440);
    // b is open: its own foot and the row above it both stop drawing the line between them. Beside the detail the rows
    // are a list, whose rule stands only between rows (owner 2026-11-15), so the list's last row draws none.
    expect(ruled(view)).toEqual({ a: false, b: false, c: false });
    await view.setOpen('c');
    view.measure(1440);
    expect(ruled(view)).toEqual({ a: true, b: false, c: false });
    view.unmount();
  });

  it('rules a page list\'s two-line rows that another row follows, from their cells (D10, owner 2026-11-15/17)', () => {
    // Services → Apps: the second line is the Collection's own cells, so the sheet's item divider never knew of it and
    // two-line rows stood unruled. The last row ends the sheet and draws none.
    const view = mount({ presentation: 'list', scroll: 'page', grouped: false });
    try {
      view.measure(1440);
      expect(ruled(view)).toEqual({ a: true, b: true, c: false });
    } finally {
      view.unmount();
    }
  });

  // PRESETS-ACCEPT-1119 fix 6: a page list's rule stopped where its row's "…" cell began (x≈1318 of a 1360 row), while
  // the header's rule ran on to the row's end. Where the "…" is a laid-out cell (its 28 trigger and its 12 end inset) the
  // rule runs on under it; where it overlays the row's end (a touch resting list) the rule already ends there.
  it.each([
    { rows: 'ruled resting', pointer: 'precise', restingRows: 'ruled' as const },
    { rows: 'ruled resting', pointer: 'touch', restingRows: 'ruled' as const },
    { rows: 'page-sheet', pointer: 'precise', restingRows: undefined },
    { rows: 'page-sheet', pointer: 'touch', restingRows: undefined },
  ])("ends a $rows row's rule on the row's end edge under its row actions ($pointer)", ({ pointer, restingRows }) => {
    const matchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
    (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
      matches: pointer === 'precise' && (query === '(pointer: fine)' || query === '(hover: hover)'),
    });
    const view = mount({
      presentation: 'list', scroll: 'page', grouped: false, detail: 'none',
      ...(restingRows === undefined ? {} : { restingRows }),
      anatomy: { ...anatomy, peek: undefined },
      useRowActions: () => ({ secondaryActions: [{ id: 'pin', label: 'Pin' }], onSecondaryAction: () => undefined }),
    });
    try {
      view.measure(1440);
      const cell = view.query('row:a:cell')!;
      const rule = cell.querySelector<HTMLElement>('[data-testid="happier-list-row-rule"]')!;
      const trigger = view.query('row:a')!.closest('[role="row"]')!.querySelector<HTMLElement>('[aria-label="More actions"]')!;
      let overlaid = false;
      for (let node: HTMLElement | null = trigger; node !== null && !node.matches('[role="row"]'); node = node.parentElement) {
        if (getComputedStyle(node).position === 'absolute') overlaid = true;
      }
      const end = rule.style.right || rule.style.getPropertyValue('inset-inline-end') || '0px';
      // How far the rule reaches past its content cell (`+ 0` reads a negated zero as 0).
      expect(-Number.parseFloat(end) + 0).toBe(overlaid ? 0 : 40);
    } finally {
      view.unmount();
      (globalThis as { matchMedia?: unknown }).matchMedia = matchMedia;
    }
  });
});

// Owner 2026-11-19 (COMPETITOR-1118, BOARD 14:17Z): every table, index pages included, sits in one rounded sheet with
// its outer edge, and its groups are bands inside it; a phone's rows stay flat. It reverses the bare, ruled index table.
describe('the table sheet', () => {
  const radius = `${HAPPIER_PAGE_METRICS.sheetRadiusPx}px`;
  /** The rounded, edged box around the collection's rows, or null when the rows lie on the page. */
  const sheetAround = (view: ReturnType<typeof mount>, key: string): HTMLElement | null => {
    for (let node = view.query(`row:${key}`)?.parentElement ?? null; node !== null && node !== view.container; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.borderTopLeftRadius === radius && Number.parseFloat(style.borderTopWidth || '0') > 0) return node;
    }
    return null;
  };

  it.each([
    { shape: 'page list (Services, Presets, Workflows)', options: { presentation: 'list', scroll: 'page' } as const },
    { shape: 'table (Triage)', options: { presentation: 'table' } as const },
  ])('draws a desktop $shape in one rounded sheet, its groups as bands inside it', ({ options }) => {
    const view = mount({ ...options, detail: 'none' });
    try {
      view.measure(1440);
      const sheet = sheetAround(view, 'a');
      expect(sheet).not.toBeNull();
      // One sheet holds every group's rows and both group names.
      expect(sheet!.contains(view.query('row:c'))).toBe(true);
      expect(sheet!.textContent).toContain('Needs you');
      expect(sheet!.textContent).toContain('Everything else');
      // The group's name stands on a filled band, not on the page ground.
      const band = [...sheet!.querySelectorAll<HTMLElement>('*')].find((node) => node.children.length === 0
        && node.textContent === 'Everything else')!;
      let filled = false;
      for (let node: HTMLElement | null = band; node !== null && node !== sheet; node = node.parentElement) {
        const fill = getComputedStyle(node).backgroundColor;
        if (fill !== '' && fill !== 'transparent' && fill !== 'rgba(0, 0, 0, 0)') filled = true;
      }
      expect(filled).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("leaves a phone's page list flat on the page, and an empty table's statement off any sheet", () => {
    const phone = mount({ presentation: 'list', scroll: 'page', detail: 'none' });
    try {
      phone.measure(390);
      expect(phone.query('row:a')).not.toBeNull();
      expect(sheetAround(phone, 'a')).toBeNull();
    } finally {
      phone.unmount();
    }
    const empty = mount({ presentation: 'list', scroll: 'page', detail: 'none', items: [] });
    try {
      empty.measure(1440);
      const edged = [...empty.container.querySelectorAll<HTMLElement>('*')].some((node) =>
        getComputedStyle(node).borderTopLeftRadius === radius && Number.parseFloat(getComputedStyle(node).borderTopWidth || '0') > 0);
      expect(edged).toBe(false);
    } finally {
      empty.unmount();
    }
  });

  // TABLE-SWEEP-1119: a data grid that scrolls sideways (database rows, query results) frames its viewport, never its
  // wider rows: the sheet stays put while the rows scroll under it.
  it('frames a sideways-scrolling data grid on its viewport, the rows scrolling inside the sheet', () => {
    const wide = (key: 'repo' | 'age', title: string) => ({ key, title, minWidth: 700, priority: 1, render: (entry: Entry) => entry[key] });
    const view = mount({
      presentation: 'table', detail: 'none', grouped: false,
      anatomy: { ...anatomy, peek: undefined, columnsOverflow: 'scroll', fields: [wide('repo', 'Repo'), wide('age', 'Age')] },
    });
    try {
      view.measure(1440);
      const sheet = sheetAround(view, 'a');
      expect(sheet).not.toBeNull();
      // Nothing between the sheet and the page scrolls sideways: the scrolling region is inside it.
      const scrolls = (node: HTMLElement) => ['auto', 'scroll'].includes(getComputedStyle(node).overflowX);
      let outerScroller = false;
      for (let node = sheet!.parentElement; node !== null && node !== view.container; node = node.parentElement) {
        if (scrolls(node)) outerScroller = true;
      }
      expect(outerScroller).toBe(false);
      expect([sheet!, ...sheet!.querySelectorAll<HTMLElement>('*')].some(scrolls)).toBe(true);
    } finally {
      view.unmount();
    }
  });

  // PRESETS-ACCEPT-1119 round 2 (Isolation → Sandboxes at 1440): a table on a page section's sheet keeps that sheet's one
  // edge, whatever stands above it on the sheet (the check-failed notice).
  it.each([
    { before: 'nothing', node: undefined },
    { before: 'a notice', node: <Text testID="sheet-notice">Couldn't check these sandbox types.</Text> },
  ])('draws no second sheet for a page list already on a section sheet, with $before above it', ({ node }) => {
    const view = mount({
      presentation: 'list', scroll: 'page', grouped: false, detail: 'none',
      anatomy: { ...anatomy, peek: undefined },
      useRowActions: () => ({ secondaryActions: [{ id: 'pin', label: 'Pin' }], onSecondaryAction: () => undefined }),
      enclosingSheet: { before: node },
    });
    try {
      view.measure(1440);
      let edges = 0;
      for (let at = view.query('row:a')?.parentElement ?? null; at !== null && at !== view.container; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.borderTopLeftRadius === radius && Number.parseFloat(style.borderTopWidth || '0') > 0) edges += 1;
      }
      // The section's own sheet, and nothing of the table's.
      expect(edges).toBe(1);
    } finally {
      view.unmount();
    }
  });

  // MACH-UI-GAPS-1120 (design judge round 18, Isolation → Sandboxes at 1440): the rows' marks stood 16 px in from the
  // sheet's own "Add a sandbox" glyph. A table on a section's sheet takes that sheet's content edge, adding no inset.
  it("stands a page list on a section sheet on that sheet's content edge, with no inset of its own", () => {
    const view = mount({
      presentation: 'list', scroll: 'page', grouped: false, detail: 'none',
      anatomy: { ...anatomy, peek: undefined },
      enclosingSheet: {},
    });
    try {
      view.measure(1440);
      const sheet = sheetAround(view, 'a')!;
      let insetPx = 0;
      for (let node: HTMLElement | null = view.query('collection:stage'); node !== null && node !== sheet; node = node.parentElement) {
        const style = getComputedStyle(node);
        insetPx += Number.parseFloat(style.marginLeft || '0') + Number.parseFloat(style.paddingLeft || '0');
      }
      expect(insetPx).toBe(0);
    } finally {
      view.unmount();
    }
  });

  // MACH-UI-GAPS-1120 / LAYOUT-ACCEPT-1120 fix 1: the pause above a page table's sheet replaces space, never adds to it.
  // Under the page's purpose line the sheet is the page's first group (the group pause; DESIGN.md "Shell grid", UI
  // refinements "first-group gap 28"); under a count or filter line it stays close (lab storage-view `.sv-cnt`); under a
  // toolbar, or a header that ends in a section with its own space (All machines' Needs you), nothing is added.
  it.each([
    { shape: 'under the purpose line (Presets)', sheetAfter: 'purpose' as const, header: <Text>Presets</Text>, leadPx: () => HAPPIER_PAGE_METRICS.sectionGapPx },
    { shape: 'under a count line (Artifacts, Services)', sheetAfter: 'line' as const, header: <Text>2 artifacts</Text>, leadPx: () => HAPPIER_PAGE_METRICS.collectionLineSheetGapPx },
    { shape: 'under a header that ends in a section (All machines)', sheetAfter: undefined, header: <Text>Needs you</Text>, leadPx: () => 0 },
    { shape: 'under its toolbar (Runs)', sheetAfter: undefined, header: () => <Text>All runs</Text>, leadPx: () => 0 },
  ])('stands a page table sheet $shape at its lead', ({ sheetAfter, header, leadPx }) => {
    const view = mount({ presentation: 'list', scroll: 'page', grouped: true, detail: 'none', header,
      ...(sheetAfter === undefined ? {} : { sheetAfter }) });
    try {
      view.measure(1440);
      const sheet = sheetAround(view, 'a')!;
      const stage = view.query('collection:stage')!;
      let drawnLeadPx = 0;
      for (let node: HTMLElement | null = sheet; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node);
        drawnLeadPx += Number.parseFloat(style.marginTop || '0') + Number.parseFloat(style.paddingTop || '0');
        if (node === stage) break;
      }
      expect(drawnLeadPx).toBe(leadPx());
    } finally {
      view.unmount();
    }
  });

  // QA-STATUS-LISTS-1120 (BOARD 20:07Z, N38): Workflows' one "Library" group stood as a band 15 px inside its sheet while
  // the sibling "Built-in" title stood on the page column. One titled group is the section's title above the sheet, on
  // the page column; bands stand inside the sheet only for two or more groups (the rounded-sheet ruling).
  it.each([
    { shape: 'page list', presentation: 'list' as const },
    { shape: 'table', presentation: 'table' as const },
  ])('titles a $shape with one group above its sheet, as a page section', ({ presentation }) => {
    const view = mount({ presentation, scroll: 'page', grouped: true, detail: 'none',
      grouping: { ...groups, axis: groups.axis.slice(0, 1) },
      items: entries.filter((entry) => entry.group === 'needs') });
    try {
      view.measure(1440);
      const sheet = sheetAround(view, 'a')!;
      expect(sheet.textContent).not.toContain('Needs you');
      const title = [...view.container.querySelectorAll<HTMLElement>('*')].find((node) => node.children.length === 0
        && node.textContent === 'Needs you');
      expect(title).toBeDefined();
      // Above the sheet, in the stage, on no band's fill.
      expect(title!.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      for (let node: HTMLElement | null = title!; node !== null && node !== view.container; node = node.parentElement) {
        const fill = getComputedStyle(node).backgroundColor;
        expect(fill === '' || fill === 'transparent' || fill === 'rgba(0, 0, 0, 0)').toBe(true);
      }
    } finally {
      view.unmount();
    }
  });

  // TRIAGE-DESIGN-ACCEPT-250 F5: whether one group is the section's title is the table's declared grouping, never how
  // many groups still hold rows. A search that leaves one group keeps its band in the sheet, so the header stays put.
  it.each([
    { shape: 'page list', presentation: 'list' as const },
    { shape: 'table', presentation: 'table' as const },
  ])('keeps a $shape banded when a search leaves one of its groups', async ({ presentation }) => {
    const options = { presentation, scroll: 'page' as const, grouped: true, detail: 'none' as const };
    const view = mount({ ...options, items: entries });
    try {
      view.measure(1440);
      const bandInSheet = () => sheetAround(view, 'a')!.querySelector('[aria-label="Needs you"]') !== null;
      expect(bandInSheet()).toBe(true);
      await view.update({ ...options, items: entries.filter((entry) => entry.id === 'a') });
      expect(sheetAround(view, 'a')!.textContent).not.toContain('Everything else');
      expect(bandInSheet()).toBe(true);
    } finally {
      view.unmount();
    }
  });

  // LAYOUT-ACCEPT-1120 fix 5 (Using the most at 390): the phone's totals row started 6 px left of the section's content
  // edge. On a page list its title stands where the rows' titles do, as the wide table's does.
  it("starts a page list's totals title on the rows' title edge", () => {
    const view = mount({
      presentation: 'list', scroll: 'page', grouped: false, detail: 'none',
      anatomy: { ...anatomy, peek: undefined },
      summaryRows: [{ key: 'total', title: 'Total', cells: {}, testID: 'total' }],
      enclosingSheet: {},
    });
    try {
      view.measure(360);
      const total = view.query('total')!;
      const style = getComputedStyle(total);
      const spacer = total.firstElementChild as HTMLElement;
      const titleStartPx = Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(getComputedStyle(spacer).width || '0')
        + Number.parseFloat(style.columnGap || style.gap || '0');
      expect(titleStartPx).toBe(HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx + HAPPIER_PAGE_METRICS.rowLeadingColumnPx
        + HAPPIER_PAGE_METRICS.rowLeadingGapPx);
    } finally {
      view.unmount();
    }
  });

  it("closes the table's last row on the sheet's edge: no hairline of its own there", () => {
    const view = mount({ presentation: 'table', detail: 'none', grouped: false });
    try {
      view.measure(1440);
      const footOf = (key: string) => [...view.query(`row:${key}`)!.closest('[role="row"]')!.querySelectorAll<HTMLElement>('*')]
        .some((node) => node.style.position === 'absolute' && node.style.bottom === '0px' && node.style.left === '0px'
          && node.style.right === '0px' && Number.parseFloat(node.style.height || '9') <= 1 && node.children.length === 0);
      expect(footOf('a')).toBe(true);
      expect(footOf('c')).toBe(false);
    } finally {
      view.unmount();
    }
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

  it('says the suffix inline on a single-line list row, between the title and its end-aligned meta, with no second line', () => {
    // No byline, where, reason or description: the list row is one line, so the suffix it would otherwise leave to the
    // byline stands after the title (a status word), and the meta ends the same line.
    const single: CollectionAnatomy<Entry> = {
      glyph: () => <Text>•</Text>,
      title: (entry) => entry.title,
      titleSuffix: (entry) => (entry.id === 'a' ? 'Working' : null),
      titleMeta: (entry) => <Text testID={`meta:${entry.id}`}>{`${entry.id === 'a' ? '4.1' : '2.3'} GB`}</Text>,
      accessibilityLabel: (entry) => `${entry.title}, ${entry.id === 'a' ? '4.1' : '2.3'} GB`,
      testID: (entry) => `row:${entry.id}`,
      columnTitles: { title: 'Entry' },
    };
    const view = mount({ presentation: 'list', anatomy: single });
    view.measure(360);
    const suffix = view.query('row:a:title-suffix');
    expect(suffix?.textContent).toBe('Working');
    expect(view.query('row:b:title-suffix')).toBeNull();
    const row = view.query('row:a')!;
    const text = row.textContent ?? '';
    expect(text.indexOf('Retry idempotent payment intents')).toBeLessThan(text.indexOf('Working'));
    expect(text.indexOf('Working')).toBeLessThan(text.indexOf('4.1 GB'));
    // One line: the title, the suffix and the meta share one horizontal line, and that line is the row's only one.
    let line: HTMLElement = suffix!;
    while (!line.contains(view.query('meta:a'))) line = line.parentElement!;
    expect(getComputedStyle(line).flexDirection).toBe('row');
    expect(line.textContent).toContain('Retry idempotent payment intents');
    expect(line.parentElement!.children).toHaveLength(1);
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

describe('the control fields', () => {
  it("draw a field cell that is the row's own control beside its press target, never inside it", () => {
    const pressed: string[] = [];
    const view = mount({
      anatomy: {
        ...anatomy,
        fields: [
          {
            key: 'phase',
            title: 'Used at',
            minWidth: 120,
            priority: 2,
            control: true,
            render: (entry) => (
              <Button
                testID={`row:${entry.id}:phase`}
                title="Runtime"
                onPress={() => {
                  pressed.push(entry.id);
                }}
              />
            ),
          },
        ],
      },
    });
    view.measure(1440);
    const control = view.query('row:a:phase');
    expect(control).not.toBeNull();
    expect(view.query('row:a')?.contains(control)).toBe(false);
    expect(
      view.container.querySelectorAll(
        'button button, [role="button"] [role="button"]',
      ),
    ).toHaveLength(0);
    act(() => {
      control!.click();
    });
    expect(pressed).toEqual(['a']);
    expect(view.openChanges).toEqual([]);
    view.unmount();
  });
});

describe('the search field', () => {
  it('says the active filters as removable tokens on a quiet line under the field, and shows the key that focuses it', async () => {
    const removed: string[] = [];
    const view = mount({
      search: {
        label: 'Search entries',
        value: '',
        onValueChange: () => undefined,
        testID: 'search',
        tokens: [
          { key: 'view', qualifier: 'view', label: 'My work', onRemove: () => { removed.push('view'); } },
          { key: 'state', qualifier: 'is', label: 'open', onRemove: () => { removed.push('state'); } },
        ],
      },
    });
    view.measure(1440);
    const field = view.query('search.field')!;
    // The field holds only the query: tokens never share its line, so the query is never squeezed.
    expect(field.querySelectorAll('[aria-label^="Remove"]')).toHaveLength(0);
    const line = view.query('search:tokens')!;
    const tokens = [...line.querySelectorAll<HTMLElement>('[role="button"]')];
    expect(tokens.map((token) => token.getAttribute('aria-label'))).toEqual(['Remove view My work', 'Remove is open']);
    expect(field.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { tokens[1]!.click(); });
    expect(removed).toEqual(['state']);
    // The field's own focus shortcut, said as a key cap after the text and hidden from assistive technology.
    const hint = view.query('search:shortcut');
    expect(hint?.textContent).toBe('/');
    expect(hint?.closest('[aria-hidden="true"]')).not.toBeNull();
    view.unmount();
  });

  it('keeps the search field, its focus and caret while the window crosses the phone breakpoint (QB80)', async () => {
    // Live READY159 (QA-COLLECTION r159): typing at 1440, then 390, the query and caret stayed but focus was lost.
    const view = mount({
      search: { label: 'Search entries', value: '1998', onValueChange: () => undefined, testID: 'search' },
      // The shared toolbar composes the search at both widths, as the PRs & Issues page does.
      header: (slots) => <CollectionToolbar slots={slots} lens={<Text testID="lens">Mine</Text>} />,
    });
    view.measure(1440);
    const field = () => (view.query('search')!.matches('input') ? view.query('search')! : view.query('search')!.querySelector('input'))!;
    const before = field();
    await act(async () => { before.focus(); before.setSelectionRange(1, 1); });
    expect(document.activeElement).toBe(before);
    for (const width of [390, 1440, 390]) {
      view.measure(width);
      await act(async () => { await Promise.resolve(); });
      expect(field(), `the field is remounted at ${width}`).toBe(before);
      expect(document.activeElement, `focus is lost at ${width}`).toBe(before);
      expect(before.selectionStart).toBe(1);
    }
    view.unmount();
  });

  it('keeps the focused search when the page name becomes the phone large title (QB80, READY161)', async () => {
    // Live READY161: at 390 the host hands the page its large title; the toolbar moved under it and the field remounted.
    const pageChrome = { showsTitle: true, largeTitle: false };
    const view = mount({
      title: 'PRs & Issues',
      search: { label: 'Search entries', value: '1998', onValueChange: () => undefined, testID: 'search' },
      header: (slots) => <CollectionToolbar slots={slots} lens={<Text testID="lens">Mine</Text>} />,
      pageChrome,
    });
    view.measure(1440);
    const field = () => (view.query('search')!.matches('input') ? view.query('search')! : view.query('search')!.querySelector('input'))!;
    const before = field();
    await act(async () => { before.focus(); before.setSelectionRange(1, 1); });
    for (const largeTitle of [true, false]) {
      pageChrome.largeTitle = largeTitle;
      await act(async () => { view.update({}); });
      view.measure(largeTitle ? 390 : 1440);
      await act(async () => { await Promise.resolve(); });
      expect(field(), `the field is remounted with largeTitle=${largeTitle}`).toBe(before);
      expect(document.activeElement).toBe(before);
    }
    view.unmount();
  });

  it('keeps an uncommitted Japanese search composition when folding behind the phone magnifier (QB80)', async () => {
    let query = '';
    const settled: string[] = [];
    const search = () => ({
      label: 'Search entries', value: query, testID: 'search',
      onValueChange: (value: string) => { settled.push(value); query = value; },
    });
    const pageChrome = { showsTitle: false, largeTitle: false,
      renderSearchToggle: ({ onPress }: { onPress: () => void }) => <button onClick={onPress}>Search</button>,
    };
    const view = mount({
      title: 'PRs & Issues', search: search(), pageChrome,
      header: (slots) => <CollectionToolbar slots={slots} />,
    });
    try {
      view.measure(1440);
      const field = () => {
        const node = view.query('search');
        return node?.matches('input') ? node : node?.querySelector('input');
      };
      const input = field()!;
      const type = (value: string, isComposing: boolean) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.setSelectionRange(value.length, value.length);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing }));
      };
      await act(async () => {
        input.focus();
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        type('とうきょう', true);
      });
      expect(input.value).toBe('とうきょう');
      expect(settled).toEqual([]);
      pageChrome.largeTitle = true;
      await act(async () => { view.update({}); });
      view.measure(320);
      expect(field()).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe('とうきょう');
      await act(async () => {
        type('東京', true);
        input.dispatchEvent(new CompositionEvent('compositionend', { data: '東京', bubbles: true }));
        view.update({ search: search() });
      });
      expect(settled).toEqual(['東京']);
      expect(field()).toBe(input);
      expect(input.value).toBe('東京');
    } finally {
      view.unmount();
    }
  });

  it('Escape in the search clears the query first, then closes the open item (QB80)', async () => {
    // Live READY238: with a detail open, Escape in the emptied search did nothing; a web text input keeps its keys
    // from reaching the document, so the field itself hands an unhandled Escape to the Collection's close.
    let value = 'fix';
    const changes: string[] = [];
    const searchFor = () => ({ label: 'Search entries', value, onValueChange: (next: string) => { changes.push(next); }, testID: 'search' });
    const view = mount({
      search: searchFor(),
      header: (slots) => <CollectionToolbar slots={slots} lens={<Text testID="lens">Mine</Text>} />,
      openKey: 'a',
    });
    view.measure(1440);
    const field = () => (view.query('search')!.matches('input') ? view.query('search')! : view.query('search')!.querySelector('input'))!;
    const escape = (isComposing = false) => act(async () => {
      field().focus();
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing }));
    });
    await act(async () => {
      field().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await escape(true);
    expect(changes).toEqual([]);
    expect(view.openChanges).toEqual([]);
    await act(async () => {
      field().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    changes.length = 0;
    await escape();
    expect(changes).toEqual(['']);
    expect(view.openChanges).toEqual([]);
    value = '';
    await act(async () => { view.update({ search: searchFor() }); });
    await escape();
    expect(view.openChanges).toEqual([null]);
    view.unmount();
  });

  it('keeps the caret after the typed letter when it replaces a selected query (QB80)', async () => {
    // Live READY238: select-all "qa33", type "forge": the field read "orge", because the kept caret narrowed the
    // stale whole-query range over the new text and selected the typed "f" before the next key replaced it.
    let value = 'qa33';
    const view = mount({
      search: { label: 'Search entries', value, onValueChange: (next: string) => { value = next; }, testID: 'search' },
      header: (slots) => <CollectionToolbar slots={slots} lens={<Text testID="lens">Mine</Text>} />,
    });
    view.measure(1440);
    const field = () => (view.query('search')!.matches('input') ? view.query('search')! : view.query('search')!.querySelector('input'))! as HTMLInputElement;
    await act(async () => { field().focus(); field().setSelectionRange(0, 4); field().dispatchEvent(new Event('select', { bubbles: true })); });
    await act(async () => {
      const input = field();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'f');
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { view.update({ search: { label: 'Search entries', value, onValueChange: (next: string) => { value = next; }, testID: 'search' } }); });
    expect(value).toBe('f');
    expect([field().selectionStart, field().selectionEnd]).toEqual([1, 1]);
    view.unmount();
  });

  it('draws no token line while nothing narrows the list', () => {
    const view = mount({ search: { label: 'Search entries', value: '', onValueChange: () => undefined, testID: 'search' } });
    view.measure(1440);
    expect(view.query('search:tokens')).toBeNull();
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
    const line = view.query('search:tokens')!;
    const tokens = [...line.querySelectorAll<HTMLElement>('[role="button"]')];
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

  it('keeps the glyph where a row offers no leading control, in the table as in the list', () => {
    const view = mount({
      anatomy: {
        ...anatomy,
        glyph: (entry) => <Text testID={`glyph:${entry.id}`}>•</Text>,
        leadingControl: (entry) => entry.id === 'a' ? <Text testID="control:a">◯</Text> : null,
      },
    });
    for (const width of [1440, 360]) {
      view.measure(width);
      expect(view.query('control:a')).not.toBeNull();
      expect(view.query('glyph:a')).toBeNull();
      // A row whose control is absent (a stale row, a source with no workflow) still says what it is.
      expect(view.query('glyph:b')).not.toBeNull();
    }
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

  it.each([true, false])('keeps catalog rows and focus through directory recomposition (grouped: %s)', (grouped) => {
    const view = mount({
      grouped,
      presentation: 'list',
      scroll: 'page',
      detail: 'none',
      anatomy: { ...anatomy, rowRole: 'catalogRow', description: (entry) => `What ${entry.title} does` },
    });
    // The line that holds a row: its directory cell's parent.
    const lineOf = (key: string) => view.query(`row:${key}`)!.closest(`[data-testid="collection:directory-line"]`);
    view.measure(1440);
    // Two columns, row-major: a group's first two rows share one line, in reading (and keyboard) order.
    expect(lineOf('a')).not.toBeNull();
    expect(lineOf('a')).toBe(lineOf('b'));
    expect(lineOf('a')!.compareDocumentPosition(view.query('row:b')!) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    const rowA = view.query('row:a')!;
    const rowB = view.query('row:b');
    act(() => { rowA.focus(); });
    view.measure(500);
    // Narrower than two columns can hold: one column, a row per line.
    expect(lineOf('a')).toBeNull();
    // Recomposing the columns keeps every row mounted (focus, press state and a pane's source survive a resize).
    expect(view.query('row:a')).toBe(rowA);
    expect(view.query('row:b')).toBe(rowB);
    expect(document.activeElement).toBe(rowA);
    view.measure(1440);
    expect(view.query('row:a')).toBe(rowA);
    expect(view.query('row:b')).toBe(rowB);
    expect(document.activeElement).toBe(rowA);
    view.unmount();
  });

  it('reserves a loading directory as a short run of rows in its columns, not one row measured from itself', () => {
    const view = mount({
      items: [],
      loading: true,
      presentation: 'list',
      scroll: 'page',
      detail: 'none',
      anatomy: { ...anatomy, rowRole: 'catalogRow', description: (entry) => `What ${entry.title} does` },
    });
    view.measure(1440, 2000);
    const rows = view.queryAll('collection:skeleton-row');
    // A page-scrolling list is only as tall as what it draws: the run stands in for the rows that are coming.
    expect(rows.length).toBeGreaterThan(3);
    // Row-major columns like the loaded directory: the first two placeholders stand side by side.
    expect(rows[0]!.parentElement).not.toBe(rows[rows.length - 1]!.parentElement);
    // A directory draws no hairlines, loading or loaded.
    expect(rows.every((row) => getComputedStyle(row).borderBottomWidth === '' || getComputedStyle(row).borderBottomWidth === '0px')).toBe(true);
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

  it('mounts an assignable empty column through the real DropTarget transport and leaves derived columns read-only', async () => {
    const requests: import('@happier-dev/plugin-sdk/ui').PluginUiUpdateEntityDragDropRequestV1[] = [];
    const view = mount({
      presentation: 'board', boardLayout: 'columns', detail: 'none',
      grouping: { axis: [
        { key: 'needs', title: 'Needs you', membership: { kind: 'derived' } },
        { key: 'rest', title: 'Everything else', membership: { kind: 'derived' } },
        { key: 'done', title: 'Done', membership: { kind: 'assignable', target: { targetId: 'task-status', input: { category: 'completed' } } } },
      ], groupOf: entry => entry.group, retainEmpty: true },
      hostApiOverrides: {
        updateEntityDragDrop: async request => { requests.push(request); return { accepted: true }; },
        watchEntityDragDrop: async () => ({ dispose() {} }),
      },
    });
    try {
      await act(async () => { view.measure(1440); });
      const targets = requests.filter(request => request.kind === 'mountTarget');
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ targetId: 'task-status', input: { category: 'completed' } });
      expect(view.query('collection:column:done')?.querySelector('[data-testid^="row:"]')).toBeNull();
      await view.update({ grouping: { axis: [{ key: 'needs', title: 'Needs you', membership: { kind: 'derived' } },
        { key: 'rest', title: 'Everything else', membership: { kind: 'derived' } }], groupOf: entry => entry.group } });
      expect(requests).toContainEqual({ kind: 'unmount', mountId: targets[0]!.mountId });
    } finally { view.unmount(); }
  });

  // R11 M5: a kept group whose first window is still loading shows its heading with no count, never "0".
  it.each(['list', 'grid'] as const)('keeps a loading %s group heading without a count until its rows arrive', async (presentation) => {
    const view = mount({
      presentation, detail: 'none', items: [], loading: true,
      grouping: { axis: [{ key: 'library', title: 'Library' }], groupOf: (entry) => entry.group, retainEmpty: true },
    });
    try {
      await act(async () => { view.measure(1280); });
      const text = view.container.textContent ?? '';
      expect(text).toContain('Library');
      expect(text).not.toMatch(/Library\s*0/);
      await view.update({ loading: false, items: [{ id: 'a', title: 'Review changes', group: 'library', repo: 'app', reason: '', age: '1m' }] });
      expect(view.container.textContent ?? '').toMatch(/Library\s*1/);
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

  it("scrolls a board that does not fit to bring the keyboard-focused card's whole column into view", () => {
    const items: readonly Entry[] = [
      { id: 'a', title: 'Retry idempotent payment intents', group: 'needs', repo: 'payments-api', reason: 'Review requested', age: '18m' },
      { id: 'z', title: 'Rotate staging service principals', group: 'rest', repo: 'ops', reason: '', age: '2d' },
    ];
    const view = mount({
      presentation: 'board',
      boardLayout: 'columns',
      detail: 'none',
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
      view.measure(700);
      const column = view.query('collection:column:rest')!;
      const columnWidth = Number.parseFloat(getComputedStyle(column).width);
      const scrolls: Array<Readonly<{ node: Element; left: number }>> = [];
      const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scroll');
      Object.defineProperty(Element.prototype, 'scroll', { configurable: true, writable: true,
        value(this: Element, options?: ScrollToOptions) { scrolls.push({ node: this, left: options?.left ?? 0 }); } });
      try {
        act(() => { view.query('row:a')!.focus(); });
        act(() => {
          view.query('row:a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        });
        expect(document.activeElement).toBe(view.query('row:z'));
      } finally {
        if (original === undefined) delete (Element.prototype as { scroll?: unknown }).scroll;
        else Object.defineProperty(Element.prototype, 'scroll', original);
      }
      // Focus alone (no detail opens) moves the horizontal scroller so the last column's far edge is on screen.
      const reveal = scrolls.filter((call) => call.node.contains(column) && call.left > 0).at(-1);
      expect(reveal).toBeDefined();
      const columnEnd = ([...column.parentElement!.children].indexOf(column) + 1) * columnWidth;
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

describe('first layout (web)', () => {
  it('mounts each table row once on open: the layout is decided before the rows mount, never list then table', () => {
    // The stage reads its layout box before the browser paints; rows must not mount in a provisional geometry first.
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1440);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
    const mounts = new Map<string, number>();
    function CountedGlyph(props: Readonly<{ id: string }>) {
      React.useLayoutEffect(() => { mounts.set(props.id, (mounts.get(props.id) ?? 0) + 1); }, [props.id]);
      return <Text>•</Text>;
    }
    try {
      const view = mount({ presentation: 'table', detail: 'none', anatomy: { ...anatomy, glyph: (entry) => <CountedGlyph id={entry.id} /> } });
      expect(view.query('row:a')).not.toBeNull();
      expect([...mounts.values()]).toEqual(entries.map(() => 1));
      view.unmount();
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it('keeps its table rows mounted while a retained pane hides it and shows it again', async () => {
    // Real RNW layout path (its observer callback, UIManager measure, the stage's handler). ResizeObserver, geometry
    // and checkVisibility are the browser boundary jsdom lacks: under `display: none` a box measures 0×0 and is not rendered.
    const box = { width: 1440, height: 800, rendered: true };
    const observed = new Set<Element>();
    let deliver = () => {};
    class BrowserResizeObserver {
      constructor(callback: (entries: { target: Element }[]) => void) {
        deliver = () => callback([...observed].map(target => ({ target })));
      }
      observe(target: Element) { observed.add(target); }
      unobserve(target: Element) { observed.delete(target); }
      disconnect() { observed.clear(); }
    }
    vi.stubGlobal('ResizeObserver', BrowserResizeObserver);
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => box.width);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => box.height);
    const prototype = Element.prototype as unknown as { checkVisibility?: () => boolean };
    prototype.checkVisibility = () => box.rendered;
    const report = (next: Partial<typeof box>) => act(async () => {
      Object.assign(box, next);
      deliver();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const mounts = new Map<string, number>();
    function CountedGlyph(props: Readonly<{ id: string }>) {
      React.useLayoutEffect(() => { mounts.set(props.id, (mounts.get(props.id) ?? 0) + 1); }, [props.id]);
      return <Text>•</Text>;
    }
    try {
      const view = mount({ presentation: 'table', detail: 'none', anatomy: { ...anatomy, glyph: (entry) => <CountedGlyph id={entry.id} /> } });
      await report({});
      const settled = [...mounts.values()];
      expect(settled).toEqual(entries.map(() => 1));
      await report({ width: 0, height: 0, rendered: false });
      await report({ width: 1440, height: 800, rendered: true });
      expect([...mounts.values()]).toEqual(settled);
      view.unmount();
    } finally {
      delete prototype.checkVisibility;
      width.mockRestore();
      height.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('still lands its rows where the browser reports no box before paint', () => {
    const view = mount({ presentation: 'table', detail: 'none' });
    expect(view.query('row:a')).not.toBeNull();
    view.unmount();
  });
});

// The physical page scroller is the platform boundary: its window and the collection's place in it.
function pageTracker(viewportHeight = 900) {
  const listeners = new Set<() => void>();
  let window = { top: 0, bottom: viewportHeight };
  const tracker: PluginUiScrollActivityTracker = {
    onScroll() {}, onLayout() {}, onContentSizeChange() {}, invalidateLayout() {},
    getLayoutRevision: () => 0,
    getWindow: () => window,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    measureSpan: async () => ({ top: 0 }),
    scrollToOffset: (offset) => { window = { top: offset, bottom: offset + viewportHeight }; listeners.forEach((listener) => listener()); },
  };
  return tracker as PluginUiScrollActivityTracker & { scrollToOffset(offset: number): void };
}

describe('page list windowing', () => {
  // Five rows per group, so 50 and 500 rows lay out the same first page; a shared sheet bands every group (All Deployments).
  const rowsOf = (count: number): readonly Entry[] => Array.from({ length: count }, (_, index) => ({
    id: `r${index}`, title: `Service ${index + 1}`, group: `g${Math.floor(index / 5)}`, repo: 'api', reason: '', age: '1d',
  }));
  const bandsOf = (count: number, section?: Readonly<{ key: string; title: string }>) => ({
    axis: Array.from({ length: Math.ceil(count / 5) }, (_, index) => ({
      key: `g${index}`, title: `Project ${index + 1}`, ...(section === undefined ? {} : { section }),
    })),
    groupOf: (entry: Entry) => entry.group,
  });
  type Shape = 'phone list' | 'desktop table' | 'grouped page sections' | 'one sheet of bands';
  const options = (shape: Shape, count: number): HarnessOptions => ({
    detail: 'none', scroll: 'page', items: rowsOf(count),
    ...(shape === 'desktop table' ? { presentation: 'table', grouped: false }
      : shape === 'phone list' ? { presentation: 'list', grouped: false }
      : shape === 'grouped page sections' ? { presentation: 'list', grouping: bandsOf(count) }
      : { presentation: 'list', grouping: bandsOf(count, { key: 'services', title: '' }) }),
  });
  const widthOf = (shape: Shape) => (shape === 'phone list' ? 390 : 1440);
  const mountedRows = (view: ReturnType<typeof mount>) => [...view.container.querySelectorAll('[data-testid^="row:"]')]
    .filter((node) => node.getAttribute('data-testid')!.split(':').length === 2).length;

  it.each<Shape>(['phone list', 'desktop table', 'grouped page sections', 'one sheet of bands'])(
    'mounts only the rows near the page window, however long the %s (page scroll)',
    async (shape) => {
      const atTopOf = async (count: number) => {
        const tracker = pageTracker();
        const view = mount({ ...options(shape, count), scrollTracker: tracker });
        try {
          view.measure(widthOf(shape));
          await act(async () => {});
          const atTop = mountedRows(view);
          expect(view.query('row:r0')).not.toBeNull();
          expect(view.query(`row:r${count - 1}`)).toBeNull();
          if (count < 500) return atTop;
          // Page by page to the end: the count stays bounded, the last row arrives and the first rows leave.
          for (let page = 1; page < 400 && view.query(`row:r${count - 1}`) === null; page += 1) {
            await act(async () => { tracker.scrollToOffset(page * 900); });
            expect(mountedRows(view)).toBeLessThanOrEqual(atTop + 20);
          }
          expect(view.query(`row:r${count - 1}`)).not.toBeNull();
          expect(view.query('row:r100')).toBeNull();
          return atTop;
        } finally {
          view.unmount();
        }
      };
      const fifty = await atTopOf(50);
      const fiveHundred = await atTopOf(500);
      expect(fiveHundred).toBe(fifty);
      expect(fiveHundred).toBeLessThan(50);
    },
    // Paging through 500 rows commits a window per page.
    30_000,
  );

  it('draws a windowed shared sheet as one sheet: the bands near the window under their own sub-headings', async () => {
    const view = mount({ ...options('one sheet of bands', 500), scrollTracker: pageTracker() });
    try {
      // A phone's shared sheet; wider, the same groups are bands in the table's one sheet (owner 2026-11-19).
      view.measure(390);
      await act(async () => {});
      // The sheet both bands share: the nearest ancestor of a row of each, holding the second band's sub-heading.
      let sheet = view.query('row:r0')!.parentElement!;
      while (!sheet.contains(view.query('row:r5'))) sheet = sheet.parentElement!;
      const subHeadings = [...sheet.querySelectorAll('[role="group"][aria-label]')].map((group) => group.getAttribute('aria-label'));
      expect(subHeadings).toContain('Project 2');
      expect(subHeadings).not.toContain('Project 100');
    } finally {
      view.unmount();
    }
  });

  it('reveals and focuses a row outside the window on End, then the first again on Home (phone list)', async () => {
    const tracker = pageTracker();
    const offsets: number[] = [];
    const scrollToOffset = tracker.scrollToOffset;
    const view = mount({ ...options('phone list', 500), scrollTracker: { ...tracker, scrollToOffset: (offset: number) => {
      offsets.push(offset); scrollToOffset(offset);
    } } });
    try {
      view.measure(390);
      await act(async () => {});
      await act(async () => {
        view.query('row:r0')!.focus();
        view.query('row:r0')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
      });
      expect(offsets.at(-1)).toBeGreaterThan(900);
      expect(document.activeElement).toBe(view.query('row:r499'));
      expect(mountedRows(view)).toBeLessThan(100);
      await act(async () => {
        view.query('row:r499')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(view.query('row:r0'));
    } finally {
      view.unmount();
    }
  });
});

describe('grid', () => {
  const library = (count: number): readonly Entry[] => Array.from({ length: count }, (_, index) => ({
    id: `art-${index}`, title: `Artifact ${index + 1}`, group: 'rest', repo: 'notes', reason: '', age: '1d',
  }));

  it('mounts only the cards near the page window, however large the library (page scroll)', async () => {
    const mountedCards = async (count: number) => {
      const tracker = pageTracker();
      const view = mount({ presentation: 'grid', grouped: false, detail: 'none', scroll: 'page', items: library(count), scrollTracker: tracker });
      try {
        view.measure(1440);
        await act(async () => {});
        const cards = () => view.container.querySelectorAll('[data-testid$=":card"]').length;
        const atTop = cards();
        expect(view.query('row:art-0:card')).not.toBeNull();
        expect(view.query(`row:art-${count - 1}:card`)).toBeNull();
        if (count < 500) return atTop;
        // Scrolled down page by page to the end, the last cards stand in the window and the first ones are gone.
        for (let page = 1; page < 400 && view.query(`row:art-${count - 1}:card`) === null; page += 1) {
          await act(async () => { tracker.scrollToOffset(page * 900); });
          expect(cards()).toBeLessThanOrEqual(atTop + 12);
        }
        expect(view.query(`row:art-${count - 1}:card`)).not.toBeNull();
        // The tab stop's line (the first card) stays drawn; the lines after it scrolled away are gone.
        expect(view.query(`row:art-${Math.floor(count / 4)}:card`)).toBeNull();
        return atTop;
      } finally {
        view.unmount();
      }
    };
    const fifty = await mountedCards(50);
    const fiveHundred = await mountedCards(500);
    expect(fiveHundred).toBe(fifty);
    expect(fiveHundred).toBeLessThan(50);
  });

  it('keeps a windowed card in its place, never reparented, when the columns re-flow', async () => {
    const view = mount({ presentation: 'grid', grouped: false, detail: 'none', scroll: 'page', items: library(200), scrollTracker: pageTracker() });
    try {
      view.measure(1440);
      await act(async () => {});
      const card = view.query('row:art-3:card')!;
      const parent = card.parentElement;
      view.measure(700);
      await act(async () => {});
      expect(view.query('row:art-3:card')).toBe(card);
      expect(card.parentElement).toBe(parent);
    } finally {
      view.unmount();
    }
  });

  it('keeps the Collection mounted when a page-scrolled view switches between grid and list', async () => {
    const view = mount({ presentation: 'grid', grouped: false, detail: 'none', scroll: 'page', items: library(60), scrollTracker: pageTracker() });
    try {
      view.measure(1440);
      await act(async () => {});
      const root = view.query('collection')!;
      await view.update({ presentation: 'list' });
      expect(view.query('collection')).toBe(root);
      await view.update({ presentation: 'grid' });
      await act(async () => {});
      expect(view.query('collection')).toBe(root);
      expect(view.query('row:art-0:card')).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('lands its first cards with the grid on the first paint, before any layout callback (web)', () => {
    // The stage reads its layout box before the browser paints; the platform layout callback comes a frame or more later.
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1440);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
    try {
      const view = mount({ presentation: 'grid', grouped: false, anatomy: described });
      expect(view.query('row:a:card')).not.toBeNull();
      view.unmount();
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

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

  it("keeps a retained group's heading over its loading rows, so its rows land under it (TH-PLACEHOLDER-PARITY-1124)", async () => {
    const grouping = { axis: [{ key: 'needs', title: 'Needs you' }], groupOf: (entry: Entry) => entry.group, retainEmpty: true };
    const view = mount({ presentation: 'list', items: [], loading: true, grouping });
    view.measure(390, 800);
    expect(view.queryAll('collection:skeleton-row').length).toBeGreaterThan(0);
    expect(view.query('collection')?.textContent).toContain('Needs you');
    await view.update({ items: entries.filter((entry) => entry.group === 'needs'), loading: false });
    expect(view.queryAll('collection:skeleton-row')).toHaveLength(0);
    expect(view.query('collection')?.textContent).toContain('Needs you');
    view.unmount();
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

  it('stands no glyph column in the loading rows of a kind that draws no glyph', async () => {
    const rowParts = (loadingGlyph: boolean) => {
      const view = mount({
        presentation: 'list',
        items: [],
        loading: true,
        anatomy: { ...anatomy, loadingGlyph },
      });
      view.measure(1440, 420);
      const row = view.queryAll('collection:skeleton-row')[0]!;
      const parts = Array.from(row.children).filter(part => getComputedStyle(part).position !== 'absolute').length;
      view.unmount();
      return parts;
    };
    // The absolutely positioned divider takes no column. Only the glyph and text contribute to the row grid.
    expect(rowParts(true)).toBe(2);
    expect(rowParts(false)).toBe(1);
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
    expect(getComputedStyle(frame).borderTopWidth).toBe('1px');
    expect(getComputedStyle(frame).borderTopLeftRadius).toBe(`${HAPPIER_PAGE_METRICS.sheetRadiusPx}px`);
    const rows = [
      ...mount.container.querySelectorAll<HTMLElement>(
        '[data-testid="loading:skeleton-row"]',
      ),
    ];
    expect(rows.length).toBeGreaterThan(3);
    // One exact row height, the table's (a plain list placeholder draws four two-line rows).
    expect(new Set(rows.map((row) => row.style.height)).size).toBe(1);
    // The placeholder stands on the rows' own leading inset (as far in as a row's glyph is down), so nothing
    // shifts when the real rows land.
    expect(rows[0]!.style.paddingLeft).toBe('11px');
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

  it('keeps a preview card one material, and gives two narrow cards across a phone a shorter band (owner 11-11 Artifacts 03)', () => {
    const previewed: CollectionAnatomy<Entry> = {
      ...anatomy,
      preview: (entry) => <Text>{`Preview of ${entry.id}`}</Text>,
    };
    const bandHeight = (view: ReturnType<typeof mount>) => Number.parseFloat(view.query('row:a:preview')!.style.height);
    const wide = mount({ presentation: 'grid', grouped: false, anatomy: previewed });
    wide.measure(1440);
    const phone = mount({ presentation: 'grid', grouped: false, anatomy: previewed, minCardWidth: 160 });
    phone.measure(390);
    // Two cards share the phone's row.
    expect(phone.query('row:a:card')!.style.width).toBe(phone.query('row:b:card')!.style.width);
    expect(Number.parseFloat(phone.query('row:a:card')!.style.width)).toBeLessThan(195);
    // The band keeps a full card's proportion, so the narrow card reads as a card, not a preview with a caption.
    expect(bandHeight(phone)).toBeLessThan(bandHeight(wide));
    expect(bandHeight(phone)).toBeGreaterThan(0);
    // The band is drawn on the card's own material (lab A1): no second fill that turns the foot into a slab.
    expect(getComputedStyle(phone.query('row:a:preview')!).backgroundColor).toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
    wide.unmount();
    phone.unmount();
  });

  it('keeps a picture preview at its own proportions on wide and phone cards (lab themes C1)', () => {
    const previewed: CollectionAnatomy<Entry> = {
      ...anatomy,
      preview: (entry) => <Text>{`Preview of ${entry.id}`}</Text>,
      previewAspectRatio: 1.6,
    };
    const ratio = (view: ReturnType<typeof mount>) => Number.parseFloat(view.query('row:a:card')!.style.width)
      / Number.parseFloat(view.query('row:a:preview')!.style.height);
    const wide = mount({ presentation: 'grid', grouped: false, anatomy: previewed });
    wide.measure(1440);
    const phone = mount({ presentation: 'grid', grouped: false, anatomy: previewed, minCardWidth: 160 });
    phone.measure(390);
    expect(ratio(wide)).toBeCloseTo(1.6, 1);
    expect(ratio(phone)).toBeCloseTo(1.6, 1);
    wide.unmount();
    phone.unmount();
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
    // Every flex item in the wrapping foot must carry a fact. An empty item can consume a line and its gap.
    expect(Array.from(foot.children, (fact) => fact.textContent)).toEqual(['Review requested', '18m']);
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
  it('shows the active source field direction on its mapped column and delegates to the source order', async () => {
    const changes: string[] = [];
    const sort = {
      key: 'sort:updated:desc',
      direction: 'descending' as const,
      orders: [
        { key: 'newest', label: 'Newest' },
        { key: 'sort:updated:asc', label: 'Updated: oldest first' },
        { key: 'sort:updated:desc', label: 'Updated: newest first' },
      ],
      orderColumns: { age: ['sort:updated:asc', 'sort:updated:desc'] },
      onChange: (key: string) => { changes.push(key); },
    };
    const view = mount({
      sort,
      renderPopover: (input) => input.open ? input.content({ requestClose: input.onRequestClose, maxHeight: 400 }) : null,
    });
    view.measure(1440);
    expect(view.query('collection:sort:age:arrow')?.textContent).toBe('↓');
    expect(view.query('collection:sort:title:arrow')).toBeNull();
    expect(view.query('collection:sort:age')!.closest('[aria-sort]')!.getAttribute('aria-sort')).toBe('descending');
    act(() => { view.query('collection:sort:age')!.click(); });
    const options = [...view.container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(options.map(option => option.textContent)).toEqual(['Updated: oldest first', 'Updated: newest first']);
    act(() => { options[0]!.click(); });
    expect(changes).toEqual(['sort:updated:asc']);
    await view.update({ sort: { ...sort, key: 'sort:updated:asc', direction: 'ascending' } });
    expect(view.query('collection:sort:age:arrow')?.textContent).toBe('↑');
    expect(view.query('collection:sort:age')!.closest('[aria-sort]')!.getAttribute('aria-sort')).toBe('ascending');
    await view.update({ sort: { ...sort, key: 'newest' } });
    expect(view.query('collection:sort:age:arrow')).toBeNull();
    expect(view.query('collection:sort:age')!.closest('[aria-sort]')!.getAttribute('aria-sort')).toBe('none');
    expect(view.query('collection:sort:title:arrow')?.textContent).toBe('↓');
    view.unmount();
  });

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

  it('reuses the named order owner for an Age column with only the mapped orders', async () => {
    const changes: string[] = [];
    const sort = {
      key: 'newest',
      direction: 'descending' as const,
      orders: [
        { key: 'newest', label: 'Newest' },
        { key: 'oldest', label: 'Oldest' },
        { key: 'smart', label: 'Smart' },
      ],
      orderColumns: { age: ['newest', 'oldest'] },
      onChange: (key: string) => { changes.push(key); },
    };
    const view = mount({
      sort,
      renderPopover: (input) => input.open ? input.content({ requestClose: input.onRequestClose, maxHeight: 400 }) : null,
    });
    view.measure(1440);

    expect(view.query('collection:sort:title:arrow')).toBeNull();
    const trigger = view.query('collection:sort:age')!;
    expect(trigger).not.toBeNull();
    expect(trigger.closest('[aria-sort]')!.getAttribute('aria-sort')).toBe('descending');
    act(() => { trigger.click(); });
    const options = [...view.container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(options.map((option) => option.textContent)).toEqual(['Newest', 'Oldest']);
    act(() => { options[1]!.click(); });
    expect(changes).toEqual(['oldest']);
    await view.update({ sort: { ...sort, key: 'oldest', direction: 'ascending' } });
    expect(view.query('collection:sort:age')!.closest('[aria-sort]')!.getAttribute('aria-sort')).toBe('ascending');
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

const keptHere = { key: 'kept', title: 'Kept here', detail: '2 groups' };
const sectionedProcGroups: HappierCollectionGrouping<Proc> = {
  ...procGroups,
  axis: procGroups.axis.map((group) => ({ ...group, section: keptHere })),
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
  /** Both groups are parts of one page section. */
  sectioned?: boolean;
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
    ...(props.ungrouped ? {} : { groups: props.sectioned ? sectionedProcGroups : procGroups }),
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

  it('hands the search to a header render at a bounded width, says its tokens under that header, and leaves the list pane without it', () => {
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
    // The narrowings stand on the Collection's own line under the header, never inside the field's well.
    expect(input.parentElement!.querySelector('[aria-label="Remove is open"]')).toBeNull();
    expect(view.query('search:tokens')!.querySelector('[aria-label="Remove is open"]')).not.toBeNull();
    expect(toolbar.compareDocumentPosition(view.query('search:tokens')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it("keeps a section's own name on a phone, where the navigation names the page around it", () => {
    const header: CollectionProps<Entry>['header'] = (slots) => (
      <View testID="toolbar">
        {slots.title}
        {slots.search}
      </View>
    );
    // A Collection that is one section of a page (a database Overview's Tables): the phone bar says the page's
    // name, never the section's, so the section heading stays, and never becomes the page's large title.
    for (const pageChrome of [{ showsTitle: true }, { showsTitle: true, largeTitle: true }]) {
      const phone = mount({ search, title: 'Tables', titleKind: 'section', header, pageChrome });
      phone.measure(390);
      const heading = phone.query('toolbar')!.querySelector('[role="heading"]');
      expect(heading?.textContent).toBe('Tables');
      expect([...phone.container.querySelectorAll('[role="heading"]')].filter((node) => node.textContent === 'Tables')).toHaveLength(1);
      phone.unmount();
    }
  });

  it("keeps a page header under a phone's large title to its purpose line, never the name twice", () => {
    // TRIAGE-UI-ACCEPT-1119 F1: a first run's header (the page's mark, name and purpose) sits under the Collection's
    // large title on a phone. The name is already the large title, so the header keeps only its purpose there.
    const header: CollectionProps<Entry>['header'] = () => (
      <PageHeader title="PRs & Issues" description="What needs you." leading={<View testID="page-mark" />} />
    );
    for (const pageChrome of [{ showsTitle: true, largeTitle: true }, { showsTitle: false, largeTitle: true }]) {
      const phone = mount({ search, title: 'PRs & Issues', header, pageChrome });
      phone.measure(390);
      expect([...phone.container.querySelectorAll('[role="heading"]')]
        .filter((node) => node.textContent === 'PRs & Issues')).toHaveLength(1);
      expect(phone.container.textContent).toContain('What needs you.');
      expect(phone.query('page-mark')).toBeNull();
      phone.unmount();
    }
    // Without a large title (a desktop pane) the header keeps its mark and name.
    const desk = mount({ search, title: 'PRs & Issues', header, pageChrome: { showsTitle: false } });
    desk.measure(1440);
    expect(desk.query('page-mark')).toBeTruthy();
    expect(desk.container.textContent).toContain('PRs & Issues');
    desk.unmount();
  });

  it("leads a phone's collection page with its large title when the host's navigation leaves the name to the page", () => {
    const header: CollectionProps<Entry>['header'] = (slots) => (
      <View testID="toolbar">
        {slots.title}
        {slots.search}
      </View>
    );
    // A phone's top-level collection page (lab `merged-list` 390, as core's Inbox, lab `phone-P4`): the bar carries
    // no title, and the page's name stands large above the folded toolbar.
    const phone = mount({
      search,
      title: 'PRs & Issues',
      header,
      pageChrome: { showsTitle: true, largeTitle: true },
    });
    phone.measure(390);
    const toolbar = phone.query('toolbar')!;
    expect(toolbar.querySelector('[role="heading"]')).toBeNull();
    const heading = [...phone.container.querySelectorAll<HTMLElement>('[role="heading"]')]
      .find((node) => node.textContent === 'PRs & Issues');
    expect(heading).toBeTruthy();
    // The page's one display title, the step core's Inbox draws on a phone, not the toolbar's heading.
    // The element's own declaration (RNW's inline style), not jsdom's partial cascade.
    expect(Number.parseFloat(heading!.style.fontSize)).toBe(HAPPIER_PAGE_TEXT.heroTitle.fontSize);
    // It leads: the toolbar comes after it.
    expect(heading!.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    phone.unmount();

    // A page without a name of its own draws none.
    const unnamed = mount({ search, header, pageChrome: { showsTitle: true, largeTitle: true } });
    unnamed.measure(390);
    expect(unnamed.container.querySelector('[role="heading"]')).toBeNull();
    unnamed.unmount();
  });

  it.each(['document', 'shadow'] as const)("gives a phone main screen's large title its Machine, magnifier and + and keeps the search behind the magnifier (%s)", async (rootKind) => {
    // Owner 11-15 (PRs & Issues on an iPhone): the head every phone main screen has (core's `MainScreenHeader`).
    let value = '';
    const changes: string[] = [];
    const searchFor = () => ({ label: 'Search PRs & Issues', value, testID: 'search',
      onValueChange: (next: string) => { changes.push(next); value = next; } });
    const pageChrome = {
      showsTitle: true,
      largeTitle: true,
      renderNavigationActions: (actions: React.ReactNode, placement?: 'navigation' | 'page') => (
        <View testID={`route-actions:${placement ?? 'navigation'}`}><Text>Machine</Text>{actions}</View>
      ),
      renderSearchToggle: (toggle: Readonly<{ open: boolean; onPress: () => void; accessibilityLabel: string;
        testID?: string; controlRef?: (instance: { focus?: () => void } | null) => void }>) => (
        <button type="button" data-testid="magnifier" aria-pressed={toggle.open} aria-label={toggle.accessibilityLabel}
          ref={(node) => toggle.controlRef?.(node)} onClick={toggle.onPress} />
      ),
    };
    const header: CollectionProps<Entry>['header'] = (slots) => (
      <CollectionToolbar slots={slots} testID="toolbar" lens={<Text testID="lens">Mine</Text>}
        primary={{ label: 'New task', testID: 'new-task', onPress: () => undefined }} />
    );
    const view = mount({ title: 'PRs & Issues', search: searchFor(), header, pageChrome });
    const shadowHost = rootKind === 'shadow' ? document.createElement('div') : null;
    if (shadowHost) {
      document.body.append(shadowHost);
      shadowHost.attachShadow({ mode: 'open' }).append(view.container);
    }
    const activeElement = () => (view.container.getRootNode() as Document | ShadowRoot).activeElement;
    view.measure(390);
    const titleLine = () => view.query('collection:large-title')!;
    // The title line carries the route's controls (the Machine), the magnifier and the page's +; the navigation bar
    // and the toolbar draw none of them.
    expect(titleLine().querySelector('[data-testid="route-actions:page"]')).toBeTruthy();
    expect(titleLine().querySelector('[data-testid="magnifier"]')).toBeTruthy();
    expect(titleLine().querySelector('[data-testid="new-task"]')).toBeTruthy();
    expect(view.query('route-actions:navigation')).toBeNull();
    expect(view.query('toolbar')!.querySelector('[data-testid="new-task"]')).toBeNull();
    expect(view.queryAll('new-task')).toHaveLength(1);
    // The lens stays under the title.
    expect(view.query('lens')).toBeTruthy();

    // The keyboard shortcut opens the same disclosure from a row, including a plugin's shadow root.
    expect(view.query('search')).toBeNull();
    const field = () => { const node = view.query('search'); return node === null ? null : node.matches('input') ? node : node.querySelector('input'); };
    await act(async () => {
      const row = view.query('row:a')!;
      row.focus();
      row.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, composed: true, cancelable: true }));
    });
    expect(field()).toBeTruthy();
    expect(activeElement()).toBe(field());
    await act(async () => { view.query('magnifier')!.click(); });
    expect(field()).toBeNull();
    // Pointer opening still focuses the field.
    await act(async () => { view.query('magnifier')!.click(); });
    expect(field()).toBeTruthy();
    expect(activeElement()).toBe(field());

    // A query keeps it open.
    value = 'fix';
    await act(async () => { view.update({ search: searchFor() }); });
    expect(field()).toBeTruthy();

    // The magnifier again clears the query, folds the field away and hands focus back to the magnifier.
    await act(async () => { view.query('magnifier')!.click(); });
    expect(changes.at(-1)).toBe('');
    await act(async () => { view.update({ search: searchFor() }); });
    expect(field()).toBeNull();
    expect(activeElement()).toBe(view.query('magnifier'));

    // A query restored with the page keeps the field open without taking focus.
    view.unmount();
    shadowHost?.remove();
    value = 'restored';
    const restored = mount({ title: 'PRs & Issues', search: searchFor(), header, pageChrome });
    restored.measure(390);
    expect(restored.query('search')).toBeTruthy();
    restored.unmount();
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
      matches: query === '(pointer: fine)' || query === '(hover: hover)',
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
      expect(view.query('happier-list-selection-mode')?.textContent).toBe('Done');
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
      expect(view.query('happier-list-selection-mode')?.textContent).toBe('Done');
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
      action?: React.ReactNode;
      foldedItemId?: string;
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

  it('keeps the search field mounted and focused while the toolbar folds and unfolds across the width breakpoint', () => {
    const view = mount({ search, header: toolbarHeader([]), renderPopover: openPopover });
    view.measure(1440);
    const input = view.query('search.field')!.querySelector('input')!;
    act(() => { input.focus(); });
    expect(document.activeElement).toBe(input);
    // Typing at a wide window, then the window narrows to a phone: the same field keeps the person's focus.
    view.measure(390);
    expect(view.query('search.field')!.querySelector('input')).toBe(input);
    expect(document.activeElement).toBe(input);
    view.measure(1440);
    expect(view.query('search.field')!.querySelector('input')).toBe(input);
    expect(document.activeElement).toBe(input);
    view.unmount();
  });

  it.each([false, true])('opens the filters from the funnel at the search field\'s end, with no chip row (folded=%s)', (folded) => {
    const calls: string[] = [];
    const header = toolbarHeader(calls);
    const view = mount({ search, header: folded
      ? (slots) => <CollectionToolbarCompactContext.Provider value={true}>{(header as (s: typeof slots) => React.ReactNode)(slots)}</CollectionToolbarCompactContext.Provider>
      : header, renderPopover: openPopover });
    view.measure(1440);
    // The funnel is the field's own last control: one place that opens the filters, at every width.
    const field = view.query('search.field')!;
    const funnel = button(field, 'Filters: 2');
    expect(funnel).not.toBeNull();
    expect(funnel!.textContent).toBe('');
    // Nothing stands under the search at rest: no chips, and no second Filters control in the row.
    expect(view.query('toolbar:chips')).toBeNull();
    expect([...view.query('toolbar')!.querySelectorAll('[aria-label="Filters: 2"]')]).toHaveLength(1);
    act(() => { funnel!.click(); });
    expect(view.query('refine:form')).not.toBeNull();
    view.unmount();
  });

  it.each([false, true])('keeps a page\'s inline filter alone on the wide row, and folds it behind the funnel (folded=%s)', (folded) => {
    const toolbar = (
      <CollectionToolbar
        refine={{ label: 'Show runs', inline: true, render: () => <Text testID="refine:scope">All · Mine</Text>,
          sheet: { render: () => <Text testID="refine:form">All · Mine</Text> } }}
        testID="toolbar"
      />
    );
    const view = mount({ search, header: (slots) => {
      const placed = React.cloneElement(toolbar, { slots });
      return folded ? <CollectionToolbarCompactContext.Provider value={true}>{placed}</CollectionToolbarCompactContext.Provider> : placed;
    }, renderPopover: openPopover });
    view.measure(1440);
    expect(button(view.query('search.field')!, 'Show runs') !== null).toBe(folded);
    expect(view.query('refine:scope') !== null).toBe(!folded);
    view.unmount();
  });

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
    // The lead now wraps inside its share: a healthy freshness gives its words up first, the row measures itself
    // again without them (no layout event need follow) and, still wrapped, folds.
    expect(view.query('refine:toolbar')).toBeNull();
    view.unmount();
  });

  it.each(['accessory', 'pageActions', 'title'] as const)('remeasures at the same pane width when the folded %s gets narrower', (slot) => {
    const header: CollectionProps<Entry>['header'] = (slots) => <CollectionToolbar
      slots={{ ...slots, ...(slot === 'accessory' ? {} : { [slot]: <Text>Run on this machine</Text> }) }}
      accessory={slot === 'accessory' ? <Text>Run on this machine</Text> : undefined}
      refine={{ label: 'Filters', render: () => <Text testID="refine:toolbar">Refine</Text>, sheet: { render: () => null } }}
      testID="toolbar"
    />;
    const view = mount({ search, header });
    view.measure(1440);
    const layout = (id: string, width: number, height = 36) => act(() => {
      reportToolbarLayout(view, id, 0, width, height);
    });
    layout('toolbar:lead', 900);
    layout('toolbar:trail', 450, 32);
    layout('toolbar', 1300, 76);
    expect(view.query('refine:toolbar')).toBeNull();
    const content = [...view.query('toolbar')!.querySelectorAll<HTMLElement>('div')]
      .find((node) => node.textContent === 'Run on this machine' && node.childElementCount === 0)!.parentElement!;
    const measured = content as unknown as { __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void };
    act(() => measured.__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y: 0, width: 260, height: 36 } } }));
    act(() => measured.__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y: 0, width: 120, height: 36 } } }));
    expect(view.query('refine:toolbar')).not.toBeNull();
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
    // The one row: the funnel stays the field's own control, with no round folded button beside ⋯.
    expect(view.query('search.field')!.contains(button(view.query('toolbar')!, 'Filters: 2'))).toBe(true);
    view.unmount();
  });

  it('gives up a healthy freshness\'s words before it gives up the one row, and keeps them one tap away', () => {
    const view = mount({ search, header: toolbarHeader([], { tone: 'muted', label: 'Updated 10 minutes ago' }), renderPopover: openPopover });
    view.measure(1120);
    const toolbar = view.query('toolbar')!;
    expect(toolbar.textContent).toContain('Updated 10 minutes ago');
    reportToolbarLayout(view, 'toolbar:lead', 0, 650, 36);
    reportToolbarLayout(view, 'toolbar', 0, 1000, 36);
    // The trailing group is as wide as what it draws: without the words it is narrower.
    const trail = view.query('toolbar:trail') as unknown as {
      measureInWindow: (callback: (...values: number[]) => void) => void;
      __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void;
    };
    trail.measureInWindow = (callback) => callback(0, 0, toolbar.textContent!.includes('Updated 10 minutes ago') ? 450 : 300, 32);
    act(() => trail.__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y: 0, width: 450, height: 32 } } }));
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

  it('folds a row that still wraps once its healthy freshness went quiet, without another layout event', () => {
    const view = mount({ search, header: toolbarHeader([]), renderPopover: openPopover });
    view.measure(1120);
    // A list column beside a detail pane: the one row wraps into several lines. Giving up the freshness's words
    // leaves every box the same size (the trailing group still fills its lines), so no further layout event arrives.
    const boxes: Record<string, readonly [number, number]> = {
      toolbar: [400, 124], 'toolbar:lead': [400, 80], 'toolbar:trail': [388, 120],
    };
    for (const [id, [width, height]] of Object.entries(boxes)) {
      const node = view.query(id) as unknown as { measureInWindow: (callback: (...values: number[]) => void) => void };
      node.measureInWindow = (callback) => callback(0, 0, width, height);
    }
    act(() => (view.query('toolbar') as unknown as { __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void })
      .__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 124 } } }));
    expect(view.query('refine:toolbar')).toBeNull();
    view.unmount();
  });

  it('never hides a freshness that is warning the reader to keep the one row', () => {
    const view = mount({ search, header: toolbarHeader([], { tone: 'warning', label: 'Stale since 09:00' }), renderPopover: openPopover });
    view.measure(1120);
    reportToolbarLayout(view, 'toolbar:views', 0, 146, 32);
    reportToolbarLayout(view, 'toolbar:lead', 0, 650, 36);
    reportToolbarLayout(view, 'toolbar', 0, 1000, 36);
    reportToolbarLayout(view, 'toolbar:trail', 0, 450, 32);
    expect(view.query('refine:toolbar')).toBeNull();
    expect(view.query('toolbar')!.textContent).toContain('Stale since 09:00');
    view.unmount();
  });

  it.each([
    { trailingWidth: 320, folds: false },
    { trailingWidth: 430, folds: true },
  ])('gives up the view labels before folding a wide row with source attention (folds=$folds)', async ({ trailingWidth, folds }) => {
    const calls: string[] = [];
    const view = mount({ search, header: toolbarHeader(calls), renderPopover: openPopover });
    try {
      view.measure(1120);
      const row = view.query('toolbar')!;
      const lead = view.query('toolbar:lead')!;
      const trail = view.query('toolbar:trail')!;
      const choices = trail.querySelector('[role="radiogroup"]')!;
      expect(choices.textContent).toContain('Board');
      const box = (node: Element, width: number) => {
        node.getBoundingClientRect = () => DOMRect.fromRect({ width, height: 36 });
        Object.assign(node, { measureInWindow: (read: (...values: number[]) => void) => read(0, 0, width, 36) });
      };
      // Supply the platform boxes the first warning layout gets. The button track can save enough in the first case only.
      box(row, 1000);
      box(lead, 710);
      box(trail, trailingWidth);
      const viewControls = view.query('toolbar:views');
      if (viewControls !== null) box(viewControls, 146);
      await view.update({ header: toolbarHeader(calls, {
        tone: 'muted', label: '7 sources need attention', indicator: true, action: <Text>Manage</Text>, foldedItemId: 'manage-sources',
      }) });
      const didFitBeforeLayoutEvent = view.query('toolbar:trail')?.textContent?.includes('Board') === false;
      if (!didFitBeforeLayoutEvent && view.query('toolbar:trail') !== null) {
        reportToolbarLayout(view, 'toolbar', 0, 1000, 36);
      }
      const wide = view.query('toolbar:trail');
      expect(wide === null).toBe(folds);
      const board = view.container.querySelector('[role="radio"][aria-label="Board"]');
      expect(board).not.toBeNull();
      expect(board!.textContent).toBe('');
      if (wide !== null) {
        expect(didFitBeforeLayoutEvent).toBe(true);
        expect(wide.textContent).toContain('7 sources need attention');
        expect(view.query('toolbar:lead')!.parentElement).toBe(wide.parentElement);
      }
    } finally {
      view.unmount();
    }
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
    // A healthy freshness gives its words up first; the row measures itself again without them and still does not fit.
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

  it('folds when its leading controls wrap inside their own share of the row, not only when the trailing group wraps', () => {
    const view = mount({ search, header: toolbarHeader([]), renderPopover: openPopover });
    view.measure(1120);
    expect(view.query('refine:toolbar')).not.toBeNull();
    // Beside a details pane the lead fits its share of the row by breaking onto a second line: two rows, no overflow by width.
    reportToolbarLayout(view, 'toolbar:lead', 0, 650, 80);
    reportToolbarLayout(view, 'toolbar:trail', 0, 300, 32);
    reportToolbarLayout(view, 'toolbar', 0, 1000, 80);
    expect(view.query('refine:toolbar')).toBeNull();
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
    reportToolbarLayout(view, 'toolbar:views', 44, 146, 32);
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
    const filters = button(view.query('search.field')!, 'Filters: 2')!;
    expect(filters).not.toBeNull();
    // The line under the field says what is on; the funnel draws no count of its own.
    expect(filters.textContent).toBe('');
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

  it('folds quiet source attention into its existing recovery item on a phone', () => {
    const calls: string[] = [];
    const label = '2 sources need attention.';
    const view = mount({
      search,
      header: toolbarHeader(calls, {
        tone: 'muted', label, foldedItemId: 'manage-sources',
        action: <Button title="Manage sources" onPress={() => calls.push('manage-sources')} />,
      }),
      renderPopover: openPopover,
    });
    view.measure(390);
    const toolbar = view.query('toolbar')!;
    expect(toolbar.textContent).not.toContain(label);
    act(() => button(toolbar, 'More')!.click());
    const items = [...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(item => item.textContent)).toEqual(['Refresh', `Manage sources${label}`]);
    act(() => items[1]!.click());
    expect(calls).toEqual(['manage-sources']);
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

  it('draws a grouped list with totals as one table: the bar, every band and row, then the totals on one sheet', () => {
    const view = mountTree({ presentation: 'list', scroll: 'page', sort, summaryRows });
    view.measure(390);
    const bar = view.query('procs:sheet-header');
    expect(bar).not.toBeNull();
    const sheetBody = bar!.parentElement!;
    for (const row of view.rows()) expect(sheetBody.contains(view.rowElement(row))).toBe(true);
    expect(sheetBody.textContent).toContain('Left behind');
    expect(sheetBody.textContent).toContain('Happier in total');
    view.unmount();
  });

  it('draws groups that are parts of one page section under its one heading, on one sheet with their sub-headings', () => {
    const view = mountTree({ presentation: 'list', scroll: 'page', sectioned: true });
    // A phone's page sections (wider, the list is a table in one sheet, its groups bands: owner 2026-11-19).
    view.measure(390);
    const text = view.container.textContent ?? '';
    // One heading names the section and its quiet fact, once.
    expect(text.split('Kept here')).toHaveLength(2);
    expect(text).toContain('2 groups');
    // The first group's first row and the last group's last row share one sheet, which holds both sub-headings
    // but not the section's own heading.
    const rows = view.rows();
    let sheet = view.rowElement(rows[0]!).parentElement!;
    while (!sheet.contains(view.rowElement(rows[rows.length - 1]!))) sheet = sheet.parentElement!;
    // The web middle ellipsis preserves the space between its runs as a nonbreaking space.
    expect(sheet.textContent?.replace(/\s/gu, ' ')).toContain('Started by Happier');
    expect(sheet.textContent).toContain('Left behind');
    expect(sheet.textContent).not.toContain('Kept here');
    view.unmount();
  });

  // A phone's page sections (owner rule 11-15, MONITOR-ACCEPT F3); wider, the list is a table in one sheet whose groups are
  // filled bands (owner 2026-11-19), asserted below.
  it('titles each group sharing a page section with its count on its rows\' edge, never a filled band on a phone; a band in the wide table\'s sheet', () => {
    for (const width of [390, 1200]) {
      const view = mountTree({ presentation: 'list', scroll: 'page', sectioned: true });
      view.measure(width);
      const rows = view.rows();
      let sheet = view.rowElement(rows[0]!).parentElement!;
      while (!sheet.contains(view.rowElement(rows[rows.length - 1]!))) sheet = sheet.parentElement!;
      // Its title, then how many rows it holds (lab monitoring-1115 `.msec` "Checks 5"), on a phone too.
      expect(sheet.textContent?.replace(/\s/gu, ' ')).toContain('Started by Happier7');
      // No group heading is a filled band: from the title up to the sheet, nothing paints a fill of its own.
      // The deepest element that holds the whole title (a web middle ellipsis splits it into runs).
      const title = [...sheet.querySelectorAll('*')].filter((node) => node.textContent?.replace(/\s/gu, ' ') === 'Left behind').at(-1)!;
      expect(title).toBeDefined();
      const fills: string[] = [];
      for (let node: Element | null = title; node !== null && node !== sheet; node = node.parentElement) {
        const fill = getComputedStyle(node).backgroundColor;
        if (!/^(|transparent|rgba\(0, 0, 0, 0\))$/.test(fill)) fills.push(fill);
      }
      expect(fills.length > 0).toBe(width > 390);
      view.unmount();
    }
  });

  // LABPARITY-ACCEPT-E fix 4: the Machines index's sections ("Your machines", "Created by Happier") lost their counts
  // when it became a page list. One group-label anatomy (owner 2026-11-17): every titled group says how many it holds.
  it('titles each group that is its own page section with its count, as a band does', () => {
    for (const width of [1200, 390]) {
      const view = mountTree({ presentation: 'list', scroll: 'page' });
      view.measure(width);
      expect(view.container.textContent?.replace(/\s/gu, ' ')).toMatch(/Started by Happier ?7/u);
      view.unmount();
    }
  });

  it('gives each group sharing a page section its own action, beside its own sub-heading', () => {
    const opened: string[] = [];
    const view = mountTree({ presentation: 'list', scroll: 'page', sectioned: true,
      groupAction: (groupKey) => ({ kind: 'link', label: 'Open', onPress: () => { opened.push(groupKey); } }) });
    view.measure(1200);
    const rows = view.rows();
    let sheet = view.rowElement(rows[0]!).parentElement!;
    while (!sheet.contains(view.rowElement(rows[rows.length - 1]!))) sheet = sheet.parentElement!;
    for (const key of ['happier', 'left']) {
      const action = view.query(`procs:group:${key}:action`);
      expect(action).not.toBeNull();
      // On the sheet with its group, once, not on the section heading that names both groups.
      expect(sheet.contains(action)).toBe(true);
      expect(view.container.querySelectorAll(`[data-testid="procs:group:${key}:action"]`)).toHaveLength(1);
      act(() => { action!.click(); });
    }
    expect(opened).toEqual(['happier', 'left']);
    view.unmount();
  });

  it('leaves grouped lists without totals, and unsorted page lists, to their section titles', () => {
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


describe('a Collection on an unavailable execution surface', () => {
  it('settles an empty loading window as one host notice while retaining cached rows', () => {
    const surfaceNotice = { sentence: 'No machine can run this yet.', claim: () => () => undefined };
    const loading = mount({ items: [], grouped: false, loading: true, footer: <Text>Reading sources</Text>, surfaceNotice });
    expect(loading.container.textContent).toContain(surfaceNotice.sentence);
    expect(loading.container.textContent).not.toContain('Reading sources');
    expect(loading.container.querySelector('[data-testid="collection:skeleton-row"]')).toBeNull();
    loading.unmount();
    const cached = mount({ loading: true, surfaceNotice });
    expect(cached.query('row:a')).not.toBeNull();
    expect(cached.container.textContent).not.toContain(surfaceNotice.sentence);
    cached.unmount();
  });
});
