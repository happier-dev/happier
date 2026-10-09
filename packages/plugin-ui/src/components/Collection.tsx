import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Platform, ScrollView, View } from 'react-native';

import {
  resolveHappierUiPalette,
  useHappierUiAccessibility,
  useHappierUiTheme,
  useOptionalHappierUiPalette,
  useOptionalHappierUiPlatform,
  useOptionalHappierUiTypography,
} from '../environment/context.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { useHappierPageSection } from '../presentation/layout/PageSection.js';
import { HAPPIER_RADIUS_V1 } from '../environment/radius.js';
import { HappierStatusDot } from '../presentation/status/StatusDot.js';
import { PluginUiIconGlyph, type IconName } from './Icon.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../presentation/semantics.js';
import type { HappierTypeRole } from '../environment/types.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { HappierCollectionLayoutContext, resolveHappierCollectionLayoutState } from '../presentation/collection/collectionLayout.js';
import { HappierCollectionTableRowContext } from '../presentation/collection/CollectionList.js';
import {
  HAPPIER_COLLECTION_INSTANT_MOTION,
  HAPPIER_INSTANT_DISCLOSURE_MOTION,
  type HappierCollectionMotionValue,
} from '../presentation/collection/collectionMotion.js';
import type { HappierCollectionKey } from '../presentation/collection/collectionModel.js';
import {
  HAPPIER_COLLECTION_REDUCED_MOTION_TRACKS,
  HAPPIER_COLLECTION_TRANSITION_TRACKS,
  happierCollectionTravelTrack,
  planHappierCollectionTransitionOffsets,
  resolveHappierCollectionComposition,
  resolveHappierCollectionTableColumns,
  type HappierCollectionComposition,
  type HappierCollectionDetailContainer,
  type HappierCollectionMotionTracks,
  type HappierCollectionPresentation,
  type HappierCollectionTableColumn,
  type HappierCollectionTransitionCell,
  type HappierCollectionTransitionPlan,
} from '../presentation/collection/collectionTable.js';
import { HappierDisclosure } from '../presentation/collection/Disclosure.js';
import { resolveHappierListDetailGeometry } from '../presentation/collection/listDetailGeometry.js';
import { useHappierCollectionViewport, type HappierCollectionModel, type HappierCollectionViewport } from '../presentation/collection/useCollection.js';
import { HappierPressable } from '../presentation/interaction/Pressable.js';
import type { HappierLayoutChangeEvent, HappierPortableStyle } from '../presentation/portableTypes.js';
import { HappierText } from '../presentation/text/Text.js';
import { CollectionCards, CollectionGroupActionButton, readCollectionLineHeight } from './CollectionCards.js';
import { HappierSkeletonBlock } from '../presentation/feedback/Skeleton.js';
import { List, ListItemSelectionContext, type ItemProps, type ListMultiSelectionCapabilityProps, type ListSingleChoiceCapabilityProps, type ListSectionData, type ListSelectionProps } from './List.js';
import { encodeHappierSectionRowCellKey, resolveHappierRovingTabStop } from '../presentation/collection/semantics.js';
import { HappierRadioMark } from '../presentation/form/RadioMark.js';
import { HappierChevron } from '../presentation/collection/DisclosureChevron.js';
import { ListCollectionControlContext, type ListCollectionControl } from './listCollectionControl.js';
import { CollectionKeyCap, ListCollectionHeader, useListCollectionSearch, type ListCollectionSearchToken } from './listCollectionHeader.js';
import { ListMultiSelectionProvider } from './ListMultiSelection.js';
import { renderCollectionItemDestination } from './collectionItemDestination.js';
import { DetailsPane, useDetailsPaneAvailable, useDetailsPaneHostInstalled } from './DetailsPane.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import type { NavigationListDestination } from './NavigationList.js';
import { CollectionDetailHeadingFocusContext, useCollectionDetailHeadingFocusInternal } from './Focus.js';
import { CollectionVirtualizerContext, type CollectionVirtualizer } from '../presentation/collection/collectionVirtualizer.js';
import { useOptionalPluginUiScrollActivityTracker } from '../presentationHost/scrollActivity.js';

/**
 * The Collection (COLLECTION.md §3–§4, §7, §10.1): one item anatomy drawn as a `table` at rest and as a `list` beside
 * the open item's detail, or as `board` / `grid` cards, with `detail: 'auto'` choosing the container: the page's app
 * details pane where the host places the page in a pane host (the table narrows beside it; cards stay; pushed while
 * the pane is not beside the page), else the in-page split by measured geometry, else the pushed detail. The detail
 * is one component in every container.
 *
 * It presents through the one List row/virtualization engine (`List.tsx`). The model owns logical focus and
 * navigation; List retains physical reveal, row actions, multi-selection and semantics. Collection adds the anatomy, the column
 * priorities, the peek row, the containers and the table ⇄ split shared-element move. Table and split are one
 * presentation with two geometries: the same List and the same row cells, so opening never remounts a row.
 */

/** An extra table column beside the anatomy slots. */
export type CollectionField<Item> = Readonly<{
  key: string;
  title: string;
  render: (item: Item) => ReactNode;
  /** The narrowest readable width at normal text size; it scales with the reader's text size. */
  minWidth: number;
  /** Lower drops first when the table is narrow. */
  priority: number;
  align?: 'start' | 'end';
}>;

/** The one item anatomy every presentation draws from. Renderers are pure. */
export type CollectionAnatomy<Item> = Readonly<{
  /** A domain card body inside the shared Board activation/focus/scroll owner. */
  boardContent?: (item: Item) => ReactNode;
  /** Shareable qualified page/location for this item, without transferring selection or navigation ownership. */
  destination?: (item: Item) => NavigationListDestination | null;
  /** A core destination owner may decorate the shared row/card without replacing its anatomy or activation. */
  wrapItem?: (item: Item, content: ReactNode) => ReactNode;
  glyph: (item: Item) => ReactNode;
  /**
   * A small mark pinned to the glyph's lower corner in the list (the agent working on the item), on a plate
   * ringed in its tone. The table says the same in its Agent column, so the table draws no badge.
   */
  glyphBadge?: (item: Item) => CollectionGlyphBadge | null;
  title: (item: Item) => string;
  /**
   * The item's short designation ("#2481", "!88"), quiet after the title in the table's Entry cell. The list
   * says it in its `byline` instead.
   */
  titleSuffix?: (item: Item) => string | null;
  /** Where the item lives ("payments-api"): the table's Where column. */
  where?: (item: Item) => ReactNode;
  /**
   * The list row's second line, where there is room for who as well as where ("payments-api #2481 · Mara
   * Oduya"). Defaults to `where`.
   */
  byline?: (item: Item) => ReactNode;
  /** The one loud fact. */
  reason?: (item: Item) => ReactNode;
  signal?: (item: Item) => ReactNode;
  agent?: (item: Item) => ReactNode;
  /** Tabular age ("18m"). */
  age?: (item: Item) => string | null;
  fields?: readonly CollectionField<Item>[];
  /** The table-only peek body. */
  peek?: (item: Item) => ReactNode;
  /**
   * The item itself at static props (a document's first lines, a board's columns), drawn as a grid card's preview
   * band above its title. Grid only; every card in the grid reserves the band, so rows stay equal. Pure: no
   * subscriptions or requests.
   */
  preview?: (item: Item) => ReactNode;
  /** What the item is for, in a sentence; a grid card reserves exactly two lines for it. */
  description?: (item: Item) => string | null;
  /**
   * A grid card's one footer action (Install, Manage, a switch), right of its status (`reason`). It is its own
   * press and focus target beside the card's and never opens the item.
   */
  action?: (item: Item) => ReactNode;
  /** The composed row name ("Pull request #2481, Review requested"). */
  accessibilityLabel: (item: Item) => string;
  accessibilityHint?: (item: Item) => string | undefined;
  testID?: (item: Item) => string;
  /** Column titles for the table header, one per slot the anatomy declares. */
  columnTitles: Readonly<{ title: string; where?: string; reason?: string; signal?: string; agent?: string; age?: string }>;
}>;

/**
 * The glyph's corner mark: an icon, live dot, or contributed mark drawn at the supplied owner slot size; `tone` inks the mark and rings its
 * plate (none: the quiet border). The Collection draws and sizes it, so every badge in a list is one size.
 */
export type CollectionGlyphBadge = Readonly<
  { icon: IconName; tone?: HappierTone } | { live: true; tone?: HappierTone } | { mark: (pixelSize: number) => ReactNode; tone?: HappierTone }
>;

/** A group header's one action. */
export type CollectionGroupAction = Readonly<{ label: string; onPress: () => void }>;

/** A row's own controls, beside the row's press target (the grid's sibling cell). */
type CollectionRowActionItems = readonly Omit<NonNullable<ItemProps['secondaryActions']>[number], 'icon'>[];

/**
 * Keep the secondary-action callback and its items one discriminated capability. List.Item
 * intentionally rejects a half-configured overflow menu; Collection must preserve that owner
 * contract instead of widening the props and relying on a runtime conjunction at the call site.
 */
export type CollectionRowActions = Readonly<{
  accessory?: ReactNode;
  accessoryWraps?: boolean;
  busy?: boolean;
}> & (
  | Readonly<{
      secondaryActions: CollectionRowActionItems;
      secondaryActionAccessibilityLabel?: string;
      onSecondaryAction: (id: string) => void;
    }>
  | Readonly<{
      secondaryActions?: undefined;
      secondaryActionAccessibilityLabel?: never;
      onSecondaryAction?: undefined;
    }>
);

/**
 * The selected item's identity and actions, rendered by the host's details header: its title, the line under it,
 * the item's own mark beside the title (no tile) and a mark leading the line (where it comes from).
 */
export type CollectionDetailHeader = Readonly<{
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  subtitleLeading?: ReactNode;
  actions?: ReactNode;
}>;

export type CollectionDetailRenderContext = Readonly<{
  /** The host already draws the identity band; the detail keeps only its body facts. */
  headerHosted: boolean;
}>;

/** Controlled local choice; changing it never opens the model's detail. */
export type CollectionSingleChoice<Item> = Omit<ListSingleChoiceCapabilityProps<Item>, 'isItemSelectable' | 'unavailableReason'> & Readonly<{
  isItemSelectable?: (item: Item) => boolean;
  unavailableReason?: (item: Item) => string | null;
}>;

export type CollectionProps<Item> = Readonly<{
  model: HappierCollectionModel<Item>;
  anatomy: CollectionAnatomy<Item>;
  accessibilityLabel: string;
  /**
   * How the Collection rests; `table` becomes the list beside a detail and on narrow screens. `board` and `grid`
   * keep their cards and open the detail in the page's details pane (pushed where there is none). The caller owns the
   * choice (and remembers it); switching keeps the model, the open item and its mounted detail.
   */
  presentation?: HappierCollectionPresentation;
  /** An explicit domain projection; omitted keeps the responsive column pager. */
  boardLayout?: 'columns' | 'stacked';
  detail?: HappierCollectionDetailContainer;
  /** The one detail component, in every container. */
  renderDetail?: (key: HappierCollectionKey, context: CollectionDetailRenderContext) => ReactNode;
  /**
   * The open item's identity and actions for the host's details header band. The host supplies Close.
   * Outside the host pane, `renderDetail` receives `headerHosted: false` and owns its inline header.
   */
  detailHeader?: (key: HappierCollectionKey) => CollectionDetailHeader;
  /** Pane minima (the caller's readable measures at the reader's text size) and the split preference. */
  minListWidth: number;
  minDetailWidth: number;
  preferredListRatio: number;
  /** The grid's narrowest card at normal text size; its columns follow the measured width. */
  minCardWidth?: number;
  /**
   * One action at the end of a group's header ("See all" on a shelf the caller shortened, "All results" on the one
   * it focused), by group key; `null` where the group has none. Drawn on grid shelves and on list and table groups.
   */
  groupAction?: (groupKey: string) => CollectionGroupAction | null;
  /**
   * `page`: a page-sized collection scrolls as the page — its `header`, every row and its `footer` in one scroller
   * and one reading and focus order, with no virtualization (for a few dozen items, not an open-ended feed).
   * `collection` (default): the rows scroll inside the Collection, virtualized, under a fixed header.
   * `page-virtualized`: a table (including its responsive list) windows in a positioned containing page;
   * otherwise uses collection scrolling.
   */
  scroll?: 'collection' | 'page' | 'page-virtualized';
  /** Platform adapter for collection-scrolling Lists; page modes retain the containing page's scroll owner. */
  virtualizer?: CollectionVirtualizer;
  /**
   * The items are still arriving: the table and list hold their row geometry with skeleton rows that fill the
   * view, and a grid with skeleton cards (the last known count). `empty` is shown only once loading is over.
   */
  loading?: boolean;
  /**
   * A row's controls. Called as a hook inside each row, so it must be one stable module-level hook; it may read
   * the caller's own context.
   */
  useRowActions?: (item: Item) => CollectionRowActions;
  selection?: Readonly<{
    onFocusedKeyChange?: (key: HappierCollectionKey) => void;
    focusRequest?: Readonly<{ key: string }>;
    isItemActivatable?: (item: Item) => boolean;
  }> & (
    | Readonly<{ single: CollectionSingleChoice<Item>; multiple?: never }>
    | Readonly<{ single?: never; multiple?: Readonly<{
      store: ListMultiSelectionCapabilityProps['store'];
      isItemSelectable?: (item: Item) => boolean;
      retainedSelectionKeys?: readonly string[];
    }> }>
  );
  /** The List's search field; the model owns what matches. `tokens` are the narrowings in force, removable. */
  search?: Readonly<{
    label: string;
    value: string;
    onValueChange: (value: string) => void;
    onComposingValueChange?: (value: string | null) => void;
    placeholder?: string;
    tokens?: readonly ListCollectionSearchToken[];
    testID?: string;
  }>;
  empty?: ReactNode;
  /**
   * The page's own chrome above the Collection (a toolbar, notices), across both panes. It sits inside the
   * Collection's layout, so it reads the measured mode (`useHappierCollectionLayout`) like everything else inside.
   * A `grid` scrolls it with the cards (a page of cards reads as one page); the other views keep it fixed.
   */
  header?: ReactNode;
  /** Content below the rows (a bulk bar): fixed, except in a `grid`, where it scrolls with the cards. */
  footer?: ReactNode;
  /**
   * The window-honesty line ("12 loaded · Azure DevOps has more"), one fact per part; continuations come from the
   * model window.
   */
  windowStatement?: string | readonly string[];
  testID?: string;
  listTestID?: string;
  detailTestID?: string;
}>;

type CollectionCell<Item> =
  | Readonly<{ kind: 'item'; key: string; item: Item }>
  | Readonly<{ kind: 'peek'; key: string; itemKey: string; item: Item }>;

/** Table geometry, at normal text size. */
const TABLE = Object.freeze({
  insetStart: 20,
  insetEnd: 8,
  glyphWidth: 34,
  gap: 12,
  chevronWidth: 28,
  titleMinWidth: 240,
  paddingY: 10,
  headerHeight: 32,
  footerHeight: 34,
  /** The glyph's corner badge: its plate, how far it hangs past the glyph, and the surface ring cutting it out. */
  glyphBadge: 15,
  glyphBadgeMark: 10,
  glyphBadgeOverhang: 6,
  glyphBadgeCutout: 1.5,
});

const SLOT_COLUMNS = Object.freeze({
  where: { minWidth: 150, priority: 4 },
  reason: { minWidth: 172, priority: 5 },
  signal: { minWidth: 124, priority: 2 },
  agent: { minWidth: 150, priority: 3 },
  age: { minWidth: 46, priority: 6, align: 'end' as const },
});
type SlotKey = keyof typeof SLOT_COLUMNS;
const SLOT_KEYS: readonly SlotKey[] = ['where', 'reason', 'signal', 'agent', 'age'];

type ResolvedColumn<Item> = HappierCollectionTableColumn & Readonly<{
  title: string;
  align: 'start' | 'end';
  render: ((item: Item) => ReactNode) | null;
}>;

type CollectionTransition =
  | Readonly<{
      kind: 'travel' | 'fade';
      anchorKey: HappierCollectionKey;
      plan: HappierCollectionTransitionPlan;
    }>;

type CollectionView = Readonly<{
  composition: HappierCollectionComposition;
  transition: CollectionTransition | null;
  scrollRequest: Readonly<{ offset: number }> | null;
}>;

type CollectionStage<Item> = Readonly<{
  composition: HappierCollectionComposition;
  geometry: 'table' | 'list';
  transition: CollectionTransition | null;
  progress: HappierCollectionMotionValue;
  columns: readonly ResolvedColumn<Item>[];
  metrics: RowMetrics;
  anatomy: CollectionAnatomy<Item>;
  /**
   * The two model facts a row reads. Never the model itself: it is a new object on every Collection render
   * (focus, the open item), and every mounted row reads the stage, so carrying it re-rendered them all.
   */
  expanded: ReadonlySet<HappierCollectionKey>;
  toggleExpanded: (key: HappierCollectionKey) => void;
  /**
   * The list is the resting view (a phone, a narrow page) and no row travels to or from a table: titles may
   * take two lines and rows size to them. Beside a detail rows keep the exact height the travel plans with.
   */
  wrapTitles: boolean;
  pageSections: boolean;
  useRowActions: ((item: Item) => CollectionRowActions) | undefined;
  expandable: boolean;
  /** On a page section's sheet: the rows that draw the sheet's hairline below them (every row but a group's last). */
  dividedKeys: ReadonlySet<string> | null;
  onPeekHeight: (key: string, height: number) => void;
  onPeekSettled: (key: string, expanded: boolean) => void;
}>;

type RowMetrics = Readonly<{
  /** Cell heights (each includes the row press target's 1 pt border, top and bottom). */
  tableRow: number;
  listRow: number;
  groupHeader: number;
  titleRole: HappierTypeRole;
}>;

const NO_TRACKS: HappierCollectionMotionTracks = Object.freeze({});
const NO_ROW_ACTIONS: CollectionRowActions = Object.freeze({});
const NO_CELLS: readonly never[] = Object.freeze([]);
const CollectionStageContext = createContext<CollectionStage<unknown> | null>(null);

function useRowMetrics(): RowMetrics {
  const theme = useHappierUiTheme();
  const typography = useOptionalHappierUiTypography();
  const { textScale } = useHappierUiAccessibility();
  return useMemo(() => {
    // The host's row anatomy: the row title role over the row meta role (`label` / `body`).
    const title = readCollectionLineHeight('label', theme, typography, textScale);
    const meta = readCollectionLineHeight('body', theme, typography, textScale);
    const label = readCollectionLineHeight('label', theme, typography, textScale);
    return {
      // One exact height per geometry and text-size bucket, never measured per row (COLLECTION.md §7).
      tableRow: Math.max(40, title + 2 * TABLE.paddingY) + 2,
      listRow: title + 4 + meta + 2 * TABLE.paddingY + 2,
      groupHeader: label + 18,
      titleRole: 'label',
    };
  }, [textScale, theme, typography]);
}

function resolveColumns<Item>(
  anatomy: CollectionAnatomy<Item>,
  width: number,
  textScale: number,
  rowAccessoryWidth: number,
): readonly ResolvedColumn<Item>[] {
  const declared: ResolvedColumn<Item>[] = [{
    key: 'title',
    title: anatomy.columnTitles.title,
    minWidth: TABLE.titleMinWidth * textScale,
    priority: Number.POSITIVE_INFINITY,
    flex: true,
    align: 'start',
    render: null,
  }];
  for (const slot of SLOT_KEYS) {
    const render = anatomy[slot];
    if (render === undefined) continue;
    const column = SLOT_COLUMNS[slot];
    declared.push({
      key: slot,
      title: anatomy.columnTitles[slot] ?? '',
      minWidth: column.minWidth * textScale,
      priority: column.priority,
      align: 'align' in column ? column.align : 'start',
      render: slot === 'age' ? (item) => (anatomy.age?.(item) ?? null) : render as (item: Item) => ReactNode,
    });
  }
  for (const field of anatomy.fields ?? []) {
    declared.push({
      key: `field:${field.key}`,
      title: field.title,
      minWidth: field.minWidth * textScale,
      priority: field.priority,
      align: field.align ?? 'start',
      render: field.render,
    });
  }
  const available = width - TABLE.insetStart - TABLE.insetEnd - TABLE.glyphWidth - TABLE.gap - rowAccessoryWidth;
  return resolveHappierCollectionTableColumns({ columns: declared, availableWidth: available, gap: TABLE.gap });
}

/** Whether the table at this width shows any column beside the title (an anatomy with no columns always does). */
function tableShowsBesideTitle<Item>(
  anatomy: CollectionAnatomy<Item>,
  width: number,
  textScale: number,
  rowAccessoryWidth: number,
): boolean {
  const declared = SLOT_KEYS.some((slot) => anatomy[slot] !== undefined) || (anatomy.fields?.length ?? 0) > 0;
  return !declared || resolveColumns(anatomy, width, textScale, rowAccessoryWidth).length > 1;
}

/** The first fact never shrinks, the last only once the middle is gone, the middle first. */
function windowPartShrink(index: number, count: number): number {
  if (index === 0) return 0;
  return index === count - 1 ? 1 : 1_000_000;
}

/** Placeholder title widths, deterministic so a refresh never shimmers into a different shape. */
const SKELETON_TITLE_WIDTHS = ['62%', '48%', '71%', '55%', '66%', '44%'] as const;

/**
 * The rows that are coming, standing in their own geometry while the first window loads: the row height of
 * the current geometry, the glyph, the title (and the meta line in the list), the row hairline — as many as
 * fill what is on screen, so nothing moves when the real rows land and "empty" is never said early.
 */
function CollectionSkeletonRows(props: Readonly<{
  rowHeight: number;
  twoLines: boolean;
  viewportHeight: number | null;
  testID?: string;
}>): ReactElement {
  const theme = useHappierUiTheme();
  const palette = useOptionalHappierUiPalette() ?? resolveHappierUiPalette(theme);
  const count = props.viewportHeight === null ? 1 : Math.max(1, Math.ceil(props.viewportHeight / props.rowHeight));
  return (
    <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: count }, (_, index) => (
        <View
          key={index}
          {...(props.testID === undefined ? {} : { testID: `${props.testID}:skeleton-row` })}
          style={[skeletonRowStyle, { height: props.rowHeight, borderBottomColor: palette.rowDivider }]}
        >
          <View style={glyphStyle}>
            <HappierSkeletonBlock color={theme.colors.control} width={16} height={16} radius={4} />
          </View>
          <View style={[flexCellStyle, { gap: 8 }]}>
            <HappierSkeletonBlock color={theme.colors.control} width={SKELETON_TITLE_WIDTHS[index % SKELETON_TITLE_WIDTHS.length]!} height={10} />
            {props.twoLines ? <HappierSkeletonBlock color={theme.colors.control} width="34%" height={8} /> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function useStage<Item>(): CollectionStage<Item> {
  const stage = useContext(CollectionStageContext);
  if (stage === null) throw new Error('A Collection row rendered outside its Collection.');
  return stage as CollectionStage<Item>;
}

const tableRowContentStyle: HappierPortableStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: TABLE.gap,
  paddingLeft: TABLE.insetStart - 1,
  paddingRight: TABLE.insetEnd,
  minWidth: 0,
};
const glyphStyle: HappierPortableStyle = { width: TABLE.glyphWidth - TABLE.gap, alignItems: 'flex-start', justifyContent: 'center' };
const skeletonRowStyle: HappierPortableStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: TABLE.gap,
  paddingLeft: TABLE.insetStart,
  paddingRight: TABLE.insetEnd,
  borderBottomWidth: 1,
};
const flexCellStyle: HappierPortableStyle = { flex: 1, minWidth: 0 };
const glyphWithBadgeStyle: HappierPortableStyle = { position: 'relative' };
const glyphBadgeRingStyle: HappierPortableStyle = {
  position: 'absolute',
  right: -TABLE.glyphBadgeOverhang - TABLE.glyphBadgeCutout,
  bottom: -TABLE.glyphBadgeOverhang - TABLE.glyphBadgeCutout,
  padding: TABLE.glyphBadgeCutout,
  borderRadius: HAPPIER_RADIUS_V1.sm + TABLE.glyphBadgeCutout,
};
const glyphBadgePlateStyle: HappierPortableStyle = {
  width: TABLE.glyphBadge,
  height: TABLE.glyphBadge,
  borderRadius: HAPPIER_RADIUS_V1.sm,
  borderWidth: 1,
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
};
const listRowContentStyle: HappierPortableStyle = {
  flexDirection: 'row',
  gap: TABLE.gap,
  paddingLeft: TABLE.insetStart - 1,
  paddingRight: TABLE.insetEnd,
  paddingVertical: TABLE.paddingY,
  minWidth: 0,
};
const lineStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 };
/** A title that may wrap keeps its age on its first line, like the lab's phone list. */
const wrappedTitleLineStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'flex-start', gap: 8, minWidth: 0 };
const overlayStyle: HappierPortableStyle = { position: 'absolute', left: 0, right: 0, top: 0 };
const cellTextStyle: HappierPortableStyle = { flexShrink: 1 };

function cellStyle(column: ResolvedColumn<unknown>): HappierPortableStyle {
  return column.flex === true
    ? flexCellStyle
    : {
        width: column.minWidth,
        minWidth: 0,
        overflow: 'hidden',
        alignItems: column.align === 'end' ? 'flex-end' : 'flex-start',
      };
}

/** Plain text a slot returned is drawn as quiet secondary text; an element is the caller's own. */
function SlotContent(props: Readonly<{ value: ReactNode; tone?: 'secondary' | 'muted'; tabular?: boolean }>): ReactElement | null {
  const value = props.value;
  if (value === null || value === undefined || value === false) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    // Tabular figures only where a column of figures must align (Age, numbers); in words ("payments-api") they
    // widen the hyphen and the digits of a designation.
    const tabular = props.tabular === true || typeof value === 'number';
    return (
      <HappierText variant="body" tone={props.tone ?? 'secondary'} numberOfLines={1} tabularNumbers={tabular} style={cellTextStyle}>
        {String(value)}
      </HappierText>
    );
  }
  return <>{value}</>;
}

function TableCells<Item>(props: Readonly<{
  item: Item | null;
  columns: readonly ResolvedColumn<Item>[];
  height: number;
  /** Draw the title (the resting table) or leave its place empty (the fading overlay above a list row). */
  withTitle: boolean;
  anatomy: CollectionAnatomy<Item>;
}>): ReactElement {
  const { item, anatomy } = props;
  return (
    <View style={[tableRowContentStyle, { height: props.height }]}>
      <View style={glyphStyle}>{item === null || !props.withTitle ? null : anatomy.glyph(item)}</View>
      {props.columns.map((column) => (
        <View key={column.key} style={cellStyle(column as ResolvedColumn<unknown>)}>
          {item === null ? null : column.render === null ? (
            props.withTitle ? <TableTitle item={item} anatomy={anatomy} /> : null
          ) : <SlotContent value={column.render(item)} tabular={column.key === 'age'} />}
        </View>
      ))}
    </View>
  );
}

/** The table's Entry cell: the title, then its designation quietly after it (lab `.tt` + `.nb`). */
function TableTitle<Item>(props: Readonly<{ item: Item; anatomy: CollectionAnatomy<Item> }>): ReactElement {
  const { item, anatomy } = props;
  const suffix = anatomy.titleSuffix?.(item) ?? null;
  const title = (
    <HappierText variant="label" tone="neutral" numberOfLines={1} style={titleTextStyle}>
      {anatomy.title(item)}
    </HappierText>
  );
  if (suffix === null) return title;
  return (
    <View style={titleWithSuffixStyle}>
      {title}
      <HappierText
        variant="body"
        tone="muted"
        numberOfLines={1}
        tabularNumbers
        style={titleSuffixStyle}
        {...(anatomy.testID === undefined ? {} : { testID: `${anatomy.testID(item)}:title-suffix` })}
      >
        {suffix}
      </HappierText>
    </View>
  );
}

const titleTextStyle: HappierPortableStyle = { flexShrink: 1 };
const titleWithSuffixStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'baseline', gap: 6, minWidth: 0 };
const titleSuffixStyle: HappierPortableStyle = { flexShrink: 0 };

function ListCells<Item>(props: Readonly<{
  item: Item;
  anatomy: CollectionAnatomy<Item>;
  height: number;
  secondLine: Readonly<{ value: HappierCollectionMotionValue; tracks: HappierCollectionMotionTracks }>;
  AnimatedView: ReturnType<typeof useMotionDriver>['AnimatedView'];
  /** The resting phone list: a title may take a second line and the row grows to it (no travel to plan). */
  wrapTitle: boolean;
  pageSection: boolean;
}>): ReactElement {
  const { item, anatomy, AnimatedView } = props;
  const age = anatomy.age?.(item) ?? null;
  const where = anatomy.byline === undefined ? anatomy.where?.(item) : anatomy.byline(item);
  const reason = anatomy.reason?.(item);
  const badge = anatomy.glyphBadge?.(item) ?? null;
  return (
    <View style={[listRowContentStyle,
      // The sheet and row each consume one hairline of the page's optical inset.
      props.pageSection ? { paddingLeft: HAPPIER_PAGE_METRICS.headingOpticalInsetPx - 2 } : null,
      props.wrapTitle ? { minHeight: props.height } : { height: props.height }]}>
      <View style={[glyphStyle, { justifyContent: 'flex-start' }]}>
        {badge === null ? anatomy.glyph(item) : (
          <View style={glyphWithBadgeStyle}>
            {anatomy.glyph(item)}
            <GlyphBadgePlate badge={badge} {...(anatomy.testID === undefined ? {} : { testID: `${anatomy.testID(item)}:glyph-badge` })} />
          </View>
        )}
      </View>
      <View style={[flexCellStyle, { gap: 4 }]}>
        <View style={props.wrapTitle ? wrappedTitleLineStyle : lineStyle}>
          <HappierText variant="label" tone="neutral" numberOfLines={props.wrapTitle ? 2 : 1} style={[titleTextStyle, flexCellStyle]}>
            {anatomy.title(item)}
          </HappierText>
          {age === null ? null : (
            <HappierText variant="caption" tone="muted" numberOfLines={1} tabularNumbers>{age}</HappierText>
          )}
        </View>
        <AnimatedView value={props.secondLine.value} tracks={props.secondLine.tracks} style={lineStyle}>
          <View style={[flexCellStyle, lineStyle]}><SlotContent value={where} /></View>
          <SlotContent value={reason} />
        </AnimatedView>
      </View>
    </View>
  );
}

/**
 * The glyph's corner plate: a ring of the row surface cuts it out of the glyph, and its own edge takes the
 * badge's tone. The ring and the plate are concentric.
 */
function GlyphBadgePlate(props: Readonly<{ badge: CollectionGlyphBadge; testID?: string }>): ReactElement {
  const theme = useHappierUiTheme();
  const tone = props.badge.tone;
  return (
    <View aria-hidden testID={props.testID} style={[glyphBadgeRingStyle, { backgroundColor: theme.colors.surface }]}>
      <View
        style={[glyphBadgePlateStyle, {
          backgroundColor: theme.colors.surface,
          borderColor: tone === undefined ? theme.colors.border : theme.colors[HAPPIER_TONE_COLOR_TOKEN[tone]],
        }]}
      >
        {'mark' in props.badge ? props.badge.mark(TABLE.glyphBadgeMark) : 'live' in props.badge
          ? <HappierStatusDot color={tone === undefined ? theme.colors.secondaryText : theme.colors[HAPPIER_TONE_COLOR_TOKEN[tone]]} isPulsing />
          : <PluginUiIconGlyph name={props.badge.icon} size={TABLE.glyphBadgeMark} tone={tone ?? 'secondary'} />}
      </View>
    </View>
  );
}

function useMotionDriver() {
  return useOptionalPluginUiPresentationHost()?.collectionMotion ?? HAPPIER_COLLECTION_INSTANT_MOTION;
}

function CollectionRow<Item>(props: Readonly<{ item: Item; itemKey: string }>): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const stage = useStage<Item>();
  const translate = usePluginTranslation();
  const { AnimatedView } = useMotionDriver();
  const { item, itemKey } = props;
  const { anatomy, metrics, geometry, transition, progress } = stage;
  const theme = useHappierUiTheme();
  const actions = stage.useRowActions?.(item) ?? NO_ROW_ACTIONS;
  const title = anatomy.title(item);
  const expanded = stage.expanded.has(itemKey);
  const toggle = stage.toggleExpanded;
  const peekable = stage.expandable && anatomy.peek !== undefined;
  const reducedMotionPeek = useHappierUiAccessibility().reducedMotion;
  const chevron = peekable ? (
    <HappierPressable
      accessibilityRole="button"
      accessibilityLabel={translate('happier.plugin-ui.collection.peek', 'Peek {title}').replace('{title}', title)}
      expanded={expanded}
      testID={anatomy.testID === undefined ? undefined : `${anatomy.testID(item)}:peek`}
      onPress={() => { toggle(itemKey); }}
      style={() => chevronStyle}
    >
      <HappierChevron direction={expanded ? 'up' : 'down'} color={theme.colors.mutedText} size={PEEK_CHEVRON_SIZE} reducedMotion={reducedMotionPeek} />
    </HappierPressable>
  ) : null;
  // One accessory cell in every geometry, even when it is empty beside a detail: a row whose cells come and go
  // would remount its press target, and table and split must keep the same row.
  const accessory = actions.accessory === undefined && anatomy.peek === undefined ? null : (
    <View style={lineStyle}>{actions.accessory}{chevron}</View>
  );
  const travel = transition?.kind === 'travel' ? transition : null;
  const offset = travel === null ? 0 : travel.plan.offsets.get(itemKey) ?? 0;
  const height = geometry === 'table' ? metrics.tableRow - 2 : metrics.listRow - 2;
  const rowContents = geometry === 'table' ? (
    <TableCells item={item} columns={stage.columns} height={height} withTitle anatomy={anatomy} />
  ) : (
    <View>
      <ListCells
        item={item}
        anatomy={anatomy}
        height={height}
        secondLine={{ value: progress, tracks: travel === null ? NO_TRACKS : HAPPIER_COLLECTION_TRANSITION_TRACKS.secondLine }}
        AnimatedView={AnimatedView}
        wrapTitle={stage.wrapTitles}
        pageSection={stage.pageSections}
      />
      {travel === null ? null : (
        // The table's other columns, fading where they stood while the rows travel.
        <AnimatedView value={progress} tracks={HAPPIER_COLLECTION_TRANSITION_TRACKS.columns} style={overlayStyle} pointerEvents="none">
          <TableCells item={item} columns={stage.columns} height={metrics.tableRow - 2} withTitle={false} anatomy={anatomy} />
        </AnimatedView>
      )}
    </View>
  );
  const rowItem: ReactElement<ItemProps> = actions.secondaryActions !== undefined && actions.onSecondaryAction !== undefined ? (
    <List.Item
      density="compact"
      showDivider={stage.dividedKeys?.has(itemKey) === true}
      accessibilityLabel={anatomy.accessibilityLabel(item)}
      {...(anatomy.accessibilityHint?.(item) === undefined ? {} : { accessibilityHint: anatomy.accessibilityHint(item) })}
      {...(anatomy.testID === undefined ? {} : { testID: anatomy.testID(item) })}
      {...(actions.busy === undefined ? {} : { busy: actions.busy })}
      {...(actions.accessoryWraps === undefined ? {} : { accessoryWraps: actions.accessoryWraps })}
      {...(accessory === null ? {} : { accessory })}
      secondaryActions={actions.secondaryActions}
      onSecondaryAction={actions.onSecondaryAction}
      {...(actions.secondaryActionAccessibilityLabel === undefined
        ? {}
        : { secondaryActionAccessibilityLabel: actions.secondaryActionAccessibilityLabel })}
    >
      {rowContents}
    </List.Item>
  ) : (
    <List.Item
      density="compact"
      showDivider={stage.dividedKeys?.has(itemKey) === true}
      accessibilityLabel={anatomy.accessibilityLabel(item)}
      {...(anatomy.accessibilityHint?.(item) === undefined ? {} : { accessibilityHint: anatomy.accessibilityHint(item) })}
      {...(anatomy.testID === undefined ? {} : { testID: anatomy.testID(item) })}
      {...(actions.busy === undefined ? {} : { busy: actions.busy })}
      {...(actions.accessoryWraps === undefined ? {} : { accessoryWraps: actions.accessoryWraps })}
      {...(accessory === null ? {} : { accessory })}
    >
      {rowContents}
    </List.Item>
  );
  const destinationRow = (
    <HappierCollectionTableRowContext.Provider value>
      {renderCollectionItemDestination(host, anatomy, item, rowItem)}
    </HappierCollectionTableRowContext.Provider>
  );
  return (
    <AnimatedView
      value={progress}
      tracks={travel === null ? NO_TRACKS : happierCollectionTravelTrack(offset)}
      {...(anatomy.testID === undefined ? {} : { testID: `${anatomy.testID(item)}:cell` })}
    >
      {destinationRow}
    </AnimatedView>
  );
}

/** The peek chevron (the shared drawn chevron) turns with the peek at the base step, pointing down closed and up open. */
const PEEK_CHEVRON_SIZE = 14;

const chevronStyle: HappierPortableStyle = {
  width: TABLE.chevronWidth,
  height: TABLE.chevronWidth,
  borderRadius: 7,
  alignItems: 'center',
  justifyContent: 'center',
};

function CollectionPeek<Item>(props: Readonly<{ item: Item; itemKey: string }>): ReactElement {
  const stage = useStage<Item>();
  const host = useOptionalPluginUiPresentationHost();
  const { reducedMotion } = useHappierUiAccessibility();
  const [open, setOpen] = useState(false);
  const expanded = stage.expanded.has(props.itemKey);
  // The cell mounts collapsed and opens on its first commit, so the reveal animates; it collapses in place
  // before the Collection releases the cell.
  useEffect(() => { setOpen(expanded); }, [expanded]);
  const onSettled = stage.onPeekSettled;
  const onPeekHeight = stage.onPeekHeight;
  const motion = host?.disclosureMotion ?? HAPPIER_INSTANT_DISCLOSURE_MOTION;
  const { AnimatedView } = useMotionDriver();
  const peekTheme = useHappierUiTheme();
  const peekPalette = useOptionalHappierUiPalette() ?? resolveHappierUiPalette(peekTheme);
  // While the rows travel the peek is a ghost: it takes no room in the list geometry, fades with the other table
  // columns and travels with its row from where the table had it. One structure in both modes, so the disclosure
  // stays mounted (and open) across the travel.
  const travel = stage.transition?.kind === 'travel' ? stage.transition : null;
  const ghost = travel !== null;
  const tracks = useMemo<HappierCollectionMotionTracks>(() => (travel === null ? NO_TRACKS : {
    ...HAPPIER_COLLECTION_TRANSITION_TRACKS.columns,
    ...happierCollectionTravelTrack(travel.plan.offsets.get(peekCellKey(props.itemKey)) ?? 0),
  }), [props.itemKey, travel]);
  return (
    <View style={ghost ? ghostCellStyle : null}>
      <AnimatedView
        value={stage.progress}
        tracks={tracks}
        style={ghost ? overlayStyle : null}
        pointerEvents={ghost ? 'none' : 'auto'}
        {...(stage.anatomy.testID === undefined ? {} : { testID: `${stage.anatomy.testID(props.item)}:peek-cell` })}
      >
        <View
          onLayout={(event: HappierLayoutChangeEvent) => {
            if (!ghost) onPeekHeight(props.itemKey, event.nativeEvent.layout.height);
          }}
        >
          <HappierDisclosure
            expanded={open}
            onExpandedChange={() => { stage.toggleExpanded(props.itemKey); }}
            header={null}
            showDivider={false}
            reducedMotion={reducedMotion || host?.disclosureMotion === undefined}
            motion={motion}
            onSettled={(settled) => { onSettled(props.itemKey, settled); }}
            {...(stage.anatomy.testID === undefined ? {} : { testID: `${stage.anatomy.testID(props.item)}:peek-body` })}
          >
            <View style={peekStyle}>{stage.anatomy.peek?.(props.item)}</View>
          </HappierDisclosure>
          {/* The peek closes its row's band with the same hairline a row draws (overlay, never layout). */}
          <View pointerEvents="none" style={[peekHairlineStyle, { backgroundColor: peekPalette.rowDivider }]} />
        </View>
      </AnimatedView>
    </View>
  );
}

const ghostCellStyle: HappierPortableStyle = { height: 0, overflow: 'visible', zIndex: 0 };
const peekHairlineStyle: HappierPortableStyle = { position: 'absolute', left: 0, right: 0, bottom: 0, height: 1 };

const peekStyle: HappierPortableStyle = {
  paddingLeft: TABLE.insetStart + TABLE.glyphWidth,
  paddingRight: TABLE.insetStart,
  paddingTop: 4,
  paddingBottom: 14,
};

function CollectionCellView<Item>(props: Readonly<{ cell: CollectionCell<Item> }>): ReactElement {
  const cell = props.cell;
  return cell.kind === 'item'
    ? <CollectionRow item={cell.item} itemKey={cell.key} />
    : <CollectionPeek item={cell.item} itemKey={cell.itemKey} />;
}

function renderCollectionCell(cell: CollectionCell<unknown>): ReactElement {
  return <CollectionCellView cell={cell} />;
}

function readCellKey(cell: CollectionCell<unknown>): string {
  return cell.key;
}

function peekCellKey(key: string): string {
  return `collection-peek:${key}`;
}

function sectionCellKey(key: string): string {
  return `collection-section:${key}`;
}

function CollectionChoiceMark(): ReactElement {
  const selection = useContext(ListItemSelectionContext);
  const theme = useHappierUiTheme();
  return <HappierRadioMark selected={selection?.selected === true} disabled={selection?.activatable === false} theme={theme} />;
}

export function Collection<Item>(props: CollectionProps<Item>): ReactElement {
  const { model } = props;
  const singleChoice = props.selection?.single;
  const theme = useHappierUiTheme();
  // A single choice leads each row with the one choice mark (lab `.fm-table`'s radio column) in the glyph
  // column; the row itself owns the radio role, its checked state and the keyboard.
  const anatomy = useMemo<CollectionAnatomy<Item>>(() => singleChoice === undefined ? props.anatomy : {
    ...props.anatomy,
    destination: undefined,
    glyph: () => <CollectionChoiceMark />,
    reason: (item) => singleChoice.unavailableReason?.(item) ?? props.anatomy.reason?.(item),
  }, [props.anatomy, singleChoice?.unavailableReason, singleChoice === undefined]);
  const translate = usePluginTranslation();
  const accessibility = useHappierUiAccessibility();
  const platform = useOptionalHappierUiPlatform();
  const driver = useMotionDriver();
  const metrics = useRowMetrics();
  const presentation = props.presentation ?? 'table';
  const detail = props.detail ?? 'auto';
  // A page-sized collection scrolls as the page: its header, items and footer in one scroller. A board's columns
  // scroll on their own, so a board never does.
  const pageTracker = useOptionalPluginUiScrollActivityTracker();
  const pageVirtualized = props.scroll === 'page-virtualized' && pageTracker?.scrollToOffset !== undefined
    && presentation === 'table';
  const pageScroll = (props.scroll === 'page' && presentation !== 'board') || pageVirtualized;
  // A page-scrolling list sits among the page's other sections, so its groups take the page section anatomy:
  // a section title above one sheet of rows, not a dense list's caption band.
  const palette = useOptionalHappierUiPalette();
  const enclosingPageSheet = useHappierPageSection();
  const pageSections = pageScroll && presentation === 'list' && palette !== null;

  // ---- measured geometry: the split owner's pure rule, never a device label ----
  const [size, setSize] = useState<Readonly<{ width: number; height: number }> | null>(null);
  const [pageViewportHeight, setPageViewportHeight] = useState<number | null>(null);
  const onPageViewportLayout = useCallback((event: HappierLayoutChangeEvent) => {
    setPageViewportHeight(event.nativeEvent.layout.height);
  }, []);
  const onLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) => (current !== null && current.width === width && current.height === height ? current : { width, height }));
  }, []);
  // The page stage grows with its rows. Loading placeholders fill the bounded viewport,
  // never that content height (which would grow the placeholders on every layout).
  const viewportHeight = pageScroll ? pageViewportHeight : size?.height ?? null;
  const geometry = useMemo(() => size === null ? null : resolveHappierListDetailGeometry({
    availableWidth: size.width,
    minListWidth: props.minListWidth,
    minDetailWidth: props.minDetailWidth,
    preferredListRatio: props.preferredListRatio,
    gap: 0,
  }), [props.minDetailWidth, props.minListWidth, props.preferredListRatio, size]);
  const layoutState = useMemo(() => resolveHappierCollectionLayoutState(geometry), [geometry]);
  const openKey = model.openKey;
  // The page's app details pane, when the host placed this page in a pane host and it sits beside the page now.
  // In a pane host whose pane is not beside the page (a phone, side panes off) the detail pushes: never a split.
  const paneHost = useDetailsPaneHostInstalled() && detail === 'auto' && props.renderDetail !== undefined;
  const pane = useDetailsPaneAvailable() && paneHost;
  // The table fits where it clears the list minimum AND can still show a column beside the title: a table that
  // is a title column alone is the list with less in it, so there the rows recompose (COLLECTION.md "Phones").
  const rowAccessoryWidth = (anatomy.peek === undefined ? 0 : TABLE.chevronWidth) + (props.useRowActions !== undefined ? 36 : 0);
  const tableFits = size === null ? null : size.width >= props.minListWidth
    && tableShowsBesideTitle(anatomy, size.width, accessibility.textScale, rowAccessoryWidth);
  const target = resolveHappierCollectionComposition({
    presentation,
    detail,
    splitFits: geometry === null ? null : geometry.mode === 'split',
    tableFits,
    pane,
    paneHost,
    open: openKey !== null,
  });

  // ---- the cells and their exact heights, for the shared-element plan ----
  const peekHeights = useRef(new Map<string, number>());
  const [closingPeeks, setClosingPeeks] = useState<ReadonlySet<string>>(() => new Set());
  const cellsRef = useRef<readonly HappierCollectionTransitionCell[]>([]);

  // ---- the composition, and the transition between the table and the split ----
  // Beside the open host pane the list is the split's list: the same travel, with the detail in the pane.
  const besidePane = pane && target === 'list' && openKey !== null;
  const besideDetail = target === 'split' || besidePane;
  // Whether the list on screen came from opening beside the pane, so closing travels back to the table.
  const besidePaneRef = useRef(besidePane);
  // One progress for the open item's container: 1 is the list beside the detail, 0 the resting view.
  const progress = driver.useValue(besideDetail ? 1 : 0);
  // Where focus returns once a detail closes: the row or card that opened it (a new object per request).
  const [view, setView] = useState<CollectionView>(() => ({ composition: target, transition: null, scrollRequest: null }));
  const viewRef = useRef(view);
  viewRef.current = view;
  const { viewport, scrollRequest: viewportScrollRequest } = useHappierCollectionViewport(model, presentation);
  const scrollOffsetRef = viewport.offsetRef;
  const lastOpenKeyRef = useRef<HappierCollectionKey | null>(openKey);
  if (openKey !== null) lastOpenKeyRef.current = openKey;
  const reducedMotion = accessibility.reducedMotion;

  useLayoutEffect(() => {
    const current = viewRef.current;
    if (current.composition === target && current.transition === null) return;
    const wasBesidePane = besidePaneRef.current;
    besidePaneRef.current = besidePane;
    const opening = besideDetail && current.composition === 'table';
    const closing = target === 'table'
      && (current.composition === 'split' || (current.composition === 'list' && wasBesidePane));
    const anchorKey = opening ? openKey : lastOpenKeyRef.current;
    if ((!opening && !closing) || anchorKey === null || size === null) {
      // Any other change (a resize across the split minimum, the first measurement, a view switch) lands at once.
      progress.cancel();
      progress.set(besideDetail ? 1 : 0);
      setView({ composition: target, transition: null, scrollRequest: null });
      // Closing a pushed detail over cards gives focus back to the card that opened it.
      return;
    }
    const kind: 'travel' | 'fade' = reducedMotion || driver.durationsMs.open === 0 ? 'fade' : 'travel';
    const previous = current.transition;
    const plan = previous !== null && previous.kind === kind && previous.anchorKey === anchorKey
      ? previous.plan
      : planHappierCollectionTransitionOffsets({
      cells: cellsRef.current,
      anchorKey,
      scroll: { geometry: current.composition === 'table' && current.transition === null ? 'table' : 'list', offset: scrollOffsetRef.current },
      viewportHeight: size.height,
    });
    const transition: CollectionTransition = { kind, anchorKey, plan };
    const toSplit = besideDetail;
    const end = toSplit ? 1 : 0;
    if (kind === 'travel') {
      // The rows move from wherever they are on screen: a reversal re-targets from the presentation value.
      const value = progress.get();
      setView({
        composition: target,
        transition,
        // Opening from rest switches to list geometry now, so the list scrolls where the opened row keeps its y.
        scrollRequest: toSplit && current.transition === null ? { offset: plan.listScroll } : current.scrollRequest,
      });
      progress.animateTo(end, (toSplit ? driver.durationsMs.open : driver.durationsMs.close) * Math.abs(end - value), (finished) => {
        if (!finished) return;
        setView((settled) => ({
          composition: settled.composition,
          transition: null,
          scrollRequest: settled.composition === 'table' ? { offset: plan.tableScroll } : settled.scrollRequest,
        }));
      });
      return;
    }
    // Reduced motion: the leaving composition fades out, then the arriving one fades in. Never both at once.
    const half = driver.durationsMs.reducedMotion / 2;
    const leaving = toSplit ? 'table' : current.composition;
    const value = progress.get();
    const midpoint = 0.5;
    const arrive = () => {
      setView({
        composition: target,
        transition,
        scrollRequest: { offset: toSplit ? plan.listScroll : plan.tableScroll },
      });
      progress.animateTo(end, half, (finished) => {
        if (!finished) return;
        setView((settled) => ({ composition: settled.composition, transition: null, scrollRequest: settled.scrollRequest }));
      });
    };
    const stillLeaving = toSplit ? value < midpoint : value > midpoint;
    if (!stillLeaving) {
      arrive();
      return;
    }
    setView({ composition: leaving, transition, scrollRequest: current.scrollRequest });
    progress.animateTo(midpoint, half * Math.abs(midpoint - value) * 2, (finished) => {
      if (finished) arrive();
    });
    // `openKey` and `size` are read at the moment the target changes; they do not re-run a settled transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const composition = view.composition;
  const transition = view.transition;
  const cards = presentation === 'board' || presentation === 'grid';
  const rowGeometry: 'table' | 'list' = transition?.kind === 'travel' || composition !== 'table' ? 'list' : 'table';
  const wrapTitles = composition === 'list' && transition === null && !besideDetail;
  // Peeks exist in the resting table; while the table fades out (reduced motion) they stay and fade with it.
  const expandable = rowGeometry === 'table'
    && (transition === null || transition.kind === 'fade')
    && anatomy.peek !== undefined;
  // While the rows travel, an open peek stays as a ghost that fades with the other columns and travels with its
  // row, so it never vanishes at the start of an open (or pops back at the end of a close).
  const ghostPeeks = transition?.kind === 'travel' && anatomy.peek !== undefined;

  // ---- the List's cells: rows, and each open peek right below its row (table only) ----
  const expanded = model.expanded;
  const sections = useMemo(() => model.sections.map((section, index): ListSectionData<CollectionCell<Item>> => {
    const data: CollectionCell<Item>[] = [];
    for (const item of section.items) {
      const key = model.keyOf(item);
      data.push({ kind: 'item', key, item });
      if ((expandable || ghostPeeks) && (expanded.has(key) || closingPeeks.has(key))) {
        data.push({ kind: 'peek', key: peekCellKey(key), itemKey: key, item });
      }
    }
    const group = section.group;
    return {
      key: group?.key ?? `collection-${index}`,
      title: group?.title ?? '',
      // A page section names its rows; a dense list's caption band counts them.
      ...(pageSections ? {} : { count: section.items.length }),
      ...(group?.description === undefined ? {} : { description: group.description }),
      data,
    };
  }), [closingPeeks, expandable, expanded, ghostPeeks, model.keyOf, model.sections, pageSections]);
  const dividedKeys = useMemo(() => (pageSections
    ? new Set(model.sections.flatMap((section) => section.items.slice(0, -1).map(model.keyOf)))
    : null), [model.keyOf, model.sections, pageSections]);
  const grouped = model.sections.some((section) => section.group !== null && section.group.title !== '');
  cellsRef.current = useMemo(() => {
    const cells: HappierCollectionTransitionCell[] = [];
    for (const section of sections) {
      if (grouped) {
        cells.push({ key: sectionCellKey(section.key), table: metrics.groupHeader, list: metrics.groupHeader, header: true });
      }
      for (const cell of section.data) {
        cells.push(cell.kind === 'item'
          ? { key: cell.key, table: metrics.tableRow, list: metrics.listRow }
          : { key: cell.key, table: peekHeights.current.get(cell.itemKey) ?? 0, list: 0 });
      }
    }
    return cells;
  }, [grouped, metrics, sections]);

  const onPeekHeight = useCallback((key: string, height: number) => { peekHeights.current.set(key, height); }, []);
  const onPeekSettled = useCallback((key: string, isExpanded: boolean) => {
    if (isExpanded) return;
    setClosingPeeks((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);
  // A peek that closes stays in the rows until its collapse settles.
  const previousExpanded = useRef(expanded);
  useLayoutEffect(() => {
    const previous = previousExpanded.current;
    previousExpanded.current = expanded;
    const closed = [...previous].filter((key) => !expanded.has(key));
    if (closed.length === 0) return;
    setClosingPeeks((current) => new Set([...current, ...closed]));
  }, [expanded]);

  // ---- columns, by measured width ----
  const tableWidth = size?.width ?? 0;
  const columns = useMemo(
    () => resolveColumns(anatomy, tableWidth, accessibility.textScale, rowAccessoryWidth),
    [accessibility.textScale, anatomy, rowAccessoryWidth, tableWidth],
  );

  const stage = useMemo<CollectionStage<Item>>(() => ({
    composition,
    geometry: rowGeometry,
    transition,
    progress,
    columns,
    metrics,
    anatomy,
    expanded,
    toggleExpanded: model.actions.toggleExpanded,
    wrapTitles,
    pageSections,
    useRowActions: props.useRowActions,
    expandable,
    dividedKeys,
    onPeekHeight,
    onPeekSettled,
  }), [anatomy, columns, composition, dividedKeys, expandable, expanded, metrics, model.actions.toggleExpanded, wrapTitles, pageSections, onPeekHeight, onPeekSettled, progress, props.useRowActions, rowGeometry, transition]);

  // ---- the List engine's Collection facts ----
  const authorMultiple: NonNullable<CollectionProps<Item>['selection']>['multiple'] = props.selection?.multiple
    ?? (model.selectionStore === null ? undefined : { store: model.selectionStore });
  if (singleChoice !== undefined && authorMultiple !== undefined) {
    throw new Error('Collection single choice and multiple selection are mutually exclusive');
  }
  const multipleStore = authorMultiple?.store ?? null;
  const navigationKeys = useMemo(() => model.sections.flatMap(section => section.items)
    .filter(item => props.selection?.isItemActivatable?.(item) !== false && singleChoice?.isItemSelectable?.(item) !== false).map(model.keyOf), [model.keyOf, model.sections, props.selection?.isItemActivatable, singleChoice?.isItemSelectable]);
  const selectableKeys = useMemo(() => model.sections.flatMap(section => section.items)
    .filter(item => authorMultiple?.isItemSelectable?.(item) !== false).map(model.keyOf), [authorMultiple?.isItemSelectable, model.keyOf, model.sections]);
  const eligibleKeys = useMemo(() => {
    const present = new Set(model.sections.flatMap(section => section.items.map(model.keyOf)));
    return [...selectableKeys, ...(authorMultiple?.retainedSelectionKeys ?? []).filter(key => !present.has(key))];
  }, [authorMultiple?.retainedSelectionKeys, model.keyOf, model.sections, selectableKeys]);
  useEffect(() => {
    // One inventory for author and model stores across all presentations.
    // Retention preserves hidden rows, never overrides a present row's exclusion.
    multipleStore?.setVisibleRows({ visibleOrderedKeys: selectableKeys, eligibleKeys });
  }, [eligibleKeys, multipleStore, selectableKeys]);
  const selectedKey = singleChoice === undefined ? openKey : singleChoice.value;
  const tabStopIndex = resolveHappierRovingTabStop({
    entries: navigationKeys.map(() => ({ disabled: false })),
    selectedIndex: model.focusKey !== null && navigationKeys.includes(model.focusKey)
      ? navigationKeys.indexOf(model.focusKey) : navigationKeys.indexOf(selectedKey ?? ''),
  });
  const tabStopKey = tabStopIndex === null ? null : navigationKeys[tabStopIndex] ?? null;
  const toggleExpanded = model.actions.toggleExpanded;
  const pageCellHeights = useMemo(() => new Map(cellsRef.current.flatMap(cell => [
    [cell.key, cell[rowGeometry]] as const,
    [encodeHappierSectionRowCellKey(cell.key), cell[rowGeometry]] as const,
  ])), [sections, metrics, rowGeometry, grouped]);
  const pageGeometry = useMemo(() => ({
    rowHeight: (key: string) => pageCellHeights.get(key)
      ?? (rowGeometry === 'table' ? metrics.tableRow : metrics.listRow),
    headerHeight: metrics.groupHeader,
    width: size?.width ?? null,
    defaultRowHeight: rowGeometry === 'table' ? metrics.tableRow : metrics.listRow,
  }), [pageCellHeights, rowGeometry, metrics, size?.width]);
  const control = useMemo<ListCollectionControl>(() => ({
    ownsSelectionRows: true,
    hideChrome: true,
    focus: { key: model.focusKey, tabStopKey, request: model.focusRequest,
      onRequestHandled: model.actions.consumeFocusRequest,
      ...(singleChoice === undefined ? { onKey: (key: string, from: string, event: unknown) => model.actions.navigate({ key, from, event, presentation,
        store: multipleStore, eligibleKeys: navigationKeys }) } : {}) },
    onRowKey: (key, itemKey) => {
      if (singleChoice === undefined && (key === ' ' || key === 'Spacebar') && expandable) {
        toggleExpanded(itemKey);
        return true;
      }
      return false;
    },
    scroll: { offsetRef: scrollOffsetRef, request: view.scrollRequest ?? viewportScrollRequest },
    ...(pageSections && palette !== null ? {
      sectionHeaderTitleRole: 'section' as const,
      // The page section header's rhythm: one section gap above, the header gap down to its sheet.
      sectionHeaderStyle: {
        justifyContent: 'flex-end' as const,
        paddingTop: HAPPIER_PAGE_METRICS.sectionGapPx,
        paddingBottom: HAPPIER_PAGE_METRICS.sectionHeaderGapPx,
        // A page-list's group label shares its rows' leading mark edge. Grid headings
        // retain their own card-column anatomy below.
        paddingHorizontal: HAPPIER_PAGE_METRICS.headingOpticalInsetPx,
      },
      pageSheet: { colors: palette },
    } : {
      sectionHeaderTitleRole: 'caption' as const,
      sectionHeaderStyle: {
        height: metrics.groupHeader,
        justifyContent: 'center' as const,
        paddingHorizontal: TABLE.insetStart,
        // A quiet band a hair off the rows (lab `.grp`), closed by the rows' own hairline colour.
        backgroundColor: palette?.inset ?? theme.colors.elevatedSurface,
        borderBottomWidth: 1,
        borderBottomColor: palette?.rowDivider ?? theme.colors.divider,
      },
    }),
    ...(props.groupAction === undefined ? {} : {
      sectionHeaderAction: (groupKey: string) => (
        <CollectionGroupActionButton
          action={props.groupAction?.(groupKey) ?? null}
          groupKey={groupKey}
          groupTitle={model.sections.find((section) => section.group?.key === groupKey)?.group?.title ?? groupKey}
          {...(props.testID === undefined ? {} : { testID: props.testID })}
        />
      ),
    }),
    ...(pageScroll ? { pageScroll: true } : {}),
    ...(pageVirtualized ? { pageVirtualization: pageGeometry } : {}),
    wrapSectionHeader: (sectionKey, header) => (
      <driver.AnimatedView
        value={progress}
        tracks={transition?.kind === 'travel'
          ? happierCollectionTravelTrack(transition.plan.offsets.get(sectionCellKey(sectionKey)) ?? 0)
          : NO_TRACKS}
      >
        {header}
      </driver.AnimatedView>
    ),
  }), [driver, expandable, metrics, model, multipleStore, navigationKeys, pageScroll, pageVirtualized, pageGeometry, pageSections, palette, presentation, progress, props.groupAction, props.testID, scrollOffsetRef, singleChoice === undefined, tabStopKey, theme.colors.divider, theme.colors.elevatedSurface, theme.colors.surface, toggleExpanded, transition, view.scrollRequest, viewportScrollRequest]);

  // ---- Escape returns to the table from anywhere inside the Collection (web keyboard) ----
  const rootRef = useRef<View | null>(null);
  const search = useListCollectionSearch(props.search, rootRef);
  const close = model.actions.close;
  const hasOpen = openKey !== null;
  useEffect(() => {
    if (!hasOpen || Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const root = rootRef.current as unknown as { contains?: (node: Node) => boolean } | null;
      const active = document.activeElement;
      if (root === null || typeof root.contains !== 'function' || active === null || !root.contains(active)) return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); };
  }, [close, hasOpen]);

  // Closing the item in the host pane (its close button, Escape inside it) gives focus back to the row or card that
  // opened it, as closing the split or a pushed detail does.
  const paneOpenKeyRef = useRef(openKey);
  useEffect(() => {
    const previous = paneOpenKeyRef.current;
    paneOpenKeyRef.current = openKey;
    if (previous !== null && openKey === null) model.actions.requestFocus(previous);
  }, [model.actions, openKey]);
  const authorFocusRequest = props.selection?.focusRequest;
  useEffect(() => {
    if (authorFocusRequest !== undefined) model.actions.requestFocus(authorFocusRequest.key);
    // A caller's request is one object identity, not a request on every model update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorFocusRequest]);

  const onSelectedKeyChange = model.actions.open;
  const focus = model.actions.focus;
  const authorFocus = props.selection?.onFocusedKeyChange;
  const onFocusedKeyChange = useCallback((key: string, observedViewport?: HappierCollectionViewport) => {
    focus(key, observedViewport ?? viewport);
    authorFocus?.(key);
  }, [authorFocus, focus, viewport]);
  const authorActivatable = props.selection?.isItemActivatable;
  const isItemActivatable = useCallback(
    (cell: CollectionCell<Item>) => cell.kind === 'item' && (authorActivatable?.(cell.item) ?? true),
    [authorActivatable],
  );
  const authorSelectable = authorMultiple?.isItemSelectable;
  const isItemSelectable = useCallback(
    (cell: CollectionCell<Item>) => cell.kind === 'item' && (authorSelectable?.(cell.item) ?? true),
    [authorSelectable],
  );
  const authorSingleSelectable = singleChoice?.isItemSelectable;
  const isSingleItemSelectable = useCallback(
    (cell: CollectionCell<Item>) => cell.kind === 'item' && authorSingleSelectable?.(cell.item) !== false,
    [authorSingleSelectable],
  );
  const authorUnavailableReason = singleChoice?.unavailableReason;
  const unavailableReason = useCallback(
    (cell: CollectionCell<Item>) => cell.kind === 'item' ? authorUnavailableReason?.(cell.item) ?? null : null,
    [authorUnavailableReason],
  );

  // ---- the chrome: column header, keyboard hints, the window-honesty line ----
  // Beside the open pane the list keeps the split list's chrome (its bar and keys), like the lab's Desk list.
  const wide = composition === 'table' || composition === 'split' || (composition === 'list' && pane && openKey !== null);
  const desktop = platform === null || platform.platform === 'web' || platform.platform === 'desktop';
  // A Collection with nothing in it is its empty state alone: no column header, no keys for rows that are not there.
  const hasRows = model.keys.length > 0;
  const cardsWide = composition === 'cards';
  const showHints = (wide || (cardsWide && detail !== 'none' && geometry?.mode === 'split')) && desktop && hasRows;
  const transitionTracks = transition?.kind === 'travel' ? HAPPIER_COLLECTION_TRANSITION_TRACKS.columns : NO_TRACKS;
  // The bar above the rows keeps its height in the table and beside a detail, so opening or closing never moves
  // the rows under it: the table's column titles, or the window's first fact beside a detail (the lab's list bar).
  const headerBar = hasRows && wide;
  const statementLead = typeof props.windowStatement === 'string' ? props.windowStatement : props.windowStatement?.[0];
  const columnHeader = !headerBar ? null : rowGeometry === 'list' && transition === null ? (
    <View style={[tableRowContentStyle, { height: TABLE.headerHeight, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }]}>
      <View style={glyphStyle} />
      {statementLead === undefined ? null : (
        <HappierText variant="caption" tone="muted" numberOfLines={1} tabularNumbers>{statementLead}</HappierText>
      )}
    </View>
  ) : (
    <driver.AnimatedView value={progress} tracks={transitionTracks} style={{ height: TABLE.headerHeight, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
      <View
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[tableRowContentStyle, { height: TABLE.headerHeight - 1, paddingRight: TABLE.insetEnd + rowAccessoryWidth + 1 }]}
      >
        <View style={glyphStyle} />
        {columns.map((column) => (
          <View key={column.key} style={cellStyle(column as ResolvedColumn<unknown>)}>
            <HappierText variant="caption" tone={column.key === 'title' ? 'neutral' : 'muted'} numberOfLines={1}>
              {column.title}
            </HappierText>
          </View>
        ))}
      </View>
    </driver.AnimatedView>
  );
  const hint = {
    move: translate('happier.plugin-ui.collection.hint.move', 'move'),
    open: translate('happier.plugin-ui.collection.hint.open', 'open'),
    close: translate('happier.plugin-ui.collection.hint.close', 'close'),
  };
  const hints = !showHints ? null : presentation === 'board' ? [
    ['←', '→', translate('happier.plugin-ui.collection.hint.columns', 'columns')],
    ['J', 'K', translate('happier.plugin-ui.collection.hint.cards', 'cards')],
    ['↵', hint.open],
    ['esc', hint.close],
  ] : presentation === 'grid' ? [
    ['←', '→', '↑', '↓', hint.move],
    ['↵', hint.open],
    ['esc', hint.close],
  ] : (composition === 'split' || composition === 'list') && transition === null
    ? [['J', 'K', hint.move], ['esc', translate('happier.plugin-ui.collection.hint.table', 'table')]]
    : [
        ['J', 'K', hint.move],
        ['space', multipleStore === null
          ? translate('happier.plugin-ui.collection.hint.peek', 'peek')
          : translate('happier.plugin-ui.collection.hint.select', 'select')],
        ['↵', hint.open],
        ['esc', translate('happier.plugin-ui.collection.hint.back', 'back')],
        ['⌘K', translate('happier.plugin-ui.collection.hint.anything', 'anything')],
      ];
  const continuations = model.window.kind === 'partial' ? model.window.continuations : [];
  const statement = props.windowStatement ?? (model.window.kind === 'unavailable' ? model.window.reason : undefined);
  const windowLine = statement === undefined ? undefined : typeof statement === 'string' ? [statement] : statement;
  const footerLine = hints === null && windowLine === undefined && continuations.length === 0 ? null : (
    <View style={[footerStyle, { borderTopColor: theme.colors.divider }]} testID={props.testID === undefined ? undefined : `${props.testID}:footer`}>
      {hints === null ? null : (
        <View
          style={[lineStyle, { flexShrink: 0 }]}
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID={props.testID === undefined ? undefined : `${props.testID}:hints`}
        >
          {hints.map((hint) => (
            <View key={hint.join(' ')} style={hintStyle}>
              {hint.slice(0, -1).map((key) => <CollectionKeyCap key={key} label={key} />)}
              <HappierText variant="caption" tone="muted">{hint[hint.length - 1]}</HappierText>
            </View>
          ))}
        </View>
      )}
      <View style={flexCellStyle} />
      {windowLine === undefined ? null : (
        <View style={[lineStyle, { flexShrink: 1, overflow: 'hidden' }]}>
          {windowLine.map((part, index) => (
            // Each fact stays its own text. A narrow footer keeps the count (first) and the honesty fact (last,
            // "… has more") and gives the middle detail away first (lab: "12 loaded · Azure DevOps has more").
            <View key={`${index}:${part}`} style={[lineStyle, { flexShrink: windowPartShrink(index, windowLine.length), minWidth: 0 }]}>
              {index === 0 ? null : <HappierText variant="caption" tone="muted" aria-hidden>·</HappierText>}
              <HappierText variant="caption" tone="muted" numberOfLines={1} tabularNumbers style={cellTextStyle}>{part}</HappierText>
            </View>
          ))}
        </View>
      )}
      {continuations.map((continuation) => (
        <HappierPressable
          key={continuation.key}
          accessibilityRole="button"
          accessibilityLabel={continuation.label}
          busy={continuation.busy === true}
          onPress={continuation.load}
          {...(props.testID === undefined ? {} : { testID: `${props.testID}:continuation:${continuation.key}` })}
          style={(state) => ({ opacity: state.pressed || state.busy ? 0.6 : 1 })}
        >
          <HappierText variant="caption" tone="secondary" numberOfLines={1}>{continuation.label}</HappierText>
        </HappierPressable>
      ))}
    </View>
  );

  // ---- the panes ----
  const headingFocus = useCollectionDetailHeadingFocusInternal(detail === 'none' ? null : openKey);
  // The detail that is leaving stays on screen while it leaves: the caller has already closed it, so its last
  // rendering is kept for exactly the close, and it takes no input.
  const lastDetailRef = useRef<ReactNode>(null);
  const detailNode = openKey !== null && props.renderDetail !== undefined && detail !== 'none'
    ? <CollectionDetailHeadingFocusContext.Provider value={pane && props.detailHeader !== undefined ? null : headingFocus}>
        {props.renderDetail(openKey, { headerHosted: pane && props.detailHeader !== undefined })}
      </CollectionDetailHeadingFocusContext.Provider>
    : transition !== null ? lastDetailRef.current : null;
  lastDetailRef.current = openKey !== null ? detailNode : transition !== null ? lastDetailRef.current : null;
  const detailLeaving = openKey === null && transition !== null;
  const listRatio = geometry?.mode === 'split' ? geometry.listRatio : 1;
  const overlayDetail = transition?.kind === 'travel';
  // Beside the host details pane the detail is not in this stage at all: the pane shows it (below).
  const detailVisible = !pane && (composition === 'split' || composition === 'detail' || overlayDetail);
  const listVisible = composition !== 'detail';
  const listFlex = composition === 'split' && !overlayDetail ? listRatio : 1;
  const detailPaneStyle: HappierPortableStyle = overlayDetail
    ? { position: 'absolute', top: 0, bottom: 0, right: 0, left: (size?.width ?? 0) * listRatio }
    : composition === 'split' ? { flex: 1 - listRatio } : { flex: 1 };
  const detailTracks = overlayDetail ? HAPPIER_COLLECTION_TRANSITION_TRACKS.detail : NO_TRACKS;

  // The open item stays marked in the list or on its card while its detail is open anywhere: in the split, pushed,
  // in the host details pane, or wherever the caller shows it (`detail: 'none'`).
  const fadeTracks = transition?.kind === 'fade'
    ? (composition === 'table' ? HAPPIER_COLLECTION_REDUCED_MOTION_TRACKS.out : HAPPIER_COLLECTION_REDUCED_MOTION_TRACKS.in)
    : NO_TRACKS;

  const listSelection: ListSelectionProps<CollectionCell<Item>> = singleChoice === undefined ? {
    selectedKey: openKey,
    onSelectedKeyChange,
    onFocusedKeyChange,
    isItemActivatable,
    ...(authorMultiple === undefined ? {} : {
      multiple: {
        store: authorMultiple.store,
        isItemSelectable,
        ...(authorMultiple.retainedSelectionKeys === undefined ? {} : { retainedSelectionKeys: authorMultiple.retainedSelectionKeys }),
      },
    }),
  } : {
    single: {
      ...singleChoice,
      isItemSelectable: isSingleItemSelectable,
      unavailableReason,
    },
    onFocusedKeyChange,
    isItemActivatable,
  };
  const cardSelection: CollectionProps<Item>['selection'] = singleChoice === undefined ? {
    onFocusedKeyChange: props.selection?.onFocusedKeyChange,
    focusRequest: props.selection?.focusRequest,
    isItemActivatable: props.selection?.isItemActivatable,
    multiple: authorMultiple,
  } : props.selection;

  return (
    <CollectionVirtualizerContext.Provider value={props.virtualizer}>
    <ListMultiSelectionProvider store={multipleStore}>
    <HappierCollectionLayoutContext.Provider value={layoutState}>
      <View ref={rootRef} testID={props.testID} style={rootStyle} onLayout={pageScroll ? onPageViewportLayout : undefined}>
        {/* A page-sized collection scrolls the page's own header and footer with its items. */}
        {pageScroll ? null : props.header}
        <PageScroller enabled={pageScroll && !pageVirtualized} viewport={viewport} request={viewportScrollRequest}>
        {pageScroll ? props.header : null}
        <View testID={props.testID === undefined ? undefined : `${props.testID}:stage`} onLayout={onLayout}
          style={[pageScroll ? pageStageStyle : rootStyle,
            // A standalone page table has the page sheet edge even when it recomposes as a list.
            // A nested sheet already owns that edge (for example the configurator's size table).
            pageSections || (pageScroll && presentation === 'table' && palette !== null && enclosingPageSheet === null)
              ? { marginHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx } : null,
            composition === 'table' && hasRows ? {
              borderWidth: 1,
              borderColor: theme.colors.divider,
              borderRadius: HAPPIER_RADIUS_V1.xl,
            } : null]}>
        <driver.AnimatedView value={progress} tracks={fadeTracks} style={pageScroll ? pageStageRowStyle : stageStyle}>
            <View
              testID={props.listTestID}
              aria-hidden={!listVisible || undefined}
              accessibilityElementsHidden={!listVisible}
              importantForAccessibility={listVisible ? 'auto' : 'no-hide-descendants'}
              style={[paneStyle, { flex: listFlex }, listVisible ? null : hiddenStyle]}
            >
              <ListCollectionHeader search={search.control} store={multipleStore} selectable={selectableKeys.length > 0} />
              {cards && presentation === 'board' && props.loading === true && !hasRows ? (
                // A board that is still reading stands in the same skeleton rows as the table: nothing is
                // known yet about its columns, and "empty" would be a lie.
                <CollectionSkeletonRows
                  rowHeight={metrics.listRow}
                  twoLines
                  viewportHeight={viewportHeight}
                  {...(props.testID === undefined ? {} : { testID: props.testID })}
                />
              ) : cards ? (
                <>
                  <CollectionCards<Item>
                    presentation={presentation}
                    model={model}
                    anatomy={anatomy}
                    accessibilityLabel={props.accessibilityLabel}
                    width={size?.width ?? null}
                    height={viewportHeight}
                    narrow={geometry === null || geometry.mode !== 'split'}
                    boardLayout={props.boardLayout}
                    selectedKey={selectedKey}
                    focusRequest={model.focusRequest}
                    onFocusedKeyChange={onFocusedKeyChange}
                    tabStopKey={tabStopKey}
                    eligibleKeys={navigationKeys}
                    selection={cardSelection}
                    useRowActions={props.useRowActions}
                    {...(props.minCardWidth === undefined ? {} : { minCardWidth: props.minCardWidth })}
                    {...(props.groupAction === undefined ? {} : { groupAction: props.groupAction })}
                    {...(props.loading === undefined ? {} : { loading: props.loading })}
                    {...(props.empty === undefined ? {} : { empty: props.empty })}
                    {...(pageScroll ? { pageScroll: true } : {})}
                    {...(props.testID === undefined ? {} : { testID: props.testID })}
                  />
                  {props.footer}
                  {footerLine}
                </>
              ) : (
              <CollectionStageContext.Provider value={stage as CollectionStage<unknown>}>
                <ListCollectionControlContext.Provider value={control}>
                  <List<CollectionCell<Item>>
                    accessibilityLabel={props.accessibilityLabel}
                    accessibilityPattern="grid"
                    density="compact"
                    contentContainerStyle={gaplessStyle}
                    {...(grouped ? { sections } : { items: sections[0]?.data ?? NO_CELLS })}
                    keyForItem={readCellKey}
                    renderItem={renderCollectionCell as (cell: CollectionCell<Item>) => ReactElement}
                    selection={listSelection}
                    header={columnHeader}
                    empty={props.loading === true && !hasRows ? (
                      <CollectionSkeletonRows
                        rowHeight={rowGeometry === 'table' ? metrics.tableRow : metrics.listRow}
                        twoLines={rowGeometry === 'list'}
                        viewportHeight={viewportHeight}
                        {...(props.testID === undefined ? {} : { testID: props.testID })}
                      />
                    ) : props.empty}
                    footer={(pageSections || props.footer === undefined) && footerLine === null ? undefined : (
                      <>
                        {pageSections ? null : props.footer}
                        {footerLine}
                      </>
                    )}
                  />
                </ListCollectionControlContext.Provider>
              </CollectionStageContext.Provider>
              )}
            </View>
            <driver.AnimatedView
              value={progress}
              tracks={detailTracks}
              testID={props.detailTestID}
              pointerEvents={detailLeaving ? 'none' : 'auto'}
              style={[
                paneStyle,
                detailPaneStyle,
                { backgroundColor: theme.colors.canvas },
                composition === 'split' || overlayDetail ? { borderLeftWidth: 1, borderLeftColor: theme.colors.divider } : null,
                detailVisible ? null : hiddenStyle,
              ]}
            >
              {pane ? null : detailNode}
            </driver.AnimatedView>
          </driver.AnimatedView>
        </View>
        {/* Page sections in a caller's footer own their insets, just like its header. */}
        {pageSections ? props.footer : null}
        </PageScroller>
        {pane ? (
          // The page's app details pane: the same detail, beside the page with the pane's own motion, width and
          // Escape; the list narrows beneath it and keeps the open item marked.
          <CollectionDetailHeadingFocusContext.Provider value={props.detailHeader === undefined ? null : headingFocus}>
          <DetailsPane
            open={openKey !== null}
            {...(openKey !== null && props.detailHeader !== undefined ? props.detailHeader(openKey) : {})}
            onClose={close}
            {...(props.detailTestID === undefined ? {} : { testID: props.detailTestID })}
          >
            {detailNode}
          </DetailsPane>
          </CollectionDetailHeadingFocusContext.Provider>
        ) : null}
      </View>
    </HappierCollectionLayoutContext.Provider>
    </ListMultiSelectionProvider>
    </CollectionVirtualizerContext.Provider>
  );
}

const rootStyle: HappierPortableStyle = { flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' };
/** Inside the page's scroller the stage sizes to its rows instead of filling a fixed height. */
const pageStageStyle: HappierPortableStyle = { minWidth: 0 };
// No `overflow` here: an inline `hidden` would override the scroller's own overflow and stop it scrolling on the web.
const pageScrollerStyle: HappierPortableStyle = { flex: 1, minWidth: 0, minHeight: 0 };
const pageStageRowStyle: HappierPortableStyle = { flexDirection: 'row', minWidth: 0 };

/**
 * The page's one scroller for a page-sized collection. The element is the same in both modes' positions it can
 * take, so switching a Collection's `scroll` is a deliberate remount, never an accidental one.
 */
function PageScroller(props: Readonly<{ enabled: boolean; viewport: HappierCollectionViewport; request: Readonly<{ offset: number }>; children?: ReactNode }>): ReactElement {
  const renderPageScroller = useOptionalPluginUiPresentationHost()?.renderPageScroller;
  const scroll = useRef<ScrollView | null>(null);
  useLayoutEffect(() => {
    if (props.enabled) scroll.current?.scrollTo({ y: props.request.offset, animated: false });
  }, [props.enabled, props.request]);
  if (!props.enabled) return <>{props.children}</>;
  if (renderPageScroller !== undefined) return <>{renderPageScroller(props.children)}</>;
  return (
    <ScrollView ref={scroll} style={pageScrollerStyle} keyboardShouldPersistTaps="handled" scrollEventThrottle={16}
      onScroll={event => { props.viewport.offsetRef.current = event.nativeEvent.contentOffset.y; }}>
      {props.children}
    </ScrollView>
  );
}

const stageStyle: HappierPortableStyle = { flex: 1, flexDirection: 'row', minWidth: 0, minHeight: 0 };
const paneStyle: HappierPortableStyle = { minWidth: 0, minHeight: 0, overflow: 'hidden' };
const hiddenStyle: HappierPortableStyle = { display: 'none' };
const gaplessStyle: HappierPortableStyle = { gap: 0 };
const footerStyle: HappierPortableStyle = {
  minHeight: TABLE.footerHeight,
  flexDirection: 'row',
  alignItems: 'center',
  // One line, like the table it closes: the keys keep their width and the window statement truncates.
  flexWrap: 'nowrap',
  gap: 14,
  paddingHorizontal: TABLE.insetStart,
  borderTopWidth: 1,
};
const hintStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0 };
