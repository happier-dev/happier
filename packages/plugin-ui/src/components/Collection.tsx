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
import { Platform, Pressable, ScrollView, View } from 'react-native';

import {
  resolveHappierUiPalette,
  useHappierUiAccessibility,
  useHappierUiTheme,
  useOptionalHappierUiAccessibility,
  useOptionalHappierUiPalette,
  useOptionalHappierUiPlatform,
  useOptionalHappierUiTypography,
} from '../environment/context.js';
import { HAPPIER_PAGE_METRICS, isHappierPageRowNarrow } from '../presentation/layout/pageMetrics.js';
import { resolveHappierPageTextStyle, resolveHappierTextStepStyle } from '../presentation/layout/pageText.js';
import { HAPPIER_ROW_TITLE_META_GAP_PX, resolveHappierRowTitleMetaPlacement } from '../presentation/layout/pageRowMetrics.js';
import { useHappierPageSection } from '../presentation/layout/PageSection.js';
import { useHappierPageChromeInternal } from '../presentation/layout/pageChrome.js';
import { CollectionToolbarCompactContext, CollectionToolbarOverflowContext, type CollectionToolbarFitReport } from './CollectionToolbar.js';
import { HAPPIER_RADIUS_V1 } from '../environment/radius.js';
import { HappierStatusDot } from '../presentation/status/StatusDot.js';
import { PluginUiIconGlyph, type IconName } from './Icon.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../presentation/semantics.js';
import type { HappierTypeRole, HappierUiTheme, HappierUiTypography } from '../environment/types.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { HappierCollectionDetailWidthContext, HappierCollectionLayoutContext, resolveHappierCollectionLayoutState } from '../presentation/collection/collectionLayout.js';
import { HAPPIER_COLLECTION_LIST_TEXT, HappierCollectionRestingRowsContext, HappierCollectionTableRowContext, type HappierCollectionRestingRows, HappierCollectionTreeRowContext, type HappierCollectionTableRowFacts, type HappierCollectionTreeRowFacts } from '../presentation/collection/CollectionList.js';
import {
  HAPPIER_COLLECTION_INSTANT_MOTION,
  HAPPIER_INSTANT_DISCLOSURE_MOTION,
  type HappierCollectionMotionValue,
} from '../presentation/collection/collectionMotion.js';
import {
  isHappierCollectionTreeBranchOpen,
  resolveHappierCollectionTreeShown,
  type HappierCollectionKey,
  type HappierCollectionSection,
  type HappierCollectionTree,
} from '../presentation/collection/collectionModel.js';
import { resolveHappierTreeKeyIntent, type HappierTreeNode } from '../presentation/navigation/treeInteraction.js';
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
import { useResizableListDetailGeometry, type HappierCollectionRailSizingProps } from '../presentation/collection/useResizableListDetailGeometry.js';
import { HappierResizeHandle } from '../presentation/layout/resize/HappierResizeHandle.js';
import { useCollectionRailLabels, useCollectionRailSizing } from './collectionRailSizing.js';
import { useHappierCollectionViewport, type HappierCollectionModel, type HappierCollectionViewport } from '../presentation/collection/useCollection.js';
import { HappierPressable } from '../presentation/interaction/Pressable.js';
import type { HappierLayoutChangeEvent, HappierPortableStyle } from '../presentation/portableTypes.js';
import { HappierText } from '../presentation/text/Text.js';
import { CollectionCards, CollectionGroupActionButton, readCollectionLineHeight } from './CollectionCards.js';
import { Dropdown } from './Overlay.js';
import { HappierSkeletonRows } from '../presentation/feedback/Skeleton.js';
import { List, ListItemSelectionContext, type ItemProps, type ListMultiSelectionCapabilityProps, type ListSingleChoiceCapabilityProps, type ListSectionData, type ListSelectionProps } from './List.js';
import { encodeHappierSectionRowCellKey, resolveHappierRovingTabStop } from '../presentation/collection/semantics.js';
import { HAPPIER_ROW_CONTENT_POINTER_EVENTS, HAPPIER_ROW_CONTROL_POINTER_EVENTS } from '../presentation/collection/List.js';
import { HappierRadioMark } from '../presentation/form/RadioMark.js';
import { HAPPIER_DISCLOSURE_CHEVRON_METRICS, HappierChevron, HappierDisclosureChevron } from '../presentation/collection/DisclosureChevron.js';
import { ListCollectionControlContext, type ListCollectionControl } from './listCollectionControl.js';
import { CollectionKeyCap, ListCollectionHeader, useListCollectionSearch, useListSelectionModeControl, type ListCollectionSearchToken } from './listCollectionHeader.js';
import { ListMultiSelectionProvider, useListMultiSelectionStoreSnapshot } from './ListMultiSelection.js';
import { renderCollectionItemDestination } from './collectionItemDestination.js';
import { DetailsPane, DetailsPaneBody, PushedDetailHeader, useDetailsPanePlacement, useDetailsPaneHostInstalled } from './DetailsPane.js';
import { CollectionRowNeedsYouHighlight } from './CollectionRowNeedsYouHighlight.js';
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
  /**
   * The column stands right after the title, before the anatomy's slot columns (a task's status word before its
   * Where). Otherwise field columns follow the slots, and the table's trailing Age (and title meta) stay last.
   */
  leading?: boolean;
  /** The column title is a sort button (`CollectionProps.sort`); the caller orders the items. */
  sortable?: boolean;
  /**
   * The table cell stands across this column and every field column after it for this item, which draws no cells
   * there (a machine that reports nothing says why once, across where its figures would stand). The list ignores it.
   */
  spanRest?: (item: Item) => boolean;
  /**
   * A page-section list (`presentation="list"` scrolling with its page) also draws this field as its own end
   * column: at `minWidth`, centred on both lines of the row, so its values line up down every sheet, and the first
   * sheet's bar names the columns (lab `services/list` Ports · Memory · Up). A narrow row (a phone) draws no
   * columns: `byline` is told so (`fieldColumns: false`) and carries what they said. While the columns are drawn
   * a row-aligned `titleMeta` (`titleMetaAlign: 'row'`) gives its place to them; declare the same fact as a field.
   */
  listColumn?: boolean;
}>;

/** The one item anatomy every presentation draws from. Renderers are pure. */
export type CollectionAnatomy<Item> = Readonly<{
  /** Bounded card content, shared by grid and Board; controls stay outside the open target. */
  card?: Readonly<{
    headerRight?: (item: Item) => ReactNode;
    facts?: (item: Item) => ReactNode;
    /**
     * A live description the domain draws (a Board card's status line), in the description's own place: 2 under
     * the title, above the facts. It stands in for the string `description`; a body is for content beyond it.
     */
    description?: (item: Item) => ReactNode;
    body?: Readonly<{
      render: (item: Item) => ReactNode;
      /** A measured domain band, scaled with the reader's text; never a clipping cap. */
      heightAtNormalText?: number;
    }>;
  }>;
  /** Shareable qualified page/location for this item, without transferring selection or navigation ownership. */
  destination?: (item: Item) => NavigationListDestination | null;
  /**
   * An interaction/presence decorator; it never draws or replaces card framing.
   * Destination-only decorators use `destination` instead.
   */
  wrapItem?: (item: Item, content: ReactNode) => ReactNode;
  /** The item's mark; `null` when the kind has none (skills): the list then draws no glyph column for the row. */
  glyph: (item: Item) => ReactNode;
  /**
   * A small mark pinned to the glyph's lower corner in the list (the agent working on the item), on a plate
   * ringed in its tone. The table says the same in its Agent column, so the table draws no badge.
   */
  glyphBadge?: (item: Item) => CollectionGlyphBadge | null;
  title: (item: Item) => string;
  /**
   * The rest of the title line in the table's Entry cell: the item's short designation ("#2481", "!88") as quiet
   * text, or the caller's own inline line (a status word, a command, chips) that gives way before the title does.
   * The list says it in its `byline` instead.
   */
  titleSuffix?: (item: Item) => ReactNode;
  /**
   * The row's own controls on its title line, after `titleSuffix` (a listener's port chip that opens its menu); in
   * the list they end the byline. They are drawn beside the row's press target, never inside it: the row's press
   * target fills the row beneath its content, so a control is its own press and focus target after the row and
   * pressing it never opens the item. Keep non-interactive content in `titleSuffix`/`byline`.
   */
  titleControls?: (item: Item) => ReactNode;
  /**
   * A control in the glyph's place, at the row's start (a checklist's checkbox: tick it without opening the item).
   * Like `titleControls` it is drawn beside the row's press target as its own press and focus target, so pressing
   * the row still opens the item. It takes the glyph's column; the item's `glyph` is not drawn beside it.
   */
  leadingControl?: (item: Item) => ReactNode;
  /**
   * The row needs the person: the person's opt-in needs-you highlight (a bar or a sweep) under its content, only
   * while `unopened` for the moving forms. Omit it for rows in a Needs you shelf; the row already says so there.
   */
  needsYou?: (item: Item) => Readonly<{ unopened: boolean }> | null;
  /** Where the item lives ("payments-api"): the table's Where column. */
  where?: (item: Item) => ReactNode;
  /**
   * The list row's second line, where there is room for who as well as where ("payments-api #2481 · Mara
   * Oduya"). Defaults to `where`. `layout.fieldColumns` says whether the row also draws its `listColumn`
   * fields as columns; when it doesn't (a phone), the byline is where those facts go.
   */
  byline?: (item: Item, layout?: Readonly<{ fieldColumns: boolean }>) => ReactNode;
  /** The one loud fact. */
  reason?: (item: Item) => ReactNode;
  /**
   * The list row's one trailing fact when it has no `reason` ("Overdue", "Codex needs you"): where the table spreads
   * an item's facts across its field columns, the list row has room for one, chosen by the caller. The table and
   * cards never draw it.
   */
  listFact?: (item: Item) => ReactNode;
  signal?: (item: Item) => ReactNode;
  agent?: (item: Item) => ReactNode;
  /** Tabular age ("18m"). */
  age?: (item: Item) => string | null;
  /**
   * The title line's end-aligned meta (a where-summary, "In your library ✓"): tabular, never truncated; the title
   * gives way first, and when the two cannot share the line (`resolveHappierRowTitleMetaPlacement`) the meta wraps
   * under the title, end-aligned. The table draws it as an end-aligned column titled `columnTitles.titleMeta`.
   */
  titleMeta?: (item: Item) => ReactNode;
  /**
   * Where a two-line list row draws its `titleMeta`: `title` (the default) at the title line's end; `row` as the
   * row's own end column, centred on both lines, the way the table draws its column (a service's port beside its
   * name and what it is). Catalog and single-line rows keep it on their one title line.
   */
  titleMetaAlign?: 'title' | 'row';
  fields?: readonly CollectionField<Item>[];
  /** The table-only peek body. */
  peek?: (item: Item) => ReactNode;
  /**
   * The item itself at static props (a document's first lines, a board's columns), drawn as a grid card's preview
   * band above its title. Grid only; every card in the grid reserves the band, so rows stay equal. Pure: no
   * subscriptions or requests.
   */
  preview?: (item: Item) => ReactNode;
  /**
   * What the item is for, in a sentence; a grid card reserves exactly two lines for it. A list row draws it as its
   * second line (one line, truncating first); `byline`/`where` and `reason` then form the third line, where a
   * present `reason` (a status) takes the line in place of the byline (the facts).
   */
  description?: (item: Item) => string | null;
  /**
   * A card's independent header action (Install, Manage, a switch); in a list at rest, the row's trailing
   * action (beside an open detail the list leaves it to the detail). It is its own press and focus target beside the
   * card's or row's, never inside it, and never opens the item.
   */
  action?: (item: Item) => ReactNode;
  /** The composed row name ("Pull request #2481, Review requested"). */
  accessibilityLabel: (item: Item) => string;
  accessibilityHint?: (item: Item) => string | undefined;
  testID?: (item: Item) => string;
  /** Column titles for the table header, one per slot the anatomy declares. */
  columnTitles: Readonly<{ title: string; where?: string; reason?: string; signal?: string; agent?: string; age?: string; titleMeta?: string }>;
}>;

/**
 * The glyph's corner mark: an icon, live dot, or contributed mark drawn at the supplied owner slot size; `tone` inks the mark and rings its
 * plate (none: the quiet border). The Collection draws and sizes it, so every badge in a list is one size.
 */
export type CollectionGlyphBadge = Readonly<
  { icon: IconName; tone?: HappierTone } | { live: true; tone?: HappierTone } | { mark: (pixelSize: number) => ReactNode; tone?: HappierTone }
>;

/** A group header's one action. */
/**
 * A group header's one action: a quiet link by default ("See all"); `operation` when it changes something
 * ("Clean up 3 · 1.4 GB"), drawn as a small bordered button.
 */
export type CollectionGroupAction = Readonly<{ label: string; onPress: () => void; kind?: 'link' | 'operation' }>;

/** The table's sort: the active field or named order; the caller orders the items. */
export type CollectionSort = Readonly<{
  key: string;
  direction: 'ascending' | 'descending';
  /** Named orders offered by the title column's menu, only in table geometry. */
  orders?: readonly Readonly<{ key: string; label: string }>[];
  onChange: (key: string) => void;
}>;

/**
 * A totals row after the last group ("Happier in total"): its title in the title column and `cells[field.key]`
 * under each field column. Not a row of the collection: never focused, selected or opened.
 */
export type CollectionSummaryRow = Readonly<{
  key: string;
  title: ReactNode;
  cells?: Readonly<Record<string, ReactNode>>;
  testID?: string;
}>;

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

/**
 * What the Collection hands a `header` render to place in the caller's own row (lab `cbar`: the title, the
 * search with its tokens, then the page's trailing controls).
 */
export type CollectionHeaderSlots = Readonly<{
  /**
   * The page's name (`title`) as the row's heading, to lead it; `null` without `title`, or where the host's
   * navigation already shows the page title (a phone's header), so the page never says its name twice.
   */
  title: ReactNode;
  /** The search field and its tokens at the toolbar's bounded width; `null` without `search`. */
  search: ReactNode;
  /**
   * The touch-sized control that enters and leaves multi-selection ("Select" / "Done selecting"); `null` when the
   * Collection cannot select. A header render that receives it places it in its row: the Collection then draws no
   * row of its own for it.
   */
  selection: ReactNode;
  /**
   * What the host keeps beside a page's title (the machine the page runs on). Placed in the row, it joins that row
   * and the host draws no separate band for it; left out, the host keeps its band. `null` outside a host page.
   */
  pageActions: ReactNode;
}>;

export type CollectionDetailRenderContext = Readonly<{
  /** The host already draws the identity band; the detail keeps only its body facts. */
  headerHosted: boolean;
  /**
   * The detail is the page (a phone, or side panes turned off): it fills the Collection's region instead of sitting
   * beside the list or in the host's details pane. Pin the detail's one primary then, by ending its own full-height
   * column with `DetailsPaneFooter`; beside the page keep that primary in the details header's `actions`.
   */
  pushed: boolean;
}>;

/** Controlled local choice; changing it never opens the model's detail. */
export type CollectionSingleChoice<Item> = Omit<ListSingleChoiceCapabilityProps<Item>, 'isItemSelectable' | 'unavailableReason'> & Readonly<{
  isItemSelectable?: (item: Item) => boolean;
  unavailableReason?: (item: Item) => string | null;
}>;

export type CollectionProps<Item> = HappierCollectionRailSizingProps & Readonly<{
  labels?: Readonly<{ resize: string; resizeHint?: string; resizeValue?: (px: number) => string }>;
  model: HappierCollectionModel<Item>;
  anatomy: CollectionAnatomy<Item>;
  accessibilityLabel: string;
  /**
   * The page's name, when this Collection is the page (a work page such as PRs & Issues). A header render
   * receives it as `slots.title` and leads its row with it.
   */
  title?: string;
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
   * Beside the list (an in-page split), `renderDetail` receives `headerHosted: false` and owns its inline header;
   * pushed (the detail is the page) the Collection leads it with the way back and this band. Given it, the Collection
   * also owns the detail body's edge in every container: plain content stands on the title's edge, and sheets, page
   * states and a `PageHeader` inside keep their own edges. Without it the detail draws its own edge.
   */
  detailHeader?: (key: HappierCollectionKey) => CollectionDetailHeader;
  /** Pane minima (the caller's readable measures at the reader's text size) and the split preference. */
  minListWidth: number;
  minDetailWidth: number;
  preferredListRatio: number;
  /**
   * The narrowest card at normal text size: the grid's columns follow the measured width, and a board's columns keep
   * at least this card (with its insets), scrolling sideways rather than squeezing it.
   */
  minCardWidth?: number;
  /**
   * A grid whose width holds only one column: `stack` (default) puts each group's cards one under the other;
   * `page` keeps each group in one row that pages sideways, a card at `minCardWidth` with the next card's edge
   * showing (a phone shelf, lab store `st-hscroll`). Wider grids are unchanged.
   */
  narrowGrid?: 'stack' | 'page';
  /**
   * One action at the end of a group's header ("See all" on a shelf the caller shortened, "All results" on the one
   * it focused), by group key; `null` where the group has none. Drawn on grid shelves and on list and table groups.
   */
  groupAction?: (groupKey: string) => CollectionGroupAction | null;
  /**
   * Groups drawn as their band alone in the list and table, by group key: the title, the count of the rows it
   * holds and what they share ("Done 6 · This week"), with the rows put away (not drawn, not focusable). The
   * caller owns which groups are collapsed and offers the way to open one, usually the group's `groupAction`.
   */
  collapsedGroups?: ReadonlySet<string>;
  /** Sortable field titles in the table (`CollectionField.sortable`); the Collection never reorders. */
  sort?: CollectionSort;
  /** Totals rows after the last group, aligned under the field columns (two columns in the list). */
  summaryRows?: readonly CollectionSummaryRow[];
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
   * How many rows the reading list is known to hold (a folder's child count), so its loading rows reserve that
   * much; without it a page-scrolling list reserves a short run (lab `rp` ST 1) and a bounded one fills its view.
   * A grid reads it as rows of cards (a shelf that shows one row reserves one row).
   */
  loadingRows?: number;
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
    /**
     * Placed by a `header` render: `fill` takes the whole width the render gives it (a dialog's tools row, where
     * the search is the row's last, growing field) instead of the toolbar's bounded width. `fixed` holds the narrowest
     * readable width on a wide row, so the controls after it stay put when a page swaps lenses whose narrowing
     * controls differ (Actions: Runs and Workflows).
     */
    width?: 'bounded' | 'fill' | 'fixed';
    testID?: string;
  }>;
  empty?: ReactNode;
  /**
   * What the page says beneath rows it still shows: an empty answer below rows that stand outside the reader's
   * narrowing (the pins a filter leaves), so a narrowed list never ends in a blank canvas. It scrolls with the rows
   * and is never a row a reader moves through.
   */
  afterRows?: ReactNode;
  /**
   * The page's own chrome above the Collection (a toolbar, notices), across both panes. It sits inside the
   * Collection's layout, so it reads the measured mode (`useHappierCollectionLayout`) like everything else inside.
   * A `grid` scrolls it with the cards (a page of cards reads as one page); the other views keep it fixed.
   * As a render it receives the Collection's own controls (`CollectionHeaderSlots`) to place in its row: the
   * search then leaves the list pane and stands where the render puts it, at a bounded width.
   */
  header?: ReactNode | ((slots: CollectionHeaderSlots) => ReactNode);
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
  | Readonly<{ kind: 'peek'; key: string; itemKey: string; item: Item }>
  /** The caller's `afterRows`: one cell after the last group, scrolling with the rows, never a focus stop. */
  | Readonly<{ kind: 'after'; key: string; content: ReactNode; item?: undefined }>;

/** Table geometry, at normal text size. */
const TABLE = Object.freeze({
  insetStart: 20,
  insetEnd: 8,
  glyphWidth: 34,
  gap: 12,
  chevronWidth: 28,
  /** One nesting level, and the disclosure's own slot before the glyph: the shared disclosure box. */
  treeIndent: HAPPIER_DISCLOSURE_CHEVRON_METRICS.boxPx,
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
  where: { minWidth: 150, priority: 4, maxWidth: 224 },
  reason: { minWidth: 172, priority: 5 },
  signal: { minWidth: 124, priority: 2 },
  agent: { minWidth: 150, priority: 3 },
  age: { minWidth: 46, priority: 6, align: 'end' as const },
  titleMeta: { minWidth: 120, priority: 7, align: 'end' as const },
});
type SlotKey = keyof typeof SLOT_COLUMNS;
const SLOT_KEYS: readonly SlotKey[] = ['where', 'reason', 'signal', 'agent', 'titleMeta', 'age'];
const TRAILING_SLOT_KEYS: ReadonlySet<SlotKey> = new Set(['titleMeta', 'age']);

type ResolvedColumn<Item> = HappierCollectionTableColumn & Readonly<{
  title: string;
  align: 'start' | 'end';
  render: ((item: Item) => ReactNode) | null;
  /** The field key a sortable column sorts by, and the key its summary cell is read under. */
  fieldKey: string | null;
  sortable: boolean;
  /** A field's `spanRest`: the cell takes the width of every following column for that item. */
  spanRest?: (item: Item) => boolean;
}>;

/** A nested table row's leading slot: its indent and disclosure. */
type TreeLeading = Readonly<{ width: number; content: ReactNode }>;

/** What a row reads of the tree: the model's nodes and open parents, while the table nests. */
type CollectionTreeStage = Readonly<{
  nodes: HappierCollectionTree;
  openBranches: ReadonlySet<HappierCollectionKey>;
  setBranchOpen: (key: HappierCollectionKey, open: boolean) => void;
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
  /** The tree, while the table presentation nests (`model.tree`); rows lead with its slot in every geometry. */
  tree: CollectionTreeStage | null;
  /**
   * The list is the resting view (a phone, a narrow page) and no row travels to or from a table: titles may
   * take two lines and rows size to them. Beside a detail rows keep the exact height the travel plans with.
   */
  wrapTitles: boolean;
  /** The `listColumn` fields a page-section list row draws as its end columns (none on a narrow stage). */
  listColumns: readonly CollectionField<Item>[];
  /** The resting list is ruled (`restingRows` `ruled`/`ruled-page`): the row inset at both ends, else null. */
  ruledInsetPx: number | null;
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
/** The gap between a list row's lines. */
const LIST_LINE_GAP = 4;
/** A list row's title keeps this share of the table's title minimum before its title meta moves beneath it. */
const LIST_TITLE_MIN_SHARE = 0.5;
/** The list row's action stands at the row's end inset, mirroring where its text starts. */
const LIST_ACTION_INSET = TABLE.insetStart - TABLE.insetEnd;
/**
 * A ruled resting list's row inset, at both ends: where a row action ends (its own margin and the accessory cell's
 * inset), so text, status, action and loading rows share one edge pair, the dialog's tools band above them. `ruled`:
 * the card's 24; `ruled-page`: the page gutter (the action's margin shrinks to keep the action on it).
 */
function ruledRowInset(theme: HappierUiTheme, restingRows: HappierCollectionRestingRows): number {
  return restingRows === 'ruled-page' ? theme.spacing.large : LIST_ACTION_INSET + theme.spacing.medium;
}
const listActionStyle: HappierPortableStyle = { marginRight: LIST_ACTION_INSET };
/** The title meta: end-aligned, whole (it never shrinks; the title gives way). */
const metaCellStyle: HappierPortableStyle = { flexShrink: 0, alignItems: 'flex-end', marginLeft: HAPPIER_ROW_TITLE_META_GAP_PX };
/** A two-line row's meta as its own end column, centred on both lines (`titleMetaAlign: 'row'`). */
const rowMetaColumnStyle: HappierPortableStyle = { flexShrink: 0, alignSelf: 'center' };
const NO_ROW_ACTIONS: CollectionRowActions = Object.freeze({});
/** The table's and the side list's rows are ruled; the resting list (a phone, a narrow page) parts its rows by air. */
const RULED_ROW: HappierCollectionTableRowFacts = Object.freeze({ hairline: true });
const RESTING_LIST_ROW: HappierCollectionTableRowFacts = Object.freeze({ hairline: false });
const NO_CELLS: readonly never[] = Object.freeze([]);
const CollectionStageContext = createContext<CollectionStage<unknown> | null>(null);

function useRowMetrics(described: boolean): RowMetrics {
  const theme = useHappierUiTheme();
  const typography = useOptionalHappierUiTypography();
  const { textScale } = useHappierUiAccessibility();
  return useMemo(() => resolveRowMetrics(described, theme, typography, textScale), [described, textScale, theme, typography]);
}

function resolveRowMetrics(
  described: boolean,
  theme: HappierUiTheme,
  typography: HappierUiTypography | null,
  textScale: number,
): RowMetrics {
  // The host's row anatomy: the row title role over the row meta role (`label` / `body`).
  const title = readCollectionLineHeight('label', theme, typography, textScale);
  const meta = readCollectionLineHeight('meta', theme, typography, textScale);
  const label = readCollectionLineHeight('label', theme, typography, textScale);
  // A described anatomy's list row adds its description line (the row description role) between the two.
  const description = described ? readCollectionLineHeight('body', theme, typography, textScale) + LIST_LINE_GAP : 0;
  return {
    // One exact height per geometry and text-size bucket, never measured per row (COLLECTION.md §7).
    tableRow: Math.max(40, title + 2 * TABLE.paddingY) + 2,
    listRow: title + LIST_LINE_GAP + description + meta + 2 * TABLE.paddingY + 2,
    groupHeader: label + 18,
    titleRole: 'label',
  };
}

function resolveColumns<Item>(
  anatomy: CollectionAnatomy<Item>,
  width: number,
  textScale: number,
  rowAccessoryWidth: number,
  leadingWidth: number,
): readonly ResolvedColumn<Item>[] {
  const declared: ResolvedColumn<Item>[] = [{
    key: 'title',
    title: anatomy.columnTitles.title,
    minWidth: TABLE.titleMinWidth * textScale,
    priority: Number.POSITIVE_INFINITY,
    flex: true,
    align: 'start',
    render: null,
    fieldKey: null,
    sortable: false,
  }];
  const fieldColumn = (field: CollectionField<Item>): ResolvedColumn<Item> => ({
    key: `field:${field.key}`,
    title: field.title,
    minWidth: field.minWidth * textScale,
    priority: field.priority,
    align: field.align ?? 'start',
    render: field.render,
    fieldKey: field.key,
    sortable: field.sortable === true,
    ...(field.spanRest === undefined ? {} : { spanRest: field.spanRest }),
  });
  const fields = anatomy.fields ?? [];
  for (const field of fields) if (field.leading === true) declared.push(fieldColumn(field));
  const slotColumn = (slot: SlotKey) => {
    const render = anatomy[slot];
    if (render === undefined) return;
    const column = SLOT_COLUMNS[slot];
    declared.push({
      key: slot,
      title: anatomy.columnTitles[slot] ?? '',
      minWidth: column.minWidth * textScale,
      ...('maxWidth' in column ? { maxWidth: column.maxWidth * textScale } : {}),
      priority: column.priority,
      align: 'align' in column ? column.align : 'start',
      render: slot === 'age' ? (item) => (anatomy.age?.(item) ?? null) : render as (item: Item) => ReactNode,
      fieldKey: null,
      sortable: false,
    });
  };
  // The end-aligned trailing slots (title meta, Age) close the row after every field column.
  for (const slot of SLOT_KEYS) if (!TRAILING_SLOT_KEYS.has(slot)) slotColumn(slot);
  for (const field of fields) if (field.leading !== true) declared.push(fieldColumn(field));
  for (const slot of SLOT_KEYS) if (TRAILING_SLOT_KEYS.has(slot)) slotColumn(slot);
  const available = width - TABLE.insetStart - TABLE.insetEnd - TABLE.glyphWidth - TABLE.gap - rowAccessoryWidth - leadingWidth;
  return resolveHappierCollectionTableColumns({ columns: declared, availableWidth: available, gap: TABLE.gap });
}

/** Whether the table at this width shows any column beside the title (an anatomy with no columns always does). */
function tableShowsBesideTitle<Item>(
  anatomy: CollectionAnatomy<Item>,
  width: number,
  textScale: number,
  rowAccessoryWidth: number,
  leadingWidth: number,
): boolean {
  const declared = SLOT_KEYS.some((slot) => anatomy[slot] !== undefined) || (anatomy.fields?.length ?? 0) > 0;
  return !declared || resolveColumns(anatomy, width, textScale, rowAccessoryWidth, leadingWidth).length > 1;
}

/** The first fact never shrinks, the last only once the middle is gone, the middle first. */
function windowPartShrink(index: number, count: number): number {
  if (index === 0) return 0;
  return index === count - 1 ? 1 : 1_000_000;
}

/** Placeholder title widths, deterministic so a refresh never shimmers into a different shape. */
/** The collection rows' geometry for the shared loading rows: their insets, glyph column and gap. */
const COLLECTION_SKELETON_GEOMETRY = Object.freeze({
  insetStart: TABLE.insetStart,
  insetEnd: TABLE.insetEnd,
  glyphColumn: TABLE.glyphWidth - TABLE.gap,
  gap: TABLE.gap,
});

/**
 * The rows that are coming, standing in their own geometry while the first window loads: the shared
 * loading rows (`HappierSkeletonRows`) at the row height of the current geometry, with the meta line in the
 * list and the row hairline — as many as fill what is on screen, so nothing moves when the real rows land
 * and "empty" is never said early.
 */
const PAGE_LOADING_RUN_ROWS = 7;

function CollectionSkeletonRows(props: Readonly<{
  theme: HappierUiTheme;
  rowHeight: number;
  twoLines: boolean;
  viewportHeight: number | null;
  /** Rows known to be coming, else `pageRun` (a page-scrolling list) caps the fill at a short run. */
  rows?: number;
  pageRun?: boolean;
  /** The row insets the placeholders stand at; the table's own unless a ruled resting list sets its inset. */
  ruledInsetPx?: number;
  testID?: string;
  accessibilityLabel?: string;
  reducedMotion?: boolean;
}>): ReactElement {
  const { theme } = props;
  const palette = useOptionalHappierUiPalette() ?? resolveHappierUiPalette(theme);
  const fill = props.viewportHeight === null ? 1 : Math.max(1, Math.ceil(props.viewportHeight / props.rowHeight));
  // A page-scrolling list's own height is only what it draws, so it cannot say how many rows fill the view: it
  // reserves the short run instead of measuring itself down to one row.
  const count = props.rows !== undefined ? Math.max(1, props.pageRun === true ? Math.round(props.rows) : Math.min(fill, Math.round(props.rows)))
    : props.pageRun === true ? PAGE_LOADING_RUN_ROWS : fill;
  return (
    <HappierSkeletonRows
      rows={count}
      theme={theme}
      rowHeight={props.rowHeight}
      lines={props.twoLines ? 2 : 1}
      dividerColor={palette.rowDivider}
      geometry={props.ruledInsetPx === undefined
        ? COLLECTION_SKELETON_GEOMETRY
        : { ...COLLECTION_SKELETON_GEOMETRY, insetStart: props.ruledInsetPx, insetEnd: props.ruledInsetPx }}
      {...(props.accessibilityLabel === undefined ? {} : { accessibilityLabel: props.accessibilityLabel })}
      {...(props.reducedMotion === undefined ? {} : { reducedMotion: props.reducedMotion })}
      {...(props.testID === undefined ? {} : { rowTestID: `${props.testID}:skeleton-row` })}
    />
  );
}

/**
 * The frame of a Collection page before the page has loaded: the table's ruled column band, its rows
 * (`CollectionSkeletonRows`) at the table's own height and insets filling the view, and the ruled footer band
 * the window line will fill. A host stands it under a
 * page's identity toolbar while the plugin bundle loads, so the first frame already has the loaded page's width,
 * insets and row rhythm and nothing changes shape when the Collection arrives. It carries its own theme because
 * it is drawn before any plugin environment exists.
 */
export type CollectionLoadingRowsProps = Readonly<{
  theme: HappierUiTheme;
  /** What is loading; announced once as a busy region. Absent, the placeholder is decoration. */
  accessibilityLabel?: string;
  reducedMotion?: boolean;
  testID?: string;
}>;

export function CollectionLoadingRows(props: CollectionLoadingRowsProps): ReactElement {
  const { theme } = props;
  const typography = useOptionalHappierUiTypography();
  const textScale = useOptionalHappierUiAccessibility()?.textScale ?? 1;
  const metrics = useMemo(() => resolveRowMetrics(false, theme, typography, textScale), [textScale, theme, typography]);
  const palette = useOptionalHappierUiPalette() ?? resolveHappierUiPalette(theme);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const onLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setViewportHeight((current) => (current === height ? current : height));
  }, []);
  return (
    <View testID={props.testID} onLayout={onLayout} style={loadingFrameStyle}>
      <View style={{ height: TABLE.headerHeight, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }} />
      <View style={loadingRowsStyle}>
        <CollectionSkeletonRows
          theme={theme}
          rowHeight={metrics.tableRow}
          twoLines={false}
          viewportHeight={viewportHeight}
          {...(props.testID === undefined ? {} : { testID: props.testID })}
          {...(props.accessibilityLabel === undefined ? {} : { accessibilityLabel: props.accessibilityLabel })}
          {...(props.reducedMotion === undefined ? {} : { reducedMotion: props.reducedMotion })}
        />
      </View>
      <View style={{ height: TABLE.footerHeight, borderTopWidth: 1, borderTopColor: palette.rowDivider }} />
    </View>
  );
}

const loadingFrameStyle: HappierPortableStyle = { flex: 1, minHeight: 0, width: '100%' };
const loadingRowsStyle: HappierPortableStyle = { flex: 1, minHeight: 0, overflow: 'hidden' };

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
const flexCellStyle: HappierPortableStyle = { flex: 1, minWidth: 0 };
const orderHeaderCellStyle: HappierPortableStyle = { alignItems: 'flex-start' };
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
/**
 * The resting list (a phone, a narrow page) sits on the page's own edges (DESIGN.md: title, sections and sheets
 * share one edge): its group heading, row marks and trailing facts line up with the toolbar, not a band's inset.
 * The row's 1 pt focus-ring band is the only inset left. A row with an accessory cell after it keeps that cell's.
 */
const restingListContentStyle: HappierPortableStyle = { paddingLeft: 0 };
const restingListTrailingStyle: HappierPortableStyle = { paddingLeft: 0, paddingRight: 0 };
/**
 * A page section's row: the page row's inset, rhythm and leading column (`HAPPIER_PAGE_METRICS`). The row's
 * press target already draws a 1 pt edge inside the sheet, so the inset gives that point back.
 */
const pageRowContentStyle: HappierPortableStyle = {
  paddingLeft: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx - 1,
  paddingVertical: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx,
  gap: HAPPIER_PAGE_METRICS.rowLeadingGapPx,
  minHeight: HAPPIER_PAGE_METRICS.rowMinHeightPx,
};
const pageRowTrailingStyle: HappierPortableStyle = { paddingRight: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx - 1 };
const pageRowGlyphStyle: HappierPortableStyle = { width: HAPPIER_PAGE_METRICS.rowLeadingColumnPx, alignItems: 'center' };
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
function SlotContent(props: Readonly<{ value: ReactNode; tone?: 'secondary' | 'muted'; tabular?: boolean; textStyle?: HappierPortableStyle }>): ReactElement | null {
  const value = props.value;
  if (value === null || value === undefined || value === false) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    // Tabular figures only where a column of figures must align (Age, numbers); in words ("payments-api") they
    // widen the hyphen and the digits of a designation.
    const tabular = props.tabular === true || typeof value === 'number';
    return (
      <HappierText variant="meta" tone={props.tone ?? 'secondary'} numberOfLines={1} tabularNumbers={tabular} style={props.textStyle ?? cellTextStyle}>
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
  /** A nested table's indent and disclosure, before the glyph. */
  leading?: TreeLeading | null;
}>): ReactElement {
  const { item, anatomy } = props;
  const layer = rowLayerPointerEvents(anatomy);
  return (
    <View pointerEvents={layer?.content} style={[tableRowContentStyle, { height: props.height }]}>
      {props.leading === undefined || props.leading === null ? null : (
        <View pointerEvents={layer?.control} style={[treeLeadingStyle, { width: props.leading.width }]}>{props.leading.content}</View>
      )}
      {item !== null && props.withTitle && anatomy.leadingControl !== undefined ? (
        <View pointerEvents={layer?.control} style={glyphStyle}>{anatomy.leadingControl(item)}</View>
      ) : (
        <View pointerEvents={layer?.leaf} style={glyphStyle}>{item === null || !props.withTitle ? null : anatomy.glyph(item)}</View>
      )}
      {renderTableRowCells(item, props.columns, (column, spanWidth) => (
        <View key={column.key} pointerEvents={column.render === null ? layer?.content : layer?.leaf}
          style={spanWidth === null ? cellStyle(column as ResolvedColumn<unknown>) : [cellStyle(column as ResolvedColumn<unknown>), { width: spanWidth }]}>
          {item === null ? null : column.render === null ? (
            props.withTitle ? <TableTitle item={item} anatomy={anatomy} /> : null
          ) : <TableCellValue value={column.render(item)} tabular={column.key === 'age'} />}
        </View>
      ))}
    </View>
  );
}

/**
 * One row's cells in column order. A cell whose field spans the rest for this item takes the width of itself, every
 * following column and the gaps between them, and the columns after it draw nothing for that row.
 */
function renderTableRowCells<Item>(
  item: Item | null,
  columns: readonly ResolvedColumn<Item>[],
  renderCell: (column: ResolvedColumn<Item>, spanWidth: number | null) => ReactElement,
): ReactElement[] {
  const cells: ReactElement[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index]!;
    if (item !== null && column.spanRest !== undefined && column.flex !== true && column.spanRest(item)) {
      const rest = columns.slice(index);
      cells.push(renderCell(column, rest.reduce((sum, next) => sum + next.minWidth, 0) + TABLE.gap * (rest.length - 1)));
      break;
    }
    cells.push(renderCell(column, null));
  }
  return cells;
}

/**
 * A data cell with nothing to say draws a quiet dash (lab `.td` "—"), so an empty column reads as "none" rather
 * than as a column that failed to load, and every column keeps its place as values arrive. The dash is visual only:
 * the row's announcement already omits what is not there.
 */
function TableCellValue(props: Readonly<{ value: ReactNode; tabular: boolean }>): ReactElement {
  const value = props.value;
  if (value === null || value === undefined || value === false || value === '') {
    return <HappierText accessible={false} variant="meta" tone="muted" numberOfLines={1} style={cellTextStyle}>{EMPTY_CELL_MARK}</HappierText>;
  }
  return <SlotContent value={value} tabular={props.tabular} />;
}

const EMPTY_CELL_MARK = '—';

/** The table's Entry cell: the title, then its designation quietly after it (lab `.tt` + `.nb`). */
function TableTitle<Item>(props: Readonly<{ item: Item; anatomy: CollectionAnatomy<Item> }>): ReactElement {
  const { item, anatomy } = props;
  const suffix = anatomy.titleSuffix?.(item) ?? null;
  const controls = anatomy.titleControls?.(item) ?? null;
  if (controls !== null && controls !== false) {
    // A row with controls: the title and its line pass presses to the row beneath; the controls take their own.
    const layer = rowLayerPointerEvents(anatomy);
    const empty = suffix === null || suffix === false || suffix === '';
    return (
      <View pointerEvents={layer?.content} style={titleWithLineStyle}>
        <View pointerEvents={layer?.leaf} style={empty ? titleTextStyle : titleBeforeLineStyle}>
          <HappierText variant="label" tone="neutral" numberOfLines={1}>{anatomy.title(item)}</HappierText>
        </View>
        {empty ? null : (
          <View pointerEvents={layer?.leaf} style={titleLineStyle}>
            {typeof suffix === 'string' || typeof suffix === 'number'
              ? <HappierText variant="meta" tone="muted" numberOfLines={1} tabularNumbers>{suffix}</HappierText>
              : suffix}
          </View>
        )}
        <View pointerEvents={layer?.control} style={controlsStyle}>{controls}</View>
      </View>
    );
  }
  const inline = suffix !== null && suffix !== false && typeof suffix !== 'string' && typeof suffix !== 'number';
  const title = (
    <HappierText variant="label" tone="neutral" numberOfLines={1} style={inline ? titleBeforeLineStyle : titleTextStyle}>
      {anatomy.title(item)}
    </HappierText>
  );
  if (suffix === null || suffix === false || suffix === '') return title;
  if (inline) {
    return (
      <View style={titleWithLineStyle}>
        {title}
        <View style={titleLineStyle}>{suffix}</View>
      </View>
    );
  }
  return (
    <View style={titleWithSuffixStyle}>
      {title}
      <HappierText
        variant="meta"
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
const treeLeadingStyle: HappierPortableStyle = { alignItems: 'flex-end', justifyContent: 'center' };
const branchStyle: HappierPortableStyle = {
  width: TABLE.treeIndent,
  height: TABLE.treeIndent,
  borderRadius: HAPPIER_RADIUS_V1.sm,
  alignItems: 'center',
  justifyContent: 'center',
};
const titleWithSuffixStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'baseline', gap: 6, minWidth: 0 };
// A short designation keeps its width; a longer quiet phrase gives way before it can squeeze out the title.
const titleSuffixStyle: HappierPortableStyle = { flexShrink: 0, maxWidth: '60%' };
// The title keeps its name whole up to most of the cell; the line after it truncates first (lab `rp` H).
const titleWithLineStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 };
const titleBeforeLineStyle: HappierPortableStyle = { flexShrink: 0, maxWidth: '70%' };
const titleLineStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1, overflow: 'hidden' };
// The row's controls keep their width; the quiet line before them gives way first.
const controlsStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 };
const whereWithControlsStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1 };

/**
 * A row with `titleControls` lies over its press target (`contentBesidePressable`): its content lets presses
 * through, its plain cells take none, and its controls (and a tree row's disclosure) take their own. `null` for a
 * row without controls, whose content stays inside its press target.
 */
function rowLayerPointerEvents<Item>(anatomy: CollectionAnatomy<Item>): Readonly<{
  content: typeof HAPPIER_ROW_CONTENT_POINTER_EVENTS;
  leaf: 'none';
  control: typeof HAPPIER_ROW_CONTROL_POINTER_EVENTS;
}> | null {
  return hasRowControls(anatomy) ? ROW_LAYER_POINTER_EVENTS : null;
}
function hasRowControls<Item>(anatomy: CollectionAnatomy<Item>): boolean {
  return anatomy.titleControls !== undefined || anatomy.leadingControl !== undefined;
}
const ROW_LAYER_POINTER_EVENTS = {
  content: HAPPIER_ROW_CONTENT_POINTER_EVENTS,
  leaf: 'none',
  control: HAPPIER_ROW_CONTROL_POINTER_EVENTS,
} as const;

function ListCells<Item>(props: Readonly<{
  item: Item;
  anatomy: CollectionAnatomy<Item>;
  height: number;
  secondLine: Readonly<{ value: HappierCollectionMotionValue; tracks: HappierCollectionMotionTracks }>;
  AnimatedView: ReturnType<typeof useMotionDriver>['AnimatedView'];
  /** The resting phone list: a title may take a second line and the row grows to it (no travel to plan). */
  wrapTitle: boolean;
  /** The resting list is ruled: the row inset at both ends (the table's insets instead of the page's edges), else null. */
  ruledInsetPx: number | null;
  pageSection: boolean;
  /** No accessory cell follows the row's content, so the content runs to the row's trailing edge. */
  ownsTrailingInset: boolean;
  /** The `listColumn` fields drawn as the row's end columns (`CollectionStage.listColumns`). */
  listColumns: readonly CollectionField<Item>[];
}>): ReactElement {
  const { item, anatomy, AnimatedView } = props;
  const typography = useOptionalHappierUiTypography();
  const uiTheme = useHappierUiTheme();
  // The row's 1 pt press edge is part of its inset. A ruled row with no trailing control ends where its action
  // would, so a status at the title's end and an Add button share one end edge.
  const ruledPaddingPx = (props.ruledInsetPx ?? 0) - 1;
  const ruledStyle: HappierPortableStyle = props.ownsTrailingInset
    ? { paddingLeft: ruledPaddingPx, paddingRight: ruledPaddingPx }
    : { paddingLeft: ruledPaddingPx };
  const age = anatomy.age?.(item) ?? null;
  const fieldColumns = props.listColumns.length > 0;
  const where = anatomy.byline === undefined ? anatomy.where?.(item) : anatomy.byline(item, { fieldColumns });
  const reason = anatomy.reason?.(item);
  // The second line ends with the loud reason, or else the caller's one list fact.
  const lineEnd = reason === undefined || reason === null || reason === false || reason === '' ? anatomy.listFact?.(item) : reason;
  const description = anatomy.description?.(item) ?? null;
  const described = anatomy.description !== undefined;
  // A row-aligned meta gives its place to the field columns while they are drawn (see `listColumn`).
  const titleMeta = fieldColumns && anatomy.titleMetaAlign === 'row' ? null : anatomy.titleMeta?.(item);
  const meta = titleMeta === undefined || titleMeta === null || titleMeta === false ? null : titleMeta;
  const badge = anatomy.glyphBadge?.(item) ?? null;
  // An item with no mark (a skill) draws no glyph column in the list; its text starts at the row's inset.
  const leadingControl = anatomy.leadingControl?.(item) ?? null;
  const glyph = leadingControl === null ? (anatomy.glyph(item) ?? null) : null;
  const [metaPlacement, setMetaPlacement] = useState<'inline' | 'beneath'>('inline');
  const measured = useRef({ row: 0, meta: 0 });
  const { textScale } = useHappierUiAccessibility();
  const titleMinWidth = TABLE.titleMinWidth * textScale * LIST_TITLE_MIN_SHARE;
  const placeMeta = useCallback((next: Partial<{ row: number; meta: number }>) => {
    measured.current = { ...measured.current, ...next };
    setMetaPlacement(resolveHappierRowTitleMetaPlacement({
      rowContentWidthPx: measured.current.row,
      titleNaturalWidthPx: Number.POSITIVE_INFINITY,
      metaNaturalWidthPx: measured.current.meta,
      titleMinWidthPx: titleMinWidth,
    }));
  }, [titleMinWidth]);
  // In a page section the rows are page rows: the same inset, leading column, rhythm and type steps as every
  // other sheet on the page, so a collection's sheet and an `ItemGroup` below it read as one anatomy. The list
  // never travels there (no table), so its rows size to their text.
  const page = props.pageSection;
  const secondLine = page ? { ...resolveHappierPageTextStyle('rowDescription', typography), flexShrink: 1 } : undefined;
  const metaOnRow = anatomy.titleMetaAlign === 'row' && meta !== null;
  const metaCell = meta === null ? null : (
    <View style={metaCellStyle} onLayout={(event) => { placeMeta({ meta: event.nativeEvent.layout.width }); }}>
      <SlotContent value={meta} textStyle={secondLine} />
    </View>
  );
  // A status takes the facts line: with a description, line 3 is the reason when there is one, else the byline.
  const status = reason === undefined || reason === null || reason === false || reason === '' ? null : reason;
  const factsLine = described ? (status ?? where) : null;
  const layer = rowLayerPointerEvents(anatomy);
  const controls = anatomy.titleControls?.(item) ?? null;
  // A row's controls end its byline, beside the row's press target (see `titleControls`).
  const facts = (value: ReactNode) => layer === null ? <SlotContent value={value} textStyle={secondLine} /> : (
    <>
      <View pointerEvents={layer.leaf} style={whereWithControlsStyle}><SlotContent value={value} textStyle={secondLine} /></View>
      {controls === null || controls === false || (described && status !== null) ? null : (
        <View pointerEvents={layer.control} style={controlsStyle}>{controls}</View>
      )}
    </>
  );
  return (
    <View pointerEvents={layer?.content} style={[listRowContentStyle,
      page ? pageRowContentStyle : props.wrapTitle ? { minHeight: props.height } : { height: props.height },
      // A page row with nothing after it ends on the page row's inset, where a sub-heading's action ends.
      page && props.ownsTrailingInset ? pageRowTrailingStyle : null,
      props.wrapTitle && !page ? (props.ruledInsetPx !== null
        ? ruledStyle
        : (props.ownsTrailingInset ? restingListTrailingStyle : restingListContentStyle)) : null]}>
      {leadingControl === null ? null : (
        <View pointerEvents={layer?.control} style={[glyphStyle, { justifyContent: 'flex-start' }, page ? pageRowGlyphStyle : null]}>
          {leadingControl}
        </View>
      )}
      {glyph === null && badge === null ? null : (
        <View pointerEvents={layer?.leaf} style={[glyphStyle, { justifyContent: 'flex-start' }, page ? pageRowGlyphStyle : null]}>
          {badge === null ? glyph : (
            <View style={glyphWithBadgeStyle}>
              {glyph}
              <GlyphBadgePlate badge={badge} {...(anatomy.testID === undefined ? {} : { testID: `${anatomy.testID(item)}:glyph-badge` })} />
            </View>
          )}
        </View>
      )}
      <View
        pointerEvents={layer?.content}
        style={[flexCellStyle, { gap: page ? 2 : LIST_LINE_GAP }]}
        {...(meta === null ? {} : { onLayout: (event: HappierLayoutChangeEvent) => { placeMeta({ row: event.nativeEvent.layout.width }); } })}
      >
        <View pointerEvents={layer?.leaf} style={props.wrapTitle ? wrappedTitleLineStyle : lineStyle}>
          <HappierText variant="label" tone="neutral" numberOfLines={props.wrapTitle ? 2 : 1}
            style={[titleTextStyle, flexCellStyle, page ? resolveHappierPageTextStyle('rowTitle', typography) : resolveHappierTextStepStyle(HAPPIER_COLLECTION_LIST_TEXT.listRowTitle, typography)]}>
            {anatomy.title(item)}
          </HappierText>
          {metaPlacement === 'inline' && !metaOnRow ? metaCell : null}
          {age === null ? null : (
            <HappierText variant="meta" tone="muted" numberOfLines={1} tabularNumbers>{age}</HappierText>
          )}
        </View>
        {described ? (
          <View pointerEvents={layer?.leaf} style={lineStyle}>
            <HappierText variant="body" tone="muted" numberOfLines={props.wrapTitle ? 2 : 1} style={[flexCellStyle, secondLine ?? null]}>
              {description ?? ''}
            </HappierText>
            {metaPlacement === 'beneath' && !metaOnRow ? metaCell : null}
          </View>
        ) : null}
        <AnimatedView value={props.secondLine.value} tracks={props.secondLine.tracks} style={lineStyle} {...(layer === null ? {} : { pointerEvents: layer.content })}>
          {described ? (
            <View pointerEvents={layer?.content} style={[flexCellStyle, lineStyle]}>{facts(factsLine)}</View>
          ) : (
            <>
              <View pointerEvents={layer?.content} style={[flexCellStyle, lineStyle]}>{facts(where)}</View>
              {layer === null ? <SlotContent value={lineEnd} textStyle={secondLine} /> : (
                <View pointerEvents={layer.leaf} style={controlsStyle}><SlotContent value={lineEnd} textStyle={secondLine} /></View>
              )}
              {metaPlacement !== 'beneath' || metaOnRow ? null : layer === null ? metaCell : <View pointerEvents={layer.leaf}>{metaCell}</View>}
            </>
          )}
        </AnimatedView>
      </View>
      {metaOnRow ? <View pointerEvents={layer?.leaf} style={rowMetaColumnStyle}>{metaCell}</View> : null}
      {props.listColumns.map((field) => (
        <View key={field.key} pointerEvents={layer?.leaf} style={listColumnCellStyle(field, textScale)}
          {...(anatomy.testID === undefined ? {} : { testID: `${anatomy.testID(item)}:column:${field.key}` })}>
          <SlotContent value={field.render(item)} tabular textStyle={secondLine} />
        </View>
      ))}
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
  // A row with nothing to peek (its `peek` returns null) keeps the chevron's place, so its figures stay in their columns.
  const peekSlot = stage.expandable && anatomy.peek !== undefined;
  const peekable = peekSlot && anatomy.peek?.(item) !== null;
  const reducedMotionPeek = useHappierUiAccessibility().reducedMotion;
  const chevron = !peekSlot ? null : peekable ? (
    <HappierPressable
      accessibilityRole="button"
      accessibilityLabel={translate('happier.plugin-ui.collection.peek', 'Peek {title}').replace('{title}', title)}
      expanded={expanded}
      testID={anatomy.testID === undefined ? undefined : `${anatomy.testID(item)}:peek`}
      tabIndex={-1}
      onPress={() => { toggle(itemKey); }}
      style={() => chevronStyle}
    >
      <HappierChevron direction={expanded ? 'up' : 'down'} color={theme.colors.mutedText} size={PEEK_CHEVRON_SIZE} reducedMotion={reducedMotionPeek} />
    </HappierPressable>
  ) : <View aria-hidden style={chevronStyle} />;
  // A collection whose rows carry their own controls reserves that place on every row (the header already does):
  // a row without them keeps its figures under the columns' titles. A resting list has no columns to keep.
  const rowAccessory = actions.accessory === undefined && stage.useRowActions !== undefined && actions.secondaryActions === undefined
    && !stage.wrapTitles
    ? <View aria-hidden style={rowActionPlaceholderStyle} />
    : actions.accessory;
  // One accessory cell in every geometry, even when it is empty beside a detail: a row whose cells come and go
  // would remount its press target, and table and split must keep the same row.
  // The anatomy's action is the list row's trailing action at rest; beside an open detail the list leaves it to the
  // detail (its primary). Its cell stays in every geometry so the row keeps its press target.
  const listAction = anatomy.action === undefined || geometry !== 'list' || stage.composition === 'split' ? null : anatomy.action(item);
  // A resting list (a phone, a narrow page) holds no empty cell: its rows run to the page's margin, and the
  // row's actions overlay its end (`HappierListItem`).
  const accessory = (rowAccessory === undefined && anatomy.peek === undefined && anatomy.action === undefined)
    || (stage.wrapTitles && rowAccessory === undefined && chevron === null && listAction === null) ? null : (
    <View style={lineStyle}>
      {anatomy.action === undefined || geometry !== 'list' || stage.composition === 'split' ? null : <View style={stage.ruledInsetPx === null ? listActionStyle : { marginRight: stage.ruledInsetPx - theme.spacing.medium }}>{listAction}</View>}
      {rowAccessory}{chevron}
    </View>
  );
  const travel = transition?.kind === 'travel' ? transition : null;
  const offset = travel === null ? 0 : travel.plan.offsets.get(itemKey) ?? 0;
  const height = geometry === 'table' ? metrics.tableRow - 2 : metrics.listRow - 2;
  // A nested table row: indented by its depth, its disclosure (pointer only; the row's Right/Left and its
  // treegrid `aria-expanded` are the keyboard and assistive paths) toggling the parent without opening it.
  const treeStage = stage.tree;
  const node = treeStage === null || geometry !== 'table' ? undefined : treeStage.nodes.get(itemKey);
  const branchOpen = node !== undefined && treeStage !== null
    && isHappierCollectionTreeBranchOpen(treeStage.nodes, treeStage.openBranches, itemKey);
  const leading: TreeLeading | null = treeStage === null ? null : {
    width: ((node?.depth ?? 0) + 1) * TABLE.treeIndent,
    content: node === undefined || node.childCount === 0 ? null : (
      <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {/* A pointer target, not a control: it sits inside the row's own press target, which must not nest one. */}
        <Pressable
          focusable={false}
          disabled={node.held}
          {...(anatomy.testID === undefined ? {} : { testID: `${anatomy.testID(item)}:branch` })}
          onPress={(event) => {
            event.stopPropagation();
            treeStage.setBranchOpen(itemKey, !branchOpen);
          }}
          style={branchStyle}
        >
          <HappierDisclosureChevron expanded={branchOpen} color={theme.colors.mutedText} reducedMotion={reducedMotionPeek} />
        </Pressable>
      </View>
    ),
  };
  const treeFacts = useMemo<HappierCollectionTreeRowFacts | null>(() => (node === undefined ? null : {
    level: node.depth + 1,
    ...(node.childCount === 0 ? {} : { expanded: branchOpen }),
    posInSet: node.posInSet,
    setSize: node.setSize,
  }), [branchOpen, node]);
  const rowContents = geometry === 'table' ? (
    <TableCells item={item} columns={stage.columns} height={height} withTitle anatomy={anatomy} leading={leading} />
  ) : (
    <View>
      <ListCells
        item={item}
        anatomy={anatomy}
        height={height}
        secondLine={{ value: progress, tracks: travel === null ? NO_TRACKS : HAPPIER_COLLECTION_TRANSITION_TRACKS.secondLine }}
        AnimatedView={AnimatedView}
        wrapTitle={stage.wrapTitles}
        ruledInsetPx={stage.ruledInsetPx}
        pageSection={stage.pageSections}
        ownsTrailingInset={(stage.pageSections || stage.wrapTitles) && accessory === null}
        listColumns={stage.listColumns}
      />
      {travel === null ? null : (
        // The table's other columns, fading where they stood while the rows travel.
        <AnimatedView value={progress} tracks={HAPPIER_COLLECTION_TRANSITION_TRACKS.columns} style={overlayStyle} pointerEvents="none">
          <TableCells item={item} columns={stage.columns} height={metrics.tableRow - 2} withTitle={false} anatomy={anatomy} leading={leading} />
        </AnimatedView>
      )}
    </View>
  );
  const peekActionId = 'collection.peek';
  const secondaryActions = [
    ...(actions.onSecondaryAction === undefined ? [] : actions.secondaryActions ?? []),
    // The menu is already named for its row ("More actions for …"), so its item is the verb alone.
    ...(peekable ? [{ id: peekActionId, label: translate('happier.plugin-ui.collection.peekAction', 'Peek') }] : []),
  ];
  const onSecondaryAction = (id: string) => {
    if (id === peekActionId) toggle(itemKey);
    else actions.onSecondaryAction?.(id);
  };
  const rowItem: ReactElement<ItemProps> = secondaryActions.length > 0 ? (
    <List.Item
      density="compact"
      showDivider={stage.dividedKeys?.has(itemKey) === true}
      accessibilityLabel={anatomy.accessibilityLabel(item)}
      {...(anatomy.accessibilityHint?.(item) === undefined ? {} : { accessibilityHint: anatomy.accessibilityHint(item) })}
      {...(anatomy.testID === undefined ? {} : { testID: anatomy.testID(item) })}
      {...(actions.busy === undefined ? {} : { busy: actions.busy })}
      {...(actions.accessoryWraps === undefined ? {} : { accessoryWraps: actions.accessoryWraps })}
      {...(accessory === null ? {} : { accessory })}
      {...(hasRowControls(anatomy) ? { contentBesidePressable: true } : {})}
      secondaryActions={secondaryActions}
      onSecondaryAction={onSecondaryAction}
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
      {...(hasRowControls(anatomy) ? { contentBesidePressable: true } : {})}
    >
      {rowContents}
    </List.Item>
  );
  // A mounted row of a virtualized list is on screen; the highlight adds the host's own presentation fact.
  const needsYou = anatomy.needsYou?.(item) ?? null;
  const destinationRow = (
    <HappierCollectionTableRowContext.Provider value={stage.wrapTitles && stage.ruledInsetPx === null ? RESTING_LIST_ROW : RULED_ROW}>
      <HappierCollectionTreeRowContext.Provider value={treeFacts}>
        {renderCollectionItemDestination(host, anatomy, item, rowItem)}
      </HappierCollectionTreeRowContext.Provider>
    </HappierCollectionTableRowContext.Provider>
  );
  return (
    <AnimatedView
      value={progress}
      tracks={travel === null ? NO_TRACKS : happierCollectionTravelTrack(offset)}
      {...(anatomy.testID === undefined ? {} : { testID: `${anatomy.testID(item)}:cell` })}
    >
      {needsYou === null ? null : <CollectionRowNeedsYouHighlight unopened={needsYou.unopened} visible
        {...(anatomy.testID === undefined ? {} : { testID: `${anatomy.testID(item)}:needs-you` })} />}
      {destinationRow}
    </AnimatedView>
  );
}

/** The peek chevron (the shared drawn chevron) turns with the peek at the base step, pointing down closed and up open. */
const PEEK_CHEVRON_SIZE = 14;

/** The place a row's own control (its ⋯ menu) takes; the header reserves it with the gap before it. */
const rowActionPlaceholderStyle: HappierPortableStyle = { width: TABLE.chevronWidth, height: TABLE.chevronWidth };
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
    : cell.kind === 'after' ? <View style={afterRowsStyle}>{cell.content}</View>
      : <CollectionPeek item={cell.item} itemKey={cell.itemKey} />;
}

function renderCollectionCell(cell: CollectionCell<unknown>): ReactElement {
  return <CollectionCellView cell={cell} />;
}

const AFTER_ROWS_CELL_KEY = 'collection-after-rows';
/** The air an answer under the rows stands in, as an empty state stands in the empty pane. */
const afterRowsStyle: HappierPortableStyle = { paddingVertical: 32 };

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
  const metrics = useRowMetrics(anatomy.description !== undefined);
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
  const railSizing = useCollectionRailSizing(props);
  const railLabels = useCollectionRailLabels(props.labels);
  const { layout: geometry, resize: railResize } = useResizableListDetailGeometry({
    ...railSizing,
    availableWidth: size?.width ?? null,
    minListWidth: props.minListWidth,
    minDetailWidth: props.minDetailWidth,
    preferredListRatio: props.preferredListRatio,
    gap: 0,
  });
  const openKey = model.openKey;
  // Choose the container on open and retain it across resizing. A fresh phone open pushes in-page;
  // an already-open app pane fills the viewport without reparenting the detail's local owners.
  const paneHost = useDetailsPaneHostInstalled() && detail === 'auto' && props.renderDetail !== undefined;
  const panePlacement = useDetailsPanePlacement(paneHost && openKey !== null);
  const pane = panePlacement.inPane && paneHost;
  // The table fits where it clears the list minimum AND can still show a column beside the title: a table that
  // is a title column alone is the list with less in it, so there the rows recompose (COLLECTION.md "Phones").
  const rowAccessoryWidth = (anatomy.peek === undefined ? 0 : TABLE.chevronWidth) + (props.useRowActions !== undefined ? 36 : 0);
  // A nested table leads every row with the disclosure slot (an owner's depth); the list draws owners only.
  const tree = presentation === 'table' || presentation === 'list' ? model.tree : null;
  const treeLeadingWidth = tree !== null && presentation === 'table' ? TABLE.treeIndent + TABLE.gap : 0;
  const tableFits = size === null ? null : size.width >= props.minListWidth
    && tableShowsBesideTitle(anatomy, size.width, accessibility.textScale, rowAccessoryWidth, treeLeadingWidth);
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
  const layoutMode = resolveHappierCollectionLayoutState(geometry).mode;
  const publishedComposition: HappierCollectionComposition = rowGeometry === 'table' ? 'table' : composition === 'table' ? 'list' : composition;
  const detailBeside = publishedComposition === 'split';
  const layoutState = useMemo(() => ({ mode: layoutMode, composition: publishedComposition, detailBeside }), [detailBeside, layoutMode, publishedComposition]);

  const wrapTitles = composition === 'list' && transition === null && !besideDetail;
  const restingRows = useContext(HappierCollectionRestingRowsContext);
  const ruledInsetPx = wrapTitles && restingRows !== 'air' ? ruledRowInset(theme, restingRows) : null;
  // A page-section list's `listColumn` fields stand as end columns where the row has room (never on a phone, where the
  // byline carries them); a page table keeps its own bar.
  const columnsShown = pageSections && rowGeometry === 'list'
    && !isHappierPageRowNarrow(size?.width ?? null);
  const listColumns = useMemo((): readonly CollectionField<Item>[] => {
    const declared = columnsShown ? (anatomy.fields ?? NO_FIELDS).filter((field) => field.listColumn === true) : NO_FIELDS;
    return declared.length === 0 ? NO_FIELDS : declared;
  }, [anatomy.fields, columnsShown]);
  // Peeks exist in the resting table; while the table fades out (reduced motion) they stay and fade with it.
  const expandable = rowGeometry === 'table'
    && (transition === null || transition.kind === 'fade')
    && anatomy.peek !== undefined;
  // While the rows travel, an open peek stays as a ghost that fades with the other columns and travels with its
  // row, so it never vanishes at the start of an open (or pops back at the end of a close).
  const ghostPeeks = transition?.kind === 'travel' && anatomy.peek !== undefined;

  // ---- the rows each geometry draws: a nested table its open branches, the list its owners ----
  const openBranches = model.openBranches;
  const nestedTable = tree !== null && rowGeometry === 'table';
  const collapsedGroups = props.collapsedGroups;
  const drawnSections = useMemo<readonly HappierCollectionSection<Item>[]>(() => model.sections.map((section) => {
    if (section.group !== null && collapsedGroups?.has(section.group.key) === true) return { ...section, items: [] };
    return tree === null ? section : {
      ...section,
      items: section.items.filter((item) => (nestedTable
        ? resolveHappierCollectionTreeShown(tree, openBranches, model.keyOf(item))
        : (tree.get(model.keyOf(item))?.depth ?? 0) === 0)),
    };
  }), [collapsedGroups, model.keyOf, model.sections, nestedTable, openBranches, tree]);
  const canPeek = useCallback((key: string) => expandable && drawnSections.some(section =>
    section.items.some(item => model.keyOf(item) === key && anatomy.peek?.(item) != null)),
  [anatomy.peek, drawnSections, expandable, model.keyOf]);

  // ---- the List's cells: rows, and each open peek right below its row (table only) ----
  const expanded = model.expanded;
  const previousCells = useRef<ReadonlyMap<string, CollectionCell<Item>>>(new Map());
  const sections = useMemo(() => {
    const nextCells = new Map<string, CollectionCell<Item>>();
    const retainCell = (cell: CollectionCell<Item>): CollectionCell<Item> => {
      const previous = previousCells.current.get(cell.key);
      // The caller owns item identity. Preserve it through this wrapper so the
      // List's existing PureComponent row sees only its own data changes.
      const retained = previous?.kind === cell.kind && previous.item === cell.item ? previous : cell;
      nextCells.set(cell.key, retained);
      return retained;
    };
    const nextSections = drawnSections.map((section, index): ListSectionData<CollectionCell<Item>> => {
      const data: CollectionCell<Item>[] = [];
      for (const item of section.items) {
        const key = model.keyOf(item);
        data.push(retainCell({ kind: 'item', key, item }));
        if ((expandable || ghostPeeks) && (expanded.has(key) || closingPeeks.has(key))) {
          data.push(retainCell({ kind: 'peek', key: peekCellKey(key), itemKey: key, item }));
        }
      }
      const group = section.group;
      return {
        key: group?.key ?? `collection-${index}`,
        title: group?.title ?? '',
        // A page section names its rows; a dense list's caption band counts them (a nested group every item
        // it holds, open or not, but not the owners shown only to place a match).
        // A collapsed group counts the rows it puts away.
        ...(pageSections ? {} : { count: tree === null ? (model.sections[index]?.items.length ?? section.items.length)
          : (model.sections[index]?.items ?? []).filter((member) => tree.get(model.keyOf(member))?.context !== true).length }),
        ...(group?.description === undefined ? {} : { description: group.description }),
        // Groups that are parts of one page section share its heading and sheet (page sections only).
        ...(group?.section === undefined || !pageSections ? {} : { section: group.section }),
        ...(group !== null && collapsedGroups?.has(group.key) === true ? { collapsed: true } : {}),
        data,
      };
    });
    previousCells.current = nextCells;
    const last = nextSections[nextSections.length - 1];
    if (last !== undefined && props.afterRows != null && props.afterRows !== false) {
      nextSections[nextSections.length - 1] = { ...last, data: [...last.data, { kind: 'after', key: AFTER_ROWS_CELL_KEY, content: props.afterRows }] };
    }
    return nextSections;
  }, [props.afterRows, closingPeeks, collapsedGroups, drawnSections, expandable, expanded, ghostPeeks, model.keyOf, model.sections, pageSections, tree]);
  const dividedKeys = useMemo(() => (pageSections
    ? new Set(drawnSections.flatMap((section) => section.items.slice(0, -1).map(model.keyOf)))
    : null), [drawnSections, model.keyOf, pageSections]);
  const grouped = model.sections.some((section) => section.group !== null && section.group.title !== '');
  // An ungrouped page list (a phone, a narrow page) keeps the table's header recomposed on its sheet: what the rows
  // are on the left, the order they are in on the right (lab `rp` Hp "Started by Happier · Memory ↓").
  const sort = props.sort;
  const sortedField = sort === undefined ? undefined : anatomy.fields?.find((field) => field.key === sort.key);
  const listColumnsHeader = useMemo(() => listColumns.length === 0 ? null : (
    // The list's columns named once, on the first sheet: what the rows are, then each column over its figures.
    <View
      testID={props.testID === undefined ? undefined : `${props.testID}:sheet-header`}
      style={[pageSheetHeaderStyle, listColumnsHeaderStyle, { borderBottomColor: palette?.rowDivider ?? theme.colors.divider }]}
    >
      <View style={pageRowGlyphStyle} />
      <HappierText variant="meta" tone="muted" numberOfLines={1} style={flexTextStyle}>{anatomy.columnTitles.title}</HappierText>
      {listColumns.map((field) => (
        <View key={field.key} style={listColumnCellStyle(field, accessibility.textScale)}>
          <HappierText variant="meta" tone="muted" numberOfLines={1}>{field.title}</HappierText>
        </View>
      ))}
    </View>
  ), [accessibility.textScale, anatomy.columnTitles.title, listColumns, palette?.rowDivider, props.testID, theme.colors.divider]);
  const pageSheetHeader = useMemo(() => listColumnsHeader ?? (!pageSections || grouped || sort === undefined || sortedField === undefined ? null : (
    <View
      testID={props.testID === undefined ? undefined : `${props.testID}:sheet-header`}
      style={[pageSheetHeaderStyle, { borderBottomColor: palette?.rowDivider ?? theme.colors.divider }]}
    >
      <HappierText variant="meta" tone="muted" numberOfLines={1} style={flexTextStyle}>{anatomy.columnTitles.title}</HappierText>
      <CollectionSortHeader
        column={{ key: `field:${sortedField.key}`, title: sortedField.title, minWidth: 0, priority: 0, align: 'end',
          render: null, fieldKey: sortedField.key, sortable: true }}
        fieldKey={sortedField.key}
        sort={sort}
        cellStyle={sheetSortCellStyle}
        {...(props.testID === undefined ? {} : { testID: `${props.testID}:sort:${sortedField.key}` })}
      />
    </View>
  )), [anatomy.columnTitles.title, grouped, listColumnsHeader, pageSections, palette?.rowDivider, props.testID, sort, sortedField, theme.colors.divider]);
  cellsRef.current = useMemo(() => {
    const cells: HappierCollectionTransitionCell[] = [];
    for (const section of sections) {
      if (grouped) {
        // An untitled group (the rows the table's header already names) draws no band of its own.
        const band = section.title === '' ? 0 : metrics.groupHeader;
        cells.push({ key: sectionCellKey(section.key), table: band, list: band, header: true });
      }
      for (const cell of section.data) {
        cells.push(cell.kind === 'item'
          // A nested row stands only in the table: the list beside a detail draws owners only.
          ? { key: cell.key, table: metrics.tableRow, list: (tree?.get(cell.key)?.depth ?? 0) > 0 ? 0 : metrics.listRow }
          : cell.kind === 'after' ? { key: cell.key, table: metrics.tableRow, list: metrics.listRow }
            : { key: cell.key, table: peekHeights.current.get(cell.itemKey) ?? 0, list: 0 });
      }
    }
    return cells;
  }, [grouped, metrics, sections, tree]);

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
    () => resolveColumns(anatomy, tableWidth, accessibility.textScale, rowAccessoryWidth, treeLeadingWidth),
    [accessibility.textScale, anatomy, rowAccessoryWidth, tableWidth, treeLeadingWidth],
  );
  const setBranchOpen = model.actions.setBranchOpen;
  const treeStage = useMemo<CollectionTreeStage | null>(() => (tree === null || presentation !== 'table' ? null
    : { nodes: tree, openBranches, setBranchOpen }), [openBranches, presentation, setBranchOpen, tree]);

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
    tree: treeStage,
    wrapTitles,
    listColumns,
    ruledInsetPx,
    pageSections,
    useRowActions: props.useRowActions,
    expandable,
    dividedKeys,
    onPeekHeight,
    onPeekSettled,
  }), [anatomy, columns, composition, dividedKeys, expandable, expanded, metrics, model.actions.toggleExpanded, treeStage, wrapTitles, listColumns, ruledInsetPx, pageSections, onPeekHeight, onPeekSettled, progress, props.useRowActions, rowGeometry, transition]);

  // ---- the List engine's Collection facts ----
  const authorMultiple: NonNullable<CollectionProps<Item>['selection']>['multiple'] = props.selection?.multiple
    ?? (model.selectionStore === null ? undefined : { store: model.selectionStore });
  if (singleChoice !== undefined && authorMultiple !== undefined) {
    throw new Error('Collection single choice and multiple selection are mutually exclusive');
  }
  const multipleStore = authorMultiple?.store ?? null;
  const multipleSnapshot = useListMultiSelectionStoreSnapshot(multipleStore);
  const navigationKeys = useMemo(() => drawnSections.flatMap(section => section.items)
    .filter(item => props.selection?.isItemActivatable?.(item) !== false && singleChoice?.isItemSelectable?.(item) !== false).map(model.keyOf), [drawnSections, model.keyOf, props.selection?.isItemActivatable, singleChoice?.isItemSelectable]);
  const selectableKeys = useMemo(() => drawnSections.flatMap(section => section.items)
    .filter(item => authorMultiple?.isItemSelectable?.(item) !== false).map(model.keyOf), [authorMultiple?.isItemSelectable, drawnSections, model.keyOf]);
  // Right opens a closed parent or enters an open one; Left closes an open parent or returns to its parent.
  const treeNodes = useMemo<readonly HappierTreeNode[] | null>(() => (!nestedTable || tree === null ? null
    : drawnSections.flatMap(section => section.items).map((item): HappierTreeNode => {
        const key = model.keyOf(item);
        const node = tree.get(key);
        return {
          key,
          parentKey: node?.parentKey ?? null,
          depth: node?.depth ?? 0,
          kind: (node?.childCount ?? 0) > 0 ? 'branch' : 'leaf',
          expanded: isHappierCollectionTreeBranchOpen(tree, openBranches, key),
          // A parent the search holds open cannot close while the narrowing lasts.
          disabled: node?.held === true,
        };
      })), [drawnSections, model.keyOf, nestedTable, openBranches, tree]);
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
      ...(singleChoice === undefined ? { onKey: (key: string, from: string, event: unknown) => {
        if (treeNodes !== null && (key === 'ArrowRight' || key === 'ArrowLeft') && !hasKeyModifier(event)) {
          const intent = resolveHappierTreeKeyIntent(treeNodes, from, key);
          if (intent?.kind === 'focus') model.actions.requestFocus(intent.key);
          else if (intent?.kind === 'disclose') setBranchOpen(intent.key, intent.expanded);
          if (intent !== null) return true;
        }
        const peek = (key === ' ' || key === 'Spacebar') && canPeek(from);
        return model.actions.navigate({ key, from, event, presentation, peek,
          store: multipleStore, eligibleKeys: navigationKeys });
      } } : {}) },
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
      pageSheet: { colors: palette, header: pageSheetHeader, flatSheet: enclosingPageSheet === null },
    } : wrapTitles ? {
      // The resting list (a phone, a narrow page) groups on the page canvas: a plain heading over rows parted by
      // air (lab phone `.grp`), seated on its rows rather than banded off them.
      sectionHeaderTitleRole: 'group' as const,
      sectionHeaderStyle: {
        height: metrics.groupHeader,
        justifyContent: 'flex-end' as const,
        paddingBottom: LIST_LINE_GAP,
        // On the page's edges, with its rows' marks and trailing facts (`restingListContentStyle`); a ruled list
        // keeps its rows' own inset.
        paddingHorizontal: ruledInsetPx ?? 0,
      },
    } : {
      sectionHeaderTitleRole: 'micro' as const,
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
    ...(nestedTable ? { collectionRole: 'treegrid' as const } : {}),
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
  }), [canPeek, driver, expandable, metrics, model, multipleStore, navigationKeys, nestedTable, setBranchOpen, treeNodes, pageScroll, wrapTitles, ruledInsetPx, pageVirtualized, pageGeometry, pageSections, pageSheetHeader, enclosingPageSheet, palette, presentation, progress, props.groupAction, props.testID, scrollOffsetRef, singleChoice === undefined, tabStopKey, theme.colors.divider, theme.colors.elevatedSurface, theme.colors.surface, transition, view.scrollRequest, viewportScrollRequest]);

  // ---- Escape returns to the table from anywhere inside the Collection (web keyboard) ----
  const rootRef = useRef<View | null>(null);
  // A header render places the search in the caller's row, at the toolbar's bounded width; else it stays in the pane.
  const headerPlacesSearch = typeof props.header === 'function';
  const selectionMode = useListSelectionModeControl(multipleStore, selectableKeys.length > 0);
  const pageChrome = useHappierPageChromeInternal();
  // Too narrow for the one toolbar row (a phone, or a list narrowed beside a details pane): the toolbar folds into its
  // two calm rows (`CollectionToolbar`) and the search fills its row, instead of wrapping control by control. Before
  // the first measurement the host's phone header (it shows the title) already says so, so the first frame composes
  // right.
  // The fold width is at least the shared one, and grows to whatever this page's one row really needed: a caller's
  // toolbar reports when its trailing controls wrapped, and the Collection folds at that width from then on, so it
  // never draws two scattered rows and never flips back and forth while the width stays within that need.
  const [toolbarNeedPx, setToolbarNeedPx] = useState(0);
  const [toolbarRowPx, setToolbarRowPx] = useState<number | null>(null);
  const toolbarFit = useMemo<CollectionToolbarFitReport>(() => ({
    width: setToolbarRowPx,
    overflow: (width) => {
      setToolbarRowPx(width);
      setToolbarNeedPx((need) => Math.max(need, Math.ceil(width) + 1));
    },
    shrank: () => setToolbarNeedPx(0),
  }), []);
  const compactToolbar = size === null ? pageChrome?.showsTitle === true
    : size.width < HAPPIER_PAGE_METRICS.toolbarFoldBelowWidthPx || (toolbarRowPx !== null && toolbarRowPx < toolbarNeedPx);
  const search = useListCollectionSearch(props.search, rootRef, compactToolbar);
  const header = typeof props.header === 'function' ? props.header({
    title: props.title === undefined || pageChrome?.showsTitle === true ? null : (
      <HappierText variant="heading" tone="neutral" accessibilityRole="header" numberOfLines={1}>{props.title}</HappierText>
    ),
    search: search.control === null ? null : (
      <View style={[headerSearchStyle, props.search?.width === 'fill' ? fillSearchStyle
        // Phone-narrow it grows into the row beside the toolbar's round buttons, from the same readable basis, so a
        // caller's own wrapping row still gives it a line of its own.
        : compactToolbar ? { flexGrow: 1, flexBasis: HEADER_SEARCH_WIDTH * accessibility.textScale }
          // Wide, it gives way first: from its readable measure down to the narrowest the row allows, so the
          // trailing controls keep the one row (lab a2) instead of wrapping under it and folding the toolbar. A
          // wrapping row breaks its line on each control's own width before anything narrows, so the field's own
          // width is that narrowest: counted at its input's content width, a 1440 Tasks row wrapped with room to spare.
          : props.search?.width === 'fixed' ? { width: HEADER_SEARCH_MIN_WIDTH * accessibility.textScale }
          : { flexGrow: 1, flexBasis: HEADER_SEARCH_MIN_WIDTH * accessibility.textScale,
            width: HEADER_SEARCH_MIN_WIDTH * accessibility.textScale, maxWidth: HEADER_SEARCH_WIDTH * accessibility.textScale }]}>{search.control}</View>
    ),
    selection: selectionMode,
    pageActions: pageChrome?.renderNavigationActions?.(null) ?? null,
  }) : props.header;
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
  // An empty Collection has no row chrome, except the table's named-order control remains reachable.
  const hasRows = model.keys.length > 0;
  // The first window is still arriving: the table already stands (its column titles, its enclosure) so the rows
  // land exactly where their skeleton rows stood.
  const loadingFirstWindow = props.loading === true && !hasRows;
  const cardsWide = composition === 'cards';
  // The key line names `open` and `back`, which only a collection with a detail has. One that opens nothing
  // (`detail: 'none'`), or a collection on another section's sheet (a preview among a page's sections), is read
  // rather than driven: no key hints, only the window line.
  const showHints = (wide || (cardsWide && detail !== 'none' && geometry?.mode === 'split')) && desktop && hasRows
    && detail !== 'none' && enclosingPageSheet === null;
  const transitionTracks = transition?.kind === 'travel' ? HAPPIER_COLLECTION_TRANSITION_TRACKS.columns : NO_TRACKS;
  // The bar above the rows keeps its height in the table and beside a detail, so opening or closing never moves
  // the rows under it: the table's column titles, or an empty rule beside a detail (the lab's list bar). The
  // window's coverage is said once, in the footer, never again in this bar.
  const namedOrderHeader = rowGeometry === 'table' && props.sort?.orders !== undefined;
  // A collection resting as a list has no bar at rest, so it draws none beside a detail either: opening an item
  // never moves its rows.
  const headerBar = (hasRows || loadingFirstWindow || namedOrderHeader) && wide && presentation === 'table';
  const sortableHeader = props.sort !== undefined && (namedOrderHeader || columns.some((column) => column.sortable));
  const columnHeader = !headerBar ? null : rowGeometry === 'list' && transition === null ? (
    <View style={[tableRowContentStyle, { height: TABLE.headerHeight, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }]}>
      <View style={glyphStyle} />
    </View>
  ) : (
    <driver.AnimatedView value={progress} tracks={transitionTracks} style={{ height: TABLE.headerHeight, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
      <View
        // Titles are read from the rows' own names; only sort buttons are controls a reader reaches here.
        {...(sortableHeader ? {} : { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const })}
        style={[tableRowContentStyle, { height: TABLE.headerHeight - 1, paddingRight: TABLE.insetEnd + rowAccessoryWidth + 1 }]}
      >
        {treeStage === null ? null : <View style={{ width: TABLE.treeIndent }} />}
        <View style={glyphStyle} />
        {columns.map((column) => (
          column.key === 'title' && namedOrderHeader && props.sort !== undefined ? (
            <CollectionOrderHeader
              key={column.key}
              column={column as ResolvedColumn<unknown>}
              sort={props.sort}
              {...(props.testID === undefined ? {} : { testID: `${props.testID}:sort:title` })}
            />
          ) : column.sortable && props.sort !== undefined && column.fieldKey !== null ? (
            <CollectionSortHeader
              key={column.key}
              column={column as ResolvedColumn<unknown>}
              fieldKey={column.fieldKey}
              sort={props.sort}
              {...(props.testID === undefined ? {} : { testID: `${props.testID}:sort:${column.fieldKey}` })}
            />
          ) : (
            <View key={column.key} style={cellStyle(column as ResolvedColumn<unknown>)}
              {...(sortableHeader ? { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const } : {})}>
              <HappierText variant="meta" tone={column.key === 'title' ? 'neutral' : 'muted'} numberOfLines={1}>
                {column.title}
              </HappierText>
            </View>
          )
        ))}
      </View>
    </driver.AnimatedView>
  );
  const hint = {
    move: translate('happier.plugin-ui.collection.hint.move', 'move'),
    open: translate('happier.plugin-ui.collection.hint.open', 'open'),
    close: translate('happier.plugin-ui.collection.hint.close', 'close'),
  };
  const focusedPeek = tabStopKey !== null && canPeek(tabStopKey);
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
        // Space is named only for what it does here: select, or the peek this anatomy really has.
        ...(multipleStore !== null && (multipleSnapshot.isSelectionMode || !focusedPeek)
          ? [['space', translate('happier.plugin-ui.collection.hint.select', 'select')]]
          : focusedPeek ? [['space', translate('happier.plugin-ui.collection.hint.peek', 'peek')]] : []),
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
              <HappierText variant="meta" tone="muted">{hint[hint.length - 1]}</HappierText>
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
              {index === 0 ? null : <HappierText variant="meta" tone="muted" aria-hidden>·</HappierText>}
              <HappierText variant="meta" tone="muted" numberOfLines={1} tabularNumbers style={cellTextStyle}>{part}</HappierText>
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
          <HappierText variant="meta" tone="secondary" numberOfLines={1}>{continuation.label}</HappierText>
        </HappierPressable>
      ))}
    </View>
  );

  const summaryRows = props.summaryRows === undefined || props.summaryRows.length === 0 || !hasRows ? null : (
    <CollectionSummaryRows
      rows={props.summaryRows}
      geometry={rowGeometry}
      columns={columns as readonly ResolvedColumn<unknown>[]}
      leadingWidth={treeStage === null ? 0 : TABLE.treeIndent}
      paddingEnd={TABLE.insetEnd + rowAccessoryWidth + 1}
      height={metrics.tableRow}
      fields={anatomy.fields ?? NO_FIELDS}
    />
  );

  // ---- the panes ----
  const headingFocus = useCollectionDetailHeadingFocusInternal(detail === 'none' ? null : openKey);
  // The detail that is leaving stays on screen while it leaves: the caller has already closed it, so its last
  // rendering is kept for exactly the close, and it takes no input.
  const lastDetailRef = useRef<ReactNode>(null);
  // Where the detail is the page (a phone, no pane beside it) the page's toolbar gives way to it, and it leads with
  // the one way back and, given `detailHeader`, the hosted title band: the same header the app pane draws.
  const pushedPage = !pane && composition === 'detail' && detail !== 'none';
  const headerHosted = (pane || pushedPage) && props.detailHeader !== undefined;
  const detailNode = openKey !== null && props.renderDetail !== undefined && detail !== 'none'
    ? <CollectionDetailHeadingFocusContext.Provider value={headerHosted ? null : headingFocus}>
        {props.renderDetail(openKey, { headerHosted, pushed: composition === 'detail' || (pane && !panePlacement.beside) })}
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

  const toolbarHeader = header == null ? header : (
    <CollectionToolbarCompactContext.Provider value={compactToolbar}>
      <CollectionToolbarOverflowContext.Provider value={toolbarFit}>{header}</CollectionToolbarOverflowContext.Provider>
    </CollectionToolbarCompactContext.Provider>
  );

  return (
    <CollectionVirtualizerContext.Provider value={props.virtualizer}>
    <ListMultiSelectionProvider store={multipleStore}>
    <HappierCollectionLayoutContext.Provider value={layoutState}>
      <View ref={rootRef} testID={props.testID} style={rootStyle} onLayout={pageScroll ? onPageViewportLayout : undefined}>
        {/* A page-sized collection scrolls the page's own header and footer with its items. */}
        {pageScroll || pushedPage ? null : toolbarHeader}
        <PageScroller enabled={pageScroll && !pageVirtualized} viewport={viewport} request={viewportScrollRequest}>
        {pageScroll && !pushedPage ? toolbarHeader : null}
        {/* Page sections sit in the page's content column, on the edge of the page header and sections around them. */}
        <PageColumn maxWidthPx={pageSections ? pageChrome?.columnMaxWidthPx : undefined}>
        <View testID={props.testID === undefined ? undefined : `${props.testID}:stage`} onLayout={onLayout}
          style={[pageScroll ? pageStageStyle : rootStyle,
            // A standalone page table has the page sheet edge even when it recomposes as a list.
            // A nested sheet already owns that edge (for example the configurator's size table).
            pageSections || (pageScroll && presentation === 'table' && palette !== null && enclosingPageSheet === null)
              ? { marginHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx } : null,
            // A table among a page's sections is a sheet with an edge; a Collection that IS the page's body (it
            // fills its region under the page header, lab `merged-list`) lies flat and full-bleed.
            pageScroll && composition === 'table' && (hasRows || loadingFirstWindow) ? {
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
              <ListCollectionHeader search={headerPlacesSearch ? null : search.control} selectionMode={headerPlacesSearch ? null : selectionMode}
                {...(pageSections ? { leadingGapPx: HAPPIER_PAGE_METRICS.sectionHeaderGapPx } : {})} />
              {cards && presentation === 'board' && loadingFirstWindow ? (
                // A board that is still reading stands in the same skeleton rows as the table: nothing is
                // known yet about its columns, and "empty" would be a lie.
                <CollectionSkeletonRows
                  theme={theme}
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
                    {...(props.narrowGrid === undefined ? {} : { narrowGrid: props.narrowGrid })}
                    {...(props.groupAction === undefined ? {} : { groupAction: props.groupAction })}
                    {...(props.loading === undefined ? {} : { loading: props.loading })}
                    {...(props.loadingRows === undefined ? {} : { loadingRows: props.loadingRows })}
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
                    empty={loadingFirstWindow ? (
                      <CollectionSkeletonRows
                        theme={theme}
                        rowHeight={rowGeometry === 'table' ? metrics.tableRow : metrics.listRow}
                        twoLines={rowGeometry === 'list'}
                        viewportHeight={viewportHeight}
                        {...(props.loadingRows === undefined ? {} : { rows: props.loadingRows })}
                        {...(ruledInsetPx === null ? {} : { ruledInsetPx })}
                        {...(props.testID === undefined ? {} : { testID: props.testID })}
                      />
                    ) : props.empty}
                    footer={(pageSections || props.footer === undefined) && footerLine === null && summaryRows === null ? undefined : (
                      <>
                        {summaryRows}
                        {pageSections ? null : props.footer}
                        {footerLine}
                      </>
                    )}
                  />
                </ListCollectionControlContext.Provider>
              </CollectionStageContext.Provider>
              )}
            </View>
            {composition === 'split' && !overlayDetail && railResize.canResize ? <HappierResizeHandle
              axis="x" edge="end" labels={{ label: railLabels.resize, hint: railLabels.resizeHint, value: railLabels.resizeValue }}
              testID={props.testID ? `${props.testID}-resize-handle` : undefined}
              interactionProps={Platform.OS === 'web' ? railResize.webHandleProps : railResize.panHandlers}
              accessibilityHandleProps={railResize.accessibilityHandleProps}
              showIndicator={false}
              active={railResize.dragging}
              style={{ position: 'absolute', left: (size?.width ?? 0) * listRatio - 10, top: 0, bottom: 0, width: 10, zIndex: 1000 }}
            /> : null}
            <driver.AnimatedView
              value={progress}
              tracks={detailTracks}
              testID={props.detailTestID}
              pointerEvents={detailLeaving ? 'none' : 'auto'}
              style={[
                paneStyle,
                detailPaneStyle,
                { backgroundColor: (palette ?? resolveHappierUiPalette(theme)).page },
                composition === 'split' || overlayDetail ? { borderLeftWidth: 1, borderLeftColor: theme.colors.divider } : null,
                detailVisible ? null : hiddenStyle,
              ]}
            >
              <HappierCollectionDetailWidthContext.Provider value={composition === 'split' && !overlayDetail && geometry?.mode === 'split' ? geometry.detailWidthPx : null}>
                {pushedPage && openKey !== null ? (
                  <CollectionDetailHeadingFocusContext.Provider value={headerHosted ? headingFocus : null}>
                    <PushedDetailHeader
                      {...(props.detailHeader !== undefined ? props.detailHeader(openKey) : {})}
                      onClose={close}
                      {...(props.detailTestID === undefined ? {} : { testID: props.detailTestID })}
                    />
                  </CollectionDetailHeadingFocusContext.Provider>
                ) : null}
                {pane ? null : props.detailHeader === undefined ? detailNode
                  // Given its identity, the platform draws the detail's title (pushed) and so owns its body's edge, the
                  // same edge as in the details pane; beside the list the author's own header keeps the text edge in it.
                  : <DetailsPaneBody inset>{detailNode}</DetailsPaneBody>}
              </HappierCollectionDetailWidthContext.Provider>
            </driver.AnimatedView>
          </driver.AnimatedView>
        </View>
        </PageColumn>
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

function hasKeyModifier(event: unknown): boolean {
  const modifiers = event !== null && typeof event === 'object'
    ? event as Readonly<{ shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }> : null;
  return modifiers?.shiftKey === true || modifiers?.ctrlKey === true || modifiers?.metaKey === true || modifiers?.altKey === true;
}

/**
 * The title column's named-order menu: the column's own title, quiet like its neighbours, naming the active
 * order and opening the shared menu's radio group (checks, focus and dismissal stay the menu owner's).
 */
function CollectionOrderHeader(props: Readonly<{
  column: ResolvedColumn<unknown>;
  sort: CollectionSort;
  testID?: string;
}>): ReactElement {
  const [open, setOpen] = useState(false);
  const orders = props.sort.orders ?? [];
  const current = orders.find((order) => order.key === props.sort.key);
  const title = props.column.title;
  const radioGroup = 'order';
  return (
    // The title starts where the column's values start (lab "Entry ⌄" over the titles), never centred in a wide cell.
    <View style={[cellStyle(props.column), orderHeaderCellStyle]} aria-sort={current === undefined ? 'none' : props.sort.direction}>
      <Dropdown
        open={open}
        onOpenChange={setOpen}
        trigger={current === undefined ? title : `${title} · ${current.label}`}
        triggerDisclosure
        triggerAccessibilityLabel={current === undefined ? title : `${title}: ${current.label}`}
        {...(props.testID === undefined ? {} : { testID: props.testID })}
        items={orders.map((order) => ({ id: order.key, label: order.label, kind: 'radio' as const, radioGroupId: radioGroup }))}
        radioGroups={[{ id: radioGroup, accessibilityLabel: title, selectedId: current?.key ?? null }]}
        onSelect={props.sort.onChange}
      />
    </View>
  );
}

/** A sortable column title: a button naming the field, its arrow beside the title while it is the active order. */
function CollectionSortHeader(props: Readonly<{
  column: ResolvedColumn<unknown>;
  fieldKey: string;
  sort: CollectionSort;
  testID?: string;
  /** Outside the table's columns (a list's sheet bar) the title keeps its own width. */
  cellStyle?: HappierPortableStyle;
}>): ReactElement {
  const active = props.sort.key === props.fieldKey;
  const onChange = props.sort.onChange;
  const fieldKey = props.fieldKey;
  return (
    <View style={props.cellStyle ?? cellStyle(props.column)} aria-sort={active ? props.sort.direction : 'none'}>
      <HappierPressable
        accessibilityRole="button"
        accessibilityLabel={props.column.title}
        onPress={() => { onChange(fieldKey); }}
        {...(props.testID === undefined ? {} : { testID: props.testID })}
        style={() => sortHeaderStyle}
      >
        <HappierText variant="meta" tone={active ? 'neutral' : 'muted'} numberOfLines={1}>{props.column.title}</HappierText>
        {active ? (
          <HappierText variant="meta" tone="neutral" aria-hidden {...(props.testID === undefined ? {} : { testID: `${props.testID}:arrow` })}>
            {props.sort.direction === 'descending' ? '↓' : '↑'}
          </HappierText>
        ) : null}
      </HappierPressable>
    </View>
  );
}

const sortHeaderStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', gap: 3, minWidth: 0 };
const pageSheetHeaderStyle: HappierPortableStyle = {
  flexDirection: 'row', alignItems: 'center', gap: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
  height: TABLE.headerHeight, paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx, borderBottomWidth: 1,
};
const flexTextStyle: HappierPortableStyle = { flex: 1, minWidth: 0 };
/** The bar over a list's columns keeps the rows' gaps: mark, title, then each column (`pageRowContentStyle`). */
const listColumnsHeaderStyle: HappierPortableStyle = { gap: HAPPIER_PAGE_METRICS.rowLeadingGapPx };

/** A list row's `listColumn` cell and its bar title: one fixed width, so the column lines up down every sheet. */
function listColumnCellStyle<Item>(field: CollectionField<Item>, textScale: number): HappierPortableStyle {
  return { width: field.minWidth * textScale, flexShrink: 0, alignSelf: 'center', alignItems: field.align === 'end' ? 'flex-end' : 'flex-start' };
}
const sheetSortCellStyle: HappierPortableStyle = { flexShrink: 0, alignItems: 'flex-end' };

/**
 * The totals after the last group: in the table, the title under the title column and each cell under its
 * field column (the same widths); in the list, the title left and the highest-priority value right. Plain rows,
 * never focused, selected or opened, a quiet hairline between them.
 */
function CollectionSummaryRows(props: Readonly<{
  rows: readonly CollectionSummaryRow[];
  geometry: 'table' | 'list';
  columns: readonly ResolvedColumn<unknown>[];
  leadingWidth: number;
  paddingEnd: number;
  height: number;
  /** Which field's value the list keeps: the highest priority. */
  fields: readonly Readonly<{ key: string; priority: number }>[];
}>): ReactElement {
  const theme = useHappierUiTheme();
  const palette = useOptionalHappierUiPalette() ?? resolveHappierUiPalette(theme);
  const lead = props.fields.reduce<Readonly<{ key: string; priority: number }> | null>(
    (best, field) => (best === null || field.priority > best.priority ? field : best), null);
  return (
    <View>
      {props.rows.map((row) => (
        <View
          key={row.key}
          {...(row.testID === undefined ? {} : { testID: row.testID })}
          style={[tableRowContentStyle, { minHeight: props.height - 2, borderTopWidth: 1, borderTopColor: palette.rowDivider },
            props.geometry === 'table' ? { paddingRight: props.paddingEnd } : { paddingRight: TABLE.insetStart }]}
        >
          {props.geometry === 'table' ? (
            <>
              {props.leadingWidth === 0 ? null : <View style={{ width: props.leadingWidth }} />}
              <View style={glyphStyle} />
              {props.columns.map((column) => (
                <View
                  key={column.key}
                  style={cellStyle(column)}
                  {...(row.testID === undefined || column.fieldKey === null ? {} : { testID: `${row.testID}:${column.fieldKey}` })}
                >
                  {column.render === null ? <SummaryTitle title={row.title} />
                    : column.fieldKey === null ? null : <SlotContent value={row.cells?.[column.fieldKey]} tabular />}
                </View>
              ))}
            </>
          ) : (
            <>
              <View style={flexCellStyle}><SummaryTitle title={row.title} /></View>
              {lead === null ? null : (
                <View {...(row.testID === undefined ? {} : { testID: `${row.testID}:${lead.key}` })}>
                  <SlotContent value={row.cells?.[lead.key]} tabular />
                </View>
              )}
            </>
          )}
        </View>
      ))}
    </View>
  );
}

function SummaryTitle(props: Readonly<{ title: ReactNode }>): ReactElement | null {
  return typeof props.title === 'string' || typeof props.title === 'number'
    ? <HappierText variant="meta" tone="secondary" numberOfLines={1} style={cellTextStyle}>{String(props.title)}</HappierText>
    : <>{props.title}</>;
}

const NO_FIELDS: readonly never[] = Object.freeze([]);

const rootStyle: HappierPortableStyle = { flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' };
/**
 * The search in a header row (lab `.cmd`): one readable measure at normal text size that scales with the reader's
 * text, narrowing with a tight row and never wider than it, so the page's trailing controls keep their place.
 */
const HEADER_SEARCH_WIDTH = 380;
/** The narrowest a wide header search gives way to before the row folds: lab a2 draws it at about this width. */
const HEADER_SEARCH_MIN_WIDTH = 220;
const headerSearchStyle: HappierPortableStyle = { maxWidth: '100%', minWidth: 0, flexShrink: 1 };
const fillSearchStyle: HappierPortableStyle = { width: '100%' };
/** Inside the page's scroller the stage sizes to its rows instead of filling a fixed height. */
const pageStageStyle: HappierPortableStyle = { minWidth: 0 };
// No `overflow` here: an inline `hidden` would override the scroller's own overflow and stop it scrolling on the web.
const pageScrollerStyle: HappierPortableStyle = { flex: 1, minWidth: 0, minHeight: 0 };
const pageStageRowStyle: HappierPortableStyle = { flexDirection: 'row', minWidth: 0 };

/**
 * The page's one scroller for a page-sized collection. The element is the same in both modes' positions it can
 * take, so switching a Collection's `scroll` is a deliberate remount, never an accidental one.
 */
/** The page's content column (`HappierPageChrome.columnMaxWidthPx`), centred like a List page section; absent, nothing wraps. */
function PageColumn(props: Readonly<{ maxWidthPx: number | undefined; children?: ReactNode }>): ReactElement {
  if (props.maxWidthPx === undefined) return <>{props.children}</>;
  return <View style={{ alignSelf: 'center', width: '100%', maxWidth: props.maxWidthPx }}>{props.children}</View>;
}

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
