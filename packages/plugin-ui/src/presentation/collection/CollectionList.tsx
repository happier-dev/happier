import { createContext, memo, useContext, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';

import { useHappierPageSection } from '../layout/PageSection.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import { HAPPIER_RADIUS_V1 } from '../../environment/radius.js';
import type { HappierPageTextStep } from '../layout/pageText.js';
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
export type HappierCollectionListTextRole = 'title' | 'count' | 'groupTitle' | 'groupHeading' | 'groupCount';

export type HappierCollectionListHost = Readonly<{
  /** One line of text in an anatomy role. */
  Text: ComponentType<Readonly<{
    role: HappierCollectionListTextRole;
    numberOfLines?: number;
    accessibilityRole?: 'header';
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
    style: HappierStyleProp;
  }>>;
  /** The list's own ground (theme-bound). */
  surfaceStyle: HappierStyleProp;
}>;

export type HappierCollectionListSearch = Readonly<{
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  testID?: string;
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
  /** Quiet, tabular count beside the title; omitted while unknown. */
  count?: number | null;
  /** The add control ("+", or a menu when there is more than one way to add). */
  headerAction?: ReactNode;
  /** Present only when the list is long enough to need it. */
  search?: HappierCollectionListSearch | null;
  filters?: HappierCollectionListFilters | null;
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
 * Geometry of the list anatomy, at normal text scale: the one rhythm owner for every navigation
 * column (the Sessions, Plugins and Settings columns, a list + detail rail, a plugin's
 * `NavigationList`). A column reads its header, group labels and row insets from here, so switching
 * destinations never moves the title, a label or a row's glyph.
 */
export const HAPPIER_COLLECTION_LIST_METRICS = Object.freeze({
  /**
   * The gutter: a row's sheet or pressable (its hover fill and selected chip) sits this far in from the list's
   * edges. With `contentInset` it is the approved column frame (lab `.z-S1`: sheet 10, text 22).
   */
  rowInset: 10,
  /**
   * The list's text edge, from its outer edge: the title, every group label and each row's leading
   * glyph start here, so a row's own horizontal padding is `contentInset - rowInset`.
   */
  contentInset: 22,
  /** A row: the `md` step of the one radius base. */
  rowRadius: HAPPIER_RADIUS_V1.md,
  /**
   * A navigation row: one line on the compact list step, its glyph in a fixed leading column so
   * titles align whatever the glyph's shape. These are core's compact `Item` values (36 tall on pointer
   * platforms, the dense row of the spacing rhythm; glyph box 20 on the web, 18 on iOS; 10 to the
   * title), which core navigation rows draw with.
   */
  rowMinHeight: 36,
  rowGlyphBox: Platform.OS === 'ios' ? 18 : 20,
  rowGlyphGap: 10,
  /** The header's title row (title, count, the header action's 30px icon buttons). */
  titleRowHeight: 36,
  /** From the column's top edge to the title row. */
  headerPaddingTop: 12,
  /** Header → search field, and the field → the first row. */
  headerGap: 4,
  /** A group label sits this far below what precedes it and this far above its first row. */
  groupLabelPaddingTop: 14,
  groupLabelPaddingBottom: 6,
  /** A label directly under the header needs less air. */
  groupLabelFirstPaddingTop: 8,
  /** The box an identity mark sits in, so names align whatever the mark's shape. */
  markSize: 28,
  troubleDotSize: 6,
  dimmedOpacity: 0.55,
});

/**
 * The list anatomy's type steps (sizes, line heights, weights). Core binds them to its own families
 * and plugin columns take the host's faces for the same weights, so the two draw one type rhythm.
 */
export const HAPPIER_COLLECTION_LIST_TEXT: Readonly<Record<HappierCollectionListTextRole | 'rowTitle' | 'rowTitleSelected', HappierPageTextStep>> = Object.freeze({
  title: { weight: 'semiBold', fontSize: 15, lineHeight: 20 },
  count: { weight: 'regular', fontSize: 13, lineHeight: 18 },
  groupTitle: { weight: 'semiBold', fontSize: 12, lineHeight: 16 },
  // A group label inside a page section's sheet is a sub-heading between the section title and its
  // rows (the event a set of triggers answers): a step above the rows' description, in the text tone,
  // so it reads as a heading rather than a quiet column label.
  groupHeading: { weight: 'semiBold', fontSize: 13, lineHeight: 18 },
  groupCount: { weight: 'regular', fontSize: 12, lineHeight: 16 },
  // A navigation row's title: the compact list step, heavier while it is the open row.
  rowTitle: { weight: 'regular', fontSize: Platform.OS === 'ios' ? 14 : 13, lineHeight: 18 },
  rowTitleSelected: { weight: 'semiBold', fontSize: Platform.OS === 'ios' ? 14 : 13, lineHeight: 18 },
});

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
 * height the Collection planned.
 */
export const HappierCollectionTableRowContext = createContext(false);

export function useHappierCollectionTableRow(): boolean {
  return useContext(HappierCollectionTableRowContext);
}

/**
 * Whether this List row is the one whose detail is open, provided by the List row owner. With a
 * multi-selection store mounted a row's `selected` means "in the bulk set", so the open row needs its own
 * fact to keep its mark (`HappierCollectionTableRowContext`'s edge).
 */
export const HappierListRowOpenContext = createContext(false);

/** The open row's leading edge in a Collection's table or list (lab `.br.on::before`). */
export const HAPPIER_COLLECTION_SELECTED_EDGE_WIDTH = 2.5;

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
const headingStyle: ViewStyle = { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexShrink: 1 };
const searchStyle: HappierPortableStyle = { marginHorizontal: M.rowInset, marginBottom: M.headerGap };
const untitledSearchStyle: HappierPortableStyle = { ...searchStyle, marginTop: M.headerPaddingTop };
const filtersStyle: ViewStyle = { marginHorizontal: M.rowInset, marginBottom: M.headerGap };
const scrollerStyle: HappierPortableStyle = { paddingTop: 0 };
const footerStyle: ViewStyle = { height: 16 };
const groupLabelRowStyle: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
};
const groupLabelStyle: ViewStyle = {
  ...groupLabelRowStyle,
  paddingHorizontal: M.contentInset,
  paddingTop: M.groupLabelPaddingTop,
  paddingBottom: M.groupLabelPaddingBottom,
};
const groupLabelFirstStyle: ViewStyle = { paddingTop: M.groupLabelFirstPaddingTop };
const groupLabelLeadStyle: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0 };
const groupLabelMarkStyle: ViewStyle = { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' };
const markStyle: ViewStyle = {
  width: HAPPIER_COLLECTION_LIST_METRICS.markSize,
  height: HAPPIER_COLLECTION_LIST_METRICS.markSize,
  alignItems: 'center',
  justifyContent: 'center',
};
const dimmedStyle: ViewStyle = { opacity: HAPPIER_COLLECTION_LIST_METRICS.dimmedOpacity };

/** A row pressable's gutter and soft rounded selection, for the host row's `pressableStyle`. */
export const HAPPIER_COLLECTION_LIST_ROW_STYLE: ViewStyle = Object.freeze({
  marginHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset,
  borderRadius: HAPPIER_COLLECTION_LIST_METRICS.rowRadius,
});

function HappierCollectionListImpl(props: HappierCollectionListProps): ReactElement {
  const { host } = props;
  const { Text, Scroller, SearchField } = host;
  const showFilters = props.filters != null && props.filters.targetCount > 0;
  return (
    <HappierCollectionListRowContext.Provider value>
    <View testID={props.testID} style={[railStyle, host.surfaceStyle]}>
      {props.title !== undefined ? (
        <View style={headerStyle}>
          <View style={headingStyle}>
            <Text role="title" accessibilityRole="header">{props.title}</Text>
            {props.count !== undefined && props.count !== null ? (
              <Text role="count">{props.count}</Text>
            ) : null}
          </View>
          {props.headerAction}
        </View>
      ) : null}
      {props.search ? (
        <SearchField
          value={props.search.value}
          onChangeText={props.search.onChangeText}
          placeholder={props.search.placeholder}
          style={props.title !== undefined ? searchStyle : untitledSearchStyle}
          {...(props.search.testID === undefined ? {} : { testID: props.search.testID })}
        />
      ) : null}
      {showFilters ? <View style={filtersStyle}>{props.filters!.content}</View> : null}
      {props.scrollContent !== undefined ? props.scrollContent : (
        <Scroller style={[scrollerStyle, host.surfaceStyle]}>
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
  /** The first group sits closer to the header. */
  first?: boolean;
  /** An identity mark before the title (the brand the rows share). */
  mark?: ReactNode;
  /** One short state at the label's end, spoken once for every row it concerns. */
  trailing?: ReactNode;
}>): ReactElement {
  const { Text } = props.host;
  // Inside a page section's sheet the label heads a group of the sheet's rows
  // (`HappierPageSheetGroup`): the sub-heading step, on the rows' inset.
  const pageSection = useHappierPageSection();
  return (
    <View
      style={pageSection
        ? [groupLabelRowStyle, {
            paddingLeft: pageSection.rowInsetPx,
            paddingRight: pageSection.rowInsetPx,
            paddingTop: 0,
            paddingBottom: HAPPIER_PAGE_METRICS.groupHeadingGapPx,
          }]
        : [groupLabelStyle, props.first ? groupLabelFirstStyle : null]}
      accessibilityRole="header"
    >
      <View style={groupLabelLeadStyle}>
        {props.mark !== undefined ? <View style={groupLabelMarkStyle}>{props.mark}</View> : null}
        <Text role={pageSection ? 'groupHeading' : 'groupTitle'} numberOfLines={1}>{props.title}</Text>
      </View>
      {props.count !== undefined ? <Text role="groupCount">{props.count}</Text> : null}
      {props.trailing ?? null}
    </View>
  );
}

/** The box a row's identity mark sits in, so names align whatever the mark's shape. */
export function HappierCollectionListMark(props: Readonly<{ children: ReactNode; dimmed?: boolean }>): ReactElement {
  return <View style={[markStyle, props.dimmed ? dimmedStyle : null]}>{props.children}</View>;
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
