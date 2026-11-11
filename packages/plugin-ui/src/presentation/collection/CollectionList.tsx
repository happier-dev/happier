import { createContext, memo, useCallback, useContext, useMemo, useRef, useState, type ComponentType, type ReactElement, type ReactNode, type RefObject } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';

import { useHappierPageSection } from '../layout/PageSection.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import { resolveHappierTitleRowInsetPx } from '../layout/shellTitleRow.js';
import { HAPPIER_MENU_ROW_METRICS } from '../interaction/Menu.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { useHappierPrecisePointer } from '../interaction/precisePointer.js';
import { HappierDisclosureChevron } from './DisclosureChevron.js';
import { resolveHappierCollectionTitleAccessoryFits } from './collectionTitleRoom.js';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '../../environment/interactiveTarget.js';
import { HAPPIER_RADIUS_V1 } from '../../environment/radius.js';
import type { HappierPageTextStep } from '../layout/pageText.js';
import { resolveHappierTypeScale, type HappierTypeEmphasis, type HappierTypeRole } from '../text/typeScale.js';
import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import {
  resolveHappierCollectionDraftTitle,
  type HappierCollectionDraftTitleStore,
} from './collectionModel.js';

/**
 * The Collection's `list` presentation (COLLECTION.md §3): the rail of a list + detail Collection
 * (Agents, Providers, Machines, …) and, later, PRs & Issues in split and on phones.
 *
 * It owns the anatomy — the header slot (title with a quiet count, the add control, search once the
 * list needs it, filters only while they have something to filter), the draft row first, labelled
 * groups, one quiet empty line and the end spacing — and its geometry. The host supplies its own
 * text, scroller, search field and theme-bound styles through {@link HappierCollectionListHost}, the
 * way core rows keep their Unistyles entries; nothing here reads a theme.
 */
export type HappierCollectionListTextRole = 'title' | 'count' | 'subtitle' | 'groupTitle' | 'subgroupTitle' | 'groupHeading' | 'groupCount';

export type HappierCollectionRowRole = 'catalogRow' | 'item' | 'menu';

/** Collection bindings decide once from their declared content; preferences keep Item's default. */
export function resolveHappierCollectionRowRole(input: Readonly<{
  rowRole?: HappierCollectionRowRole;
  hasDescription: boolean;
}>): HappierCollectionRowRole {
  return input.rowRole ?? (input.hasDescription ? 'catalogRow' : 'item');
}

export type HappierCollectionListHost = Readonly<{
  /** One line of text in an anatomy role. */
  Text: ComponentType<Readonly<{
    role: HappierCollectionListTextRole;
    numberOfLines?: number;
    accessibilityRole?: 'header';
    testID?: string;
    children: ReactNode;
  }>>;
  /** Scrolls the rows (the host's grouped list surface). */
  Scroller: ComponentType<Readonly<{ style: HappierStyleProp; children: ReactNode }>>;
  /** The host's search field. */
  SearchField: ComponentType<Readonly<{
    value: string;
    onChangeText: (text: string) => void;
    placeholder: string;
    testID?: string;
    /** A control inside the field's well, after the input (the list's filter button). */
    trailing?: ReactNode;
    /** Resolves to the field's drawn frame, the anchor of what opens under it (the filter editor). */
    anchorRef?: RefObject<unknown>;
    /** Focus on mount: only a field the person just opened from its magnifier. */
    autoFocus?: boolean;
    style: HappierStyleProp;
  }>>;
  /**
   * The host's magnifier for a collapsible search (the Sessions header's Search icon). A host without
   * one always shows the field.
   */
  SearchToggle?: ComponentType<Readonly<{ open: boolean; onPress: () => void; accessibilityLabel: string; testID?: string }>>;
  /** The list's own ground (theme-bound). */
  surfaceStyle: HappierStyleProp;
  /**
   * The list's ground read while rendering, for a host whose theme can change under a mounted list (a runtime
   * light/dark switch): a style resolved once at module scope keeps the theme it was first read under on native.
   * A host that provides it provides it on every variant it may switch between, so the hook order holds.
   */
  useSurfaceStyle?: () => HappierStyleProp;
  /**
   * The quiet ink of a group label's own glyphs (its disclosure chevron), read while rendering so it
   * follows the host's theme. A host without one draws no chevron and keeps the label's press.
   */
  useGroupGlyphColor?: () => string;
}>;

export type HappierCollectionListSearch = Readonly<{
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  testID?: string;
  /** The list's filter button, inside the field's well where the list has a search field (lab `sfcols:mcpFilter`). */
  trailing?: ReactNode;
  /** The field's frame, for the filter editor to open under the field's left edge. */
  anchorRef?: RefObject<unknown>;
  /**
   * A titled column keeps its field behind a magnifier in the title row until it is opened (the Sessions
   * header), so the header is one row. A query keeps it open; closing it clears the query.
   */
  collapsible?: boolean;
}>;

export type HappierCollectionListFilters = Readonly<{
  /** How many items the filters act on. Filters with nothing to act on are not shown. */
  targetCount: number;
  content: ReactNode;
}>;

export type HappierCollectionListProps = Readonly<{
  host: HappierCollectionListHost;
  testID?: string;
  /**
   * The list's heading. A list that is the body of a titled surface (a dialog's chooser pane) omits
   * it: the surface already names it, and its search starts at the header's place.
   */
  title?: string;
  /**
   * The title as a control (a saved-space list's "My work ⌄", which opens its spaces and filter). It takes
   * the title's place on the same row and edge; `title` then only names the list for assistive tech.
   */
  titleControl?: ReactNode;
  /** Quiet, tabular count beside the title; omitted while unknown. */
  count?: number | null;
  /**
   * A compact control in the title row, before the header action (a view switch: Definitions | Runs).
   * The title keeps its floor ({@link HAPPIER_COLLECTION_LIST_METRICS.titleFloor}): where the row is
   * too narrow for both, the control yields to the band under the title.
   */
  titleAccessory?: ReactNode;
  /** The add control ("+", or a menu when there is more than one way to add). */
  headerAction?: ReactNode;
  /**
   * One quiet line under the title saying whose list this is and who sees it (a Home's Discussions:
   * "Acme · Only people you invite"), led by an optional 14px glyph.
   */
  subtitle?: Readonly<{ text: string; leading?: ReactNode; testID?: string }> | null;
  /**
   * The band under the header: a saved-space list's spaces strip and the conditions it carries beyond
   * its space. Every list that has spaces puts them here, between the title and search.
   */
  strip?: ReactNode;
  /** Present only when the list is long enough to need it. */
  search?: HappierCollectionListSearch | null;
  filters?: HappierCollectionListFilters | null;
  /**
   * Where the search field and the filters start, from the list's edge. A column keeps its tools' edge
   * ({@link HAPPIER_COLLECTION_LIST_METRICS.toolsInset}); a page that lists under its own title sets the page's
   * gutter, so its tools stand on the same edge as the cards above them (lab `sf-ph390 .top`).
   */
  toolsInsetPx?: number;
  children?: ReactNode;
  /**
   * Rows that own their scrolling (a virtualized list, the host's virtualizer adapter). Replaces the
   * host scroller and `children`, so the list pane has exactly one scroll container.
   */
  scrollContent?: ReactNode;
  /**
   * A row pinned under the scrolling rows (a column's way out to the settings of what it lists). It
   * stays put while the rows scroll, above a hairline.
   */
  footer?: ReactNode;
}>;

/**
 * The phone's list column geometry: the platform that reads the iOS column of `HAPPIER_TYPE_SCALE` (an iPhone
 * or iPad app; a browser on a phone keeps the web column, as the type scale does). Static, because every
 * column style reads it at module scope.
 */
const PHONE_COLUMN = Platform.OS === 'ios';

/** A column header's title row (title, count, the header action's 30px icon buttons). */
const COLUMN_TITLE_ROW_HEIGHT_PX = 36;

/**
 * Geometry of the list anatomy, at normal text scale: the one rhythm owner for every navigation
 * column (the Sessions, Plugins and Settings columns, a list + detail rail, a plugin's
 * `NavigationList`). A column reads its header, group labels and row insets from here, so switching
 * destinations never moves the title, a label or a row's glyph.
 */
export const HAPPIER_COLLECTION_LIST_METRICS = Object.freeze({
  /**
   * The gutter: a row's sheet or pressable (its hover fill and selected chip) sits this far in from the list's
   * edges. With `contentInset` it is the approved column frame (lab `.z-S1`: sheet 10, text 22). On the phone
   * (the iOS column of the type scale) the list shares the page's text edge instead (phone-system lab: 8 / 18).
   */
  rowInset: PHONE_COLUMN ? 8 : 10,
  /**
   * The list's tools (its search field and filters), from its outer edge. In a column they keep the rows' gutter;
   * on the phone a field is a box and stands on the page's box edge, with every sheet and card (phone-system lab:
   * boxes 16, text 18), not on the rows' hover gutter.
   */
  toolsInset: PHONE_COLUMN ? HAPPIER_PAGE_METRICS.sheetInsetPx : 10,
  /**
   * The list's text edge, from its outer edge: the title, every group label and each row's leading
   * glyph start here, so a row's own horizontal padding is `contentInset - rowInset`. On the phone it is the
   * page's `pageTextInsetPx`, so the list, its banners and a Settings page title share one left edge.
   */
  contentInset: PHONE_COLUMN ? HAPPIER_PAGE_METRICS.pageTextInsetPx : 22,
  /** A row: the `md` step of the one radius base. */
  rowRadius: HAPPIER_RADIUS_V1.md,
  /**
   * A navigation row: one line on the compact list step, its glyph in a fixed leading column so
   * titles align whatever the glyph's shape. These are core's compact `Item` values (32 tall on pointer
   * platforms, the lab's dense pointer row (`clflat`, P4 §4.5); glyph box 20 on the web, 18 on iOS; 10 to
   * the title), which core navigation rows draw with. Touch platforms keep their own floor.
   */
  rowMinHeight: 32,
  /**
   * A described row in a column (a Settings rail, a phone's collection page): the navigation row with its
   * description under the title, on the same glyph column, so every row of the column shares one icon axis
   * and one title edge. Its natural height (6 + title 18 + description 16 + 6, lab `sfcols:*`) is also the
   * floor of a title-only peer, so a described column keeps one row pitch (owner, 2026-10-30).
   */
  describedRowMinHeight: 46,
  /**
   * Described catalog records on a page (Store, Add, Installed, a page directory). In a column the same
   * row keeps its content (mark, name, one description line) on the column's geometry instead
   * ({@link describedRowMinHeight}); see {@link useHappierCollectionListRow}.
   */
  catalogRow: Object.freeze({
    minHeight: 60,
    /**
     * The mark's column. On the phone it is the page row's (22 + 14), so a catalog record's title starts on
     * the same edge as every other row of a sheet (68) instead of 76–80 (PHONE-GEOMETRY-1110).
     */
    markBox: PHONE_COLUMN ? HAPPIER_PAGE_METRICS.rowLeadingColumnPx : 32,
    markGap: PHONE_COLUMN ? HAPPIER_PAGE_METRICS.rowLeadingGapPx : 12,
    /**
     * An identity mark drawn in that column (a Team's logo, a person's avatar, a Store item): inside the box
     * on a pointer platform, and overhanging the phone's 22 column evenly, on the glyph axis.
     */
    identityMarkPx: PHONE_COLUMN ? HAPPIER_PAGE_METRICS.rowIdentityMarkPx : 28,
    rowGap: 2,
    /** Air above and below the text block: a two-line row (title 20 + 2 + description 18) lands on the floor. */
    paddingVertical: 10,
    /** The row's hover/selected fill. */
    radius: HAPPIER_RADIUS_V1.md,
    /** A page directory's column: narrower than this, the directory returns to one column. */
    directoryColumnMinWidth: 320,
    /** Air between a page directory's two columns. */
    directoryColumnGap: 40,
  }),
  /** The glyph column; on the phone it is the page row's (22 + 14), so a list glyph and a sheet glyph match. */
  rowGlyphBox: PHONE_COLUMN ? HAPPIER_PAGE_METRICS.rowLeadingColumnPx : 20,
  rowGlyphGap: PHONE_COLUMN ? HAPPIER_PAGE_METRICS.rowLeadingGapPx : 10,
  /** The header's title row (title, count, the header action's 30px icon buttons). */
  titleRowHeight: COLUMN_TITLE_ROW_HEIGHT_PX,
  /** Between the title row's trailing icon buttons (Search, then "+" or "⋯"): one cluster at the row's end. */
  headerActionGap: 2,
  /** The narrowest a column's title gets before a control beside it yields: "My work" and its chevron. */
  titleFloor: 88,
  /**
   * From the column's top edge to the title row: it centres the row on the shell's one title row, level with
   * the rail's first icon and the page title, so the title's top margin matches its left one (`contentInset`).
   */
  headerPaddingTop: resolveHappierTitleRowInsetPx(COLUMN_TITLE_ROW_HEIGHT_PX),
  /** Header → search field, and the field → the first row. */
  headerGap: 4,
  /**
   * Groups part by space alone (lab `clspace`, s24): each group reads as one paragraph, its label tight to
   * its first row. The label's own row is the space it needs above its rows.
   */
  groupGap: 24,
  /** A group label's row: its glyph, title, count, disclosure and hover actions on one line (lab `.ls-h`). */
  groupLabelHeight: 28,
  /** A group label sits this far below what precedes it and this far above its first row. */
  groupLabelPaddingTop: 24,
  groupLabelPaddingBottom: 0,
  /** A label directly under the header needs less air. */
  groupLabelFirstPaddingTop: 4,
  /** The box an identity mark sits in, so names align whatever the mark's shape. */
  markSize: 28,
  troubleDotSize: 6,
  dimmedOpacity: 0.55,
});

/** A list text step from the type scale: the role's metrics on this platform, at its emphasis. */
function collectionTextStep(role: HappierTypeRole, emphasis?: HappierTypeEmphasis): HappierPageTextStep {
  const step = resolveHappierTypeScale(role, Platform.OS, emphasis);
  return {
    weight: step.weight,
    fontSize: step.fontSize,
    lineHeight: step.lineHeight,
    ...(step.letterSpacing === 0 ? {} : { letterSpacing: step.letterSpacing }),
  };
}

/**
 * The list anatomy's type steps (sizes, line heights, weights). Core binds them to its own families
 * and plugin columns take the host's faces for the same weights, so the two draw one type rhythm.
 */
export const HAPPIER_COLLECTION_LIST_TEXT: Readonly<Record<HappierCollectionListTextRole | 'groupTitleTouch' | 'subgroupTitleTouch' | 'rowTitle' | 'rowTitleSelected' | 'listRowTitle', HappierPageTextStep>> = Object.freeze({
  title: collectionTextStep('heading'),
  count: collectionTextStep('body'),
  // The line under the title (whose list, who sees it): the quiet body step.
  subtitle: collectionTextStep('body'),
  // A navigation column's group label is quiet (lab `clflat` `.ls-h`): medium, so the rows under it lead.
  groupTitle: collectionTextStep('meta', 'medium'),
  // On a phone a list is the whole screen, so its group labels are section labels (phone-system lab D4): the
  // heading role, as a Settings section title. Hosts select it with the touch-compact row decision.
  groupTitleTouch: collectionTextStep('heading'),
  // A group inside a group (a Project under "Sessions"): a column draws it as its groups; on a phone it is the
  // label role at regular weight, a step under its section label (phone-system lab D2).
  subgroupTitle: collectionTextStep('meta', 'medium'),
  subgroupTitleTouch: collectionTextStep('label', 'regular'),
  // A group label inside a page section's sheet is a sub-heading between the section title and its
  // rows (the event a set of triggers answers): a step above the rows' description, in the text tone,
  // so it reads as a heading rather than a quiet column label.
  groupHeading: collectionTextStep('body', 'semiBold'),
  groupCount: collectionTextStep('meta'),
  // A navigation row's title: the compact list step, heavier while it is the open row.
  rowTitle: collectionTextStep('body'),
  rowTitleSelected: collectionTextStep('body', 'semiBold'),
  // A Collection's two-line list row title: the row label, a weight up, because it is the row's one anchor over
  // its quiet facts line (lab `.br .x`). The table's single-line title keeps the plain label among its columns.
  listRowTitle: collectionTextStep('label', 'semiBold'),
});

/** Readable rail floor: both insets, an identity mark, a sixteen-character title and a trailing glyph. */
export const COLLECTION_RAIL_MIN_WIDTH_PX = Math.ceil(
  2 * HAPPIER_COLLECTION_LIST_METRICS.contentInset + Math.max(
    HAPPIER_COLLECTION_LIST_METRICS.titleRowHeight + HAPPIER_COLLECTION_LIST_METRICS.headerGap
      + 16 * HAPPIER_COLLECTION_LIST_TEXT.title.fontSize * 0.5,
    Math.max(HAPPIER_COLLECTION_LIST_METRICS.markSize, HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox)
      + HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap
      + 16 * HAPPIER_COLLECTION_LIST_TEXT.rowTitle.fontSize * 0.5
      + HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox,
  ),
);

/**
 * How far a disclosed child row is indented: one step, so the child's own mark starts where its parent's mark
 * ends (the mark's box and its gap). The parent shows its disclosure in place of its mark on hover or focus, so
 * no caret column is reserved (owner 10-31).
 */
export function resolveHappierCollectionTreeChildIndentPx(): number {
  const M = HAPPIER_COLLECTION_LIST_METRICS;
  // Trees live in columns, where every row role draws its mark in the column's glyph box.
  return M.rowGlyphBox + M.rowGlyphGap;
}

/** A row's content inset (its own horizontal padding inside the gutter), plus a disclosure indent. */
export function resolveHappierCollectionListRowPadding(indentPx = 0): Readonly<{ paddingLeft: number; paddingRight: number }> {
  const inset = HAPPIER_COLLECTION_LIST_METRICS.contentInset - HAPPIER_COLLECTION_LIST_METRICS.rowInset;
  return { paddingLeft: inset + indentPx, paddingRight: inset };
}

/**
 * Present inside a {@link HappierCollectionList}: rows drawn by the shared row owner
 * (`HappierListItem`) take the navigation row anatomy — flat on the gutter, the content inset, the
 * plane's selected chip — instead of a sheet row's.
 */
const HappierCollectionListRowContext = createContext(false);

export function useHappierCollectionListRow(): boolean {
  return useContext(HappierCollectionListRowContext);
}

/**
 * Present around a Collection's table or list row: the row draws the dense collection anatomy — full
 * bleed with a hairline under it, the pointer's hover fill and the open row's fill with its leading
 * edge across the whole row (accessory included), so selection never reads as a floating chip and
 * stays distinct from the keyboard focus ring. None of it takes layout: the row keeps the exact
 * height the Collection planned. A resting list (a phone, a narrow page) separates its rows by air instead
 * (`hairline: false`); the fills and edge stay.
 */
export type HappierCollectionTableRowFacts = Readonly<{
  hairline: boolean;
  /**
   * A catalog row in the list beside a detail (lab m:mcp): no hairline; its hover and selection fill sits
   * rowInset in from the list's edges with the catalog row radius, so rows part by air.
   */
  insetFill?: boolean;
  /** The row ends its group and the next group's band follows: the band parts them, so the row draws no hairline. */
  beforeBand?: boolean;
}>;
export const HappierCollectionTableRowContext = createContext<HappierCollectionTableRowFacts | null>(null);

/**
 * How a Collection's resting list (no detail beside it) parts its rows. `air` (default): the page's own edges,
 * rows apart by space, for a phone or a page. `ruled`: the table's own insets and the row hairline, as the list
 * beside an open detail, for a host whose list fills a dialog and keeps one rhythm at rest and beside the detail.
 * `air-page`: rows apart by space with their ends on the page gutter, for that dialog as a phone's full-screen
 * page whose list fills it edge to edge (lab `mp:mcpList`). Host-provided; an author's Collection takes whatever
 * its host presents.
 */
export type HappierCollectionRestingRows = 'air' | 'air-page' | 'ruled';
export const HappierCollectionRestingRowsContext = createContext<HappierCollectionRestingRows>('air');

export function useHappierCollectionTableRow(): HappierCollectionTableRowFacts | null {
  return useContext(HappierCollectionTableRowContext);
}

/** A nested Collection table row's treegrid facts (`aria-level`, its open state, its place among siblings). */
export type HappierCollectionTreeRowFacts = Readonly<{
  level: number;
  /** Omitted for a row without children. */
  expanded?: boolean;
  posInSet: number;
  setSize: number;
}>;

export const HappierCollectionTreeRowContext = createContext<HappierCollectionTreeRowFacts | null>(null);

/**
 * Whether this List row is the one whose detail is open, provided by the List row owner. With a
 * multi-selection store mounted a row's `selected` means "in the bulk set", so the open row needs its own
 * fact to keep its mark (`HappierCollectionTableRowContext`'s edge).
 */
export const HappierListRowOpenContext = createContext(false);

/**
 * The List row right after this one is selected or open, provided by the List row owner (it knows the order and
 * the selection). A selected row's fill parts it from its neighbours, so the hairline between them is not drawn.
 */
export const HappierListRowPrecedesSelectedContext = createContext(false);

/**
 * Set by a card that draws its own selection ring around the row (a Collection grid card). The row then
 * keeps its selection semantics but paints no inset fill: the same fact drawn twice reads as a box in a box.
 */
export const HappierCardSelectionRingContext = createContext(false);

/**
 * Where a Collection grid card's row actions sit: the end of its title line (`top` from the card's edge,
 * `end` from its trailing edge, `height` the title line's). Without it the actions take a cell beside the
 * card's body and centre on it, which puts them between the body's lines. Under a precise pointer the
 * actions show while the card is hovered, focused or its menu is open; on touch they always show.
 */
export const HappierCardActionsCornerContext = createContext<Readonly<{ top: number; end: number; height: number }> | null>(null);

const railStyle: ViewStyle = { flex: 1, minHeight: 0 };
const M = HAPPIER_COLLECTION_LIST_METRICS;
const headerStyle: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  minHeight: M.titleRowHeight,
  marginTop: M.headerPaddingTop,
  paddingLeft: M.contentInset,
  // The header action's squares end on the gutter, so their glyphs sit on the rows' trailing edge.
  paddingRight: M.rowInset,
  marginBottom: M.headerGap,
};
// Several actions (a filter and a "+") sit together at the row's end; the header's space-between would spread them.
const headerActionStyle: ViewStyle = { flexDirection: 'row', alignItems: 'center' };
// The search toggle and the header action are one trailing cluster, so the magnifier never floats mid-row.
const headerTrailingStyle: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: M.headerActionGap, flexShrink: 0 };
const headingStyle: ViewStyle = { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexShrink: 1 };
// With a control beside it the heading takes the row's free width, so its measured width is the title's room.
const headingWithAccessoryStyle: ViewStyle = { flexGrow: 1, flexBasis: 0, minWidth: 0 };
const titleAccessoryStyle: ViewStyle = { marginLeft: 8 };
const TITLE_ACCESSORY_GAP = 8;
// The subtitle shares the title's text edge and closes the header's own gap, so search and the first group
// keep their distance from the header block, not from the title row.
const headerWithSubtitleStyle: ViewStyle = { marginBottom: 0 };
const subtitleStyle: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 6,
  paddingLeft: M.contentInset,
  paddingRight: M.rowInset,
  marginBottom: M.headerGap,
};
const searchStyle: HappierPortableStyle = { marginHorizontal: M.toolsInset, marginBottom: M.headerGap };
const untitledSearchStyle: HappierPortableStyle = { ...searchStyle, marginTop: M.headerPaddingTop };
const filtersStyle: ViewStyle = { marginHorizontal: M.toolsInset, marginBottom: M.headerGap };
// Leading an untitled list (a page under its own header), the view switch keeps the search field's air above it
// rather than touching the header (D12).
const untitledFiltersStyle: ViewStyle = { ...filtersStyle, marginTop: M.headerPaddingTop };
/** The tools' margins: the column's shared constants, or a page's own gutter (stable while it holds). */
function useToolsStyles(insetPx: number | undefined) {
  return useMemo(() => insetPx === undefined
    ? { search: searchStyle, untitledSearch: untitledSearchStyle, filters: filtersStyle, untitledFilters: untitledFiltersStyle }
    : {
      search: { ...searchStyle, marginHorizontal: insetPx },
      untitledSearch: { ...untitledSearchStyle, marginHorizontal: insetPx },
      filters: { ...filtersStyle, marginHorizontal: insetPx },
      untitledFilters: { ...untitledFiltersStyle, marginHorizontal: insetPx },
    }, [insetPx]);
}
// The strip starts on the title's text edge (its first tab under the title's first letter), like Sessions.
const stripStyle: ViewStyle = { paddingLeft: M.contentInset, paddingRight: M.rowInset, marginBottom: M.headerGap };
const stripWithAccessoryStyle: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: TITLE_ACCESSORY_GAP };
const stripLeadStyle: ViewStyle = { flex: 1, minWidth: 0 };
const scrollerStyle: HappierPortableStyle = { paddingTop: 0 };
const footerStyle: ViewStyle = { height: 16 };
const groupLabelRowStyle: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
};
const groupLabelStyle: ViewStyle = {
  ...groupLabelRowStyle,
  minHeight: M.groupLabelHeight,
  marginTop: M.groupLabelPaddingTop,
  paddingLeft: M.contentInset,
  // Hover actions end on the gutter, so their glyphs sit on the rows' trailing text edge.
  paddingRight: M.rowInset,
  paddingBottom: M.groupLabelPaddingBottom,
};
const groupLabelFirstStyle: ViewStyle = { marginTop: M.groupLabelFirstPaddingTop };
// A group inside a group follows its siblings' rows by a group pause, less than a section's (phone-system lab D2).
const groupLabelSubgroupStyle: ViewStyle = { marginTop: HAPPIER_PAGE_METRICS.groupSeparatorGapPx };
const groupLabelMenuStyle: ViewStyle = {
  ...groupLabelRowStyle,
  paddingHorizontal: HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx,
  paddingTop: HAPPIER_MENU_ROW_METRICS.paddingVerticalPx + HAPPIER_MENU_ROW_METRICS.sectionPaddingVerticalPx,
  paddingBottom: HAPPIER_MENU_ROW_METRICS.sectionPaddingVerticalPx,
};
const groupLabelLeadStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0 };
/**
 * A group label's mark (a project's folder) and its gap to the label's text. On the phone the mark takes the
 * rows' glyph column, so the label's text starts on the session rows' title edge (lab `.gl`: 18 / 50) instead of
 * 42 (PHONE-GEOMETRY-1110). The lead's own `gap` is the first part of that gap.
 */
const GROUP_LABEL_MARK_PX = PHONE_COLUMN ? M.rowGlyphBox : 16;
const GROUP_LABEL_MARK_GAP_PX = PHONE_COLUMN ? M.rowGlyphGap : 8;
const groupLabelMarkStyle: ViewStyle = {
  width: GROUP_LABEL_MARK_PX,
  height: 16,
  marginRight: GROUP_LABEL_MARK_GAP_PX - 8,
  alignItems: 'center',
  justifyContent: 'center',
};
// The disclosure's lead: glyph, title, count and chevron are one press target that hugs its content.
const groupLabelDisclosureStyle: HappierPortableStyle = { ...groupLabelLeadStyle, gap: 4, alignSelf: 'stretch' };
// The detail gives up its whole width before the title loses any: shrink is shared by weight × width, and an
// ellipsis appears on any sub-pixel overflow, so a weight of 100 still cut "Chats" to "Ch…" beside a host name.
const groupLabelDetailStyle: ViewStyle = { flexShrink: 100000, minWidth: 0 };
const groupLabelDetailEndStyle: ViewStyle = { flexShrink: 0 };
const groupLabelDisclosureMarkStyle: ViewStyle = { ...groupLabelMarkStyle, marginRight: GROUP_LABEL_MARK_GAP_PX - 4 };
// The free space after the fold control: what its hit area may take on that side.
const GROUP_LABEL_SPACER_MIN_PX = 8;
const groupLabelSpacerStyle: ViewStyle = { flex: 1, minWidth: GROUP_LABEL_SPACER_MIN_PX };
const groupLabelEndCountStyle: ViewStyle = { marginRight: M.contentInset - M.rowInset };
const groupLabelActionsStyle: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: 2 };
const groupLabelActionsHiddenStyle: ViewStyle = { opacity: 0 };
const groupLabelChevronStyle: HappierPortableStyle = { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' };
const markStyle: ViewStyle = {
  width: HAPPIER_COLLECTION_LIST_METRICS.markSize,
  height: HAPPIER_COLLECTION_LIST_METRICS.markSize,
  alignItems: 'center',
  justifyContent: 'center',
};
// In a column a mark takes its own size on the column's glyph box: a glyph drawn at the box lands on the
// column's one axis, and an identity mark larger than it (an avatar) widens its row's leading column from the
// text edge instead of overhanging it.
const columnMarkStyle: ViewStyle = {
  minWidth: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox,
  minHeight: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox,
  alignItems: 'center',
  justifyContent: 'center',
};
const dimmedStyle: ViewStyle = { opacity: HAPPIER_COLLECTION_LIST_METRICS.dimmedOpacity };

/** A row pressable's gutter and soft rounded selection, for the host row's `pressableStyle`. */
export const HAPPIER_COLLECTION_LIST_ROW_STYLE: HappierPortableStyle = Object.freeze({
  marginHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset,
  borderRadius: HAPPIER_COLLECTION_LIST_METRICS.rowRadius,
});

function HappierCollectionListImpl(props: HappierCollectionListProps): ReactElement {
  const { host } = props;
  const { Text, Scroller, SearchField } = host;
  const showFilters = props.filters != null && props.filters.targetCount > 0;
  const tools = useToolsStyles(props.toolsInsetPx);
  const showHeader = props.title !== undefined || props.titleControl != null || props.count != null || props.headerAction != null;
  const hasAccessory = props.titleAccessory != null;
  // The title keeps its floor; the control beside it yields to the band below when the row cannot hold both.
  const [accessoryFits, setAccessoryFits] = useState(true);
  const accessoryWidthRef = useRef<number | null>(null);
  const onHeadingLayout = useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
    const titleWidth = event.nativeEvent.layout.width;
    setAccessoryFits((shown) => resolveHappierCollectionTitleAccessoryFits({
      shown, titleWidth, accessoryWidth: accessoryWidthRef.current, titleFloor: M.titleFloor, gap: TITLE_ACCESSORY_GAP,
    }));
  }, []);
  const onAccessoryLayout = useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
    accessoryWidthRef.current = event.nativeEvent.layout.width;
  }, []);
  const accessoryInRow = hasAccessory && showHeader && accessoryFits;
  const [searchOpened, setSearchOpened] = useState(false);
  const search = props.search ?? null;
  const searchCollapses = search !== null && search.collapsible === true && showHeader && host.SearchToggle !== undefined;
  const searchOpen = !searchCollapses || searchOpened || (search?.value.length ?? 0) > 0;
  const onSearchChange = search?.onChangeText;
  const onToggleSearch = useCallback(() => {
    if (searchOpen) {
      onSearchChange?.('');
      setSearchOpened(false);
    } else {
      setSearchOpened(true);
    }
  }, [onSearchChange, searchOpen]);
  const SearchToggle = host.SearchToggle;
  const surfaceStyle = host.useSurfaceStyle ? host.useSurfaceStyle() : host.surfaceStyle;
  return (
    <HappierCollectionListRowContext.Provider value>
    <View testID={props.testID} style={[railStyle, surfaceStyle]}>
      {showHeader ? (
        <View style={props.subtitle ? [headerStyle, headerWithSubtitleStyle] : headerStyle}>
          <View style={hasAccessory ? [headingStyle, headingWithAccessoryStyle] : headingStyle}
            {...(hasAccessory ? { onLayout: onHeadingLayout } : {})}>
            {props.titleControl != null ? props.titleControl
              : props.title !== undefined ? <Text role="title" accessibilityRole="header">{props.title}</Text> : null}
            {props.count !== undefined && props.count !== null ? (
              <Text role="count">{props.count}</Text>
            ) : null}
          </View>
          {accessoryInRow ? <View style={titleAccessoryStyle} onLayout={onAccessoryLayout}>{props.titleAccessory}</View> : null}
          {(searchCollapses && SearchToggle && search) || props.headerAction != null ? (
            <View style={headerTrailingStyle}>
              {searchCollapses && SearchToggle && search ? (
                <SearchToggle open={searchOpen} onPress={onToggleSearch} accessibilityLabel={search.placeholder}
                  {...(search.testID === undefined ? {} : { testID: `${search.testID}:toggle` })} />
              ) : null}
              {props.headerAction != null ? <View style={headerActionStyle}>{props.headerAction}</View> : null}
            </View>
          ) : null}
        </View>
      ) : null}
      {showHeader && props.subtitle ? (
        <View style={subtitleStyle} {...(props.subtitle.testID === undefined ? {} : { testID: props.subtitle.testID })}>
          {props.subtitle.leading ?? null}
          <Text role="subtitle" numberOfLines={1}>{props.subtitle.text}</Text>
        </View>
      ) : null}
      {/* A control that yielded the title row ends the strip's row, or takes a row of its own without one. */}
      {props.strip != null ? (
        hasAccessory && !accessoryInRow ? (
          <View style={[stripStyle, stripWithAccessoryStyle]}>
            <View style={stripLeadStyle}>{props.strip}</View>
            <View onLayout={onAccessoryLayout}>{props.titleAccessory}</View>
          </View>
        ) : <View style={stripStyle}>{props.strip}</View>
      ) : hasAccessory && !accessoryInRow ? (
        <View style={[stripStyle, stripWithAccessoryStyle]}><View onLayout={onAccessoryLayout}>{props.titleAccessory}</View></View>
      ) : null}
      {props.search && searchOpen ? (
        <SearchField
          value={props.search.value}
          onChangeText={props.search.onChangeText}
          placeholder={props.search.placeholder}
          style={showHeader ? tools.search : tools.untitledSearch}
          {...(props.search.trailing == null ? {} : { trailing: props.search.trailing })}
          {...(props.search.anchorRef === undefined ? {} : { anchorRef: props.search.anchorRef })}
          {...(props.search.testID === undefined ? {} : { testID: props.search.testID })}
          {...(searchCollapses && searchOpened ? { autoFocus: true } : {})}
        />
      ) : null}
      {showFilters ? <View style={showHeader || (props.search && searchOpen) || props.strip ? tools.filters : tools.untitledFilters}>{props.filters!.content}</View> : null}
      {props.scrollContent !== undefined ? props.scrollContent : (
        <Scroller style={[scrollerStyle, surfaceStyle]}>
          {props.children}
          <View style={footerStyle} />
        </Scroller>
      )}
      {props.footer ?? null}
    </View>
    </HappierCollectionListRowContext.Provider>
  );
}

export const HappierCollectionList = memo(HappierCollectionListImpl);

/** A group heading inside the list: what the rows share, and how many there are. */
export function HappierCollectionListGroupLabel(props: Readonly<{
  host: HappierCollectionListHost;
  title: string;
  count?: number;
  /** The first group sits closer to the header (a subgroup: closer to its section's label). */
  first?: boolean;
  /**
   * `subgroup`: a group inside a group (a Project under "Sessions"). It follows the rows before it by a group
   * pause rather than a section gap, and its title is a step quieter than its section's label.
   */
  level?: 'subgroup';
  /** An identity mark before the title (the brand the rows share). */
  mark?: ReactNode;
  /** One short state at the label's end, spoken once for every row it concerns. */
  trailing?: ReactNode;
  /**
   * `menu`: the label heads menu-role rows in a popover or sheet, so it starts on their text edge with the
   * menu's row rhythm above it (the same edge `Menu` group labels use), not on the column's content inset.
   */
  presentation?: 'list' | 'menu';
  /**
   * A disclosure (lab `clgroups`): the label folds its rows. Its glyph, title and count are one press target
   * and the chevron after them turns with the state. Collapsed groups keep the same gap below them.
   */
  disclosure?: Readonly<{
    expanded: boolean;
    onToggle: () => void;
    /**
     * Opens what the group stands for (Needs you → the Inbox) instead of folding it; the chevron becomes the
     * group's own fold control beside it, a separate target with its own name.
     */
    onOpen?: () => void;
    openAccessibilityLabel?: string;
    toggleAccessibilityLabel?: string;
    reducedMotion?: boolean;
    /** Assistive operations on the group itself (move it up or down), from the domain that owns them. */
    accessibilityActions?: readonly Readonly<{ name: string; label?: string }>[];
    onAccessibilityAction?: (event: Readonly<{ nativeEvent: Readonly<{ actionName: string }> }>) => void;
    disabled?: boolean;
  }>;
  /** A nested group's indent, added to the content inset. */
  indentPx?: number;
  /** What the folded rows hold (their strongest state, how many need the person): shown only while collapsed. */
  rollup?: ReactNode;
  /** The group's own operations (New session here, ⋯): revealed while the pointer rests on it, always on touch. */
  actions?: ReactNode;
  /** Keeps the actions showing after the pointer leaves (one of their menus is open). */
  actionsHeld?: boolean;
  /** A quiet fact after the title on the label's line (the machine a group's rows run on). */
  detail?: string;
  /**
   * The end of that fact that tells same-named groups apart (a Machine's short id, "Offline"): it stays whole
   * while a narrow label shortens `detail` first, and follows it after a separator.
   */
  detailEnd?: string;
  /**
   * Where the count sits without a trailing state: `end` (the default) is a settings column's end column;
   * `title` keeps it beside the title ("Drafts 3"), as a navigation column's groups and every disclosure do.
   */
  countPlacement?: 'title' | 'end';
  countTestID?: string;
  testID?: string;
}>): ReactElement {
  const { Text } = props.host;
  const titleRole = props.level === 'subgroup' ? 'subgroupTitle' : 'groupTitle';
  // Inside a page section's sheet the label heads a group of the sheet's rows
  // (`HappierPageSheetGroup`): the sub-heading step, on the rows' inset.
  const pageSection = useHappierPageSection();
  const glyphColor = props.host.useGroupGlyphColor?.();
  const precisePointer = useHappierPrecisePointer();
  const [hovered, setHovered] = useState(false);
  const containerStyle = pageSection
    ? [groupLabelRowStyle, {
        paddingLeft: pageSection.rowInsetPx,
        paddingRight: pageSection.rowInsetPx,
        paddingTop: 0,
        paddingBottom: HAPPIER_PAGE_METRICS.groupHeadingGapPx,
      }]
    : props.presentation === 'menu'
      ? groupLabelMenuStyle
      : [groupLabelStyle, props.level === 'subgroup' ? groupLabelSubgroupStyle : null, props.first ? groupLabelFirstStyle : null,
          props.indentPx ? { paddingLeft: M.contentInset + props.indentPx } : null];
  // The title is the group's name: a long detail (a Machine, "offline") yields its width first.
  const detail = <>
    {props.detail ? <View style={groupLabelDetailStyle}><Text role="groupCount" numberOfLines={1}>{props.detail}</Text></View> : null}
    {props.detailEnd ? <View style={groupLabelDetailEndStyle}><Text role="groupCount" numberOfLines={1}>{props.detail ? `· ${props.detailEnd}` : props.detailEnd}</Text></View> : null}
  </>;
  const disclosure = pageSection || props.presentation === 'menu' ? undefined : props.disclosure;
  if (disclosure) {
    const chevron = glyphColor === undefined ? null : (
      <HappierDisclosureChevron expanded={disclosure.expanded} color={glyphColor} size={12}
        {...(disclosure.reducedMotion === undefined ? {} : { reducedMotion: disclosure.reducedMotion })} />
    );
    const opens = disclosure.onOpen !== undefined;
    // Under a precise pointer the actions come with it; on touch nothing hovers, so they stay.
    const actionsShown = !precisePointer || hovered || props.actionsHeld === true;
    // Siblings, never nested: the lead, the fold control and each action are their own targets.
    return (
      <View
        style={containerStyle}
        accessibilityRole="header"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        {...(props.testID === undefined ? {} : { testID: props.testID })}
      >
        <HappierPressable
          accessibilityRole="button"
          accessibilityLabel={opens ? disclosure.openAccessibilityLabel ?? props.title : props.title}
          {...(opens ? {} : { expanded: disclosure.expanded })}
          onPress={opens ? disclosure.onOpen! : disclosure.onToggle}
          {...(disclosure.accessibilityActions ? { accessibilityActions: disclosure.accessibilityActions } : {})}
          {...(disclosure.onAccessibilityAction ? { onAccessibilityAction: disclosure.onAccessibilityAction } : {})}
          {...(disclosure.disabled ? { disabled: true } : {})}
          style={groupLabelDisclosureStyle}
          {...(props.testID === undefined ? {} : { testID: `${props.testID}:open` })}
        >
          {props.mark !== undefined ? <View style={groupLabelDisclosureMarkStyle}>{props.mark}</View> : null}
          <Text role={titleRole} numberOfLines={1}>{props.title}</Text>
          {detail}
          {props.count !== undefined ? <Text role="groupCount" {...(props.countTestID === undefined ? {} : { testID: props.countTestID })}>{props.count}</Text> : null}
          {opens ? null : chevron}
        </HappierPressable>
        {opens && chevron ? (
          <HappierPressable
            accessibilityRole="button"
            accessibilityLabel={disclosure.toggleAccessibilityLabel ?? props.title}
            expanded={disclosure.expanded}
            onPress={disclosure.onToggle}
            hitTarget={HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE}
            // It abuts the lead (no gap between the two targets): its hit area never reaches back into the lead,
            // and takes the share it cannot use there from the spacer after it (8 + the 16 drawn = the 24 floor).
            hitReach={{ left: 0, right: GROUP_LABEL_SPACER_MIN_PX }}
            style={groupLabelChevronStyle}
            {...(props.testID === undefined ? {} : { testID: `${props.testID}:fold` })}
          >
            {chevron}
          </HappierPressable>
        ) : null}
        <View style={groupLabelSpacerStyle} />
        {disclosure.expanded ? null : props.rollup ?? null}
        {props.actions ? <View style={[groupLabelActionsStyle, actionsShown ? null : groupLabelActionsHiddenStyle]}>{props.actions}</View> : null}
        {props.trailing != null ? <View style={groupLabelEndCountStyle}>{props.trailing}</View> : null}
      </View>
    );
  }
  return (
    <View
      style={containerStyle}
      accessibilityRole="header"
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      <View style={groupLabelLeadStyle}>
        {props.mark !== undefined ? <View style={groupLabelMarkStyle}>{props.mark}</View> : null}
        <Text role={pageSection ? 'groupHeading' : titleRole} numberOfLines={1}>{props.title}</Text>
        {detail}
        {/* With a trailing state the count stays with its title ("Skills 6 … Loaded when used"); alone it is the end column. */}
        {props.count !== undefined && (props.trailing != null || props.countPlacement === 'title') ? <Text role="groupCount" {...(props.countTestID === undefined ? {} : { testID: props.countTestID })}>{props.count}</Text> : null}
      </View>
      {props.count !== undefined && props.trailing == null && props.countPlacement !== 'title' ? (
        // The end column is the rows' trailing text edge, where their counts end; the label's own padding stops
        // at the gutter for its hover actions.
        <View style={pageSection || props.presentation === 'menu' ? null : groupLabelEndCountStyle}>
          <Text role="groupCount" {...(props.countTestID === undefined ? {} : { testID: props.countTestID })}>{props.count}</Text>
        </View>
      ) : null}
      {/* A trailing state or "+" ends on the rows' trailing text edge too, so it shares their one end column. */}
      {props.trailing != null ? <View style={pageSection || props.presentation === 'menu' ? null : groupLabelEndCountStyle}>{props.trailing}</View> : null}
    </View>
  );
}

/** The box a row's identity mark sits in, so names align whatever the mark's shape. */
export function HappierCollectionListMark(props: Readonly<{ children: ReactNode; dimmed?: boolean; rowRole?: HappierCollectionRowRole }>): ReactElement {
  // A page's catalog row draws its mark in the catalog box; in a column every mark sits on the column's box.
  const inColumn = useContext(HappierCollectionListRowContext);
  return <View style={[inColumn ? columnMarkStyle : markStyle, !inColumn && props.rowRole === 'catalogRow'
    ? { width: M.catalogRow.markBox, height: M.catalogRow.markBox } : null, props.dimmed ? dimmedStyle : null]}>{props.children}</View>;
}

/**
 * The draft row's title as typed, or its placeholder until then. It subscribes to the draft store
 * itself, so a keystroke re-renders the draft row and nothing else.
 */
export function useHappierCollectionDraftRowTitle(
  titles: HappierCollectionDraftTitleStore,
  placeholder: string,
): Readonly<{ title: string; untitled: boolean }> {
  return resolveHappierCollectionDraftTitle(titles.useTitle(), placeholder);
}
