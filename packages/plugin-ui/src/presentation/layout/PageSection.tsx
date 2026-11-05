import {
  Children,
  Fragment,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { StyleSheet, View } from 'react-native';

import { useOptionalHappierUiTheme, useOptionalHappierUiTypography } from '../../environment/context.js';
import type { HappierLayoutChangeEvent, HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { HAPPIER_PAGE_METRICS, isHappierSectionActionStacked } from './pageMetrics.js';
import { HAPPIER_PAGE_TEXT, resolveHappierPageTextStyle } from './pageText.js';
import { HappierMaterialSurface, type HappierMaterialSurfaceRender } from './Surface.js';
import type { HappierSurfaceGradient } from './material.js';
import { HappierBodyEdgeContext } from './columnEdge.js';
import { HappierTextActionEdgeContext } from '../interaction/textActionEdge.js';
import { happierRaisedEdgeStyle, type HappierRaisedEdge } from './raisedEdge.js';

/**
 * The shape of a page section's sheet: the page radius and a hairline edge on
 * every side. The host's card edge (`HappierPageSheetColors.sheetEdge`: the lip
 * on one side of that hairline and the card's grounding) is laid over it.
 * Colours are the adapter's: Happier core's theme, or the palette. A function,
 * not a constant, so the platform's hairline is read at render rather than at
 * module load.
 */
export function happierPageSheetShape(): Readonly<{ borderRadius: number; borderWidth: number }> {
  return { borderRadius: HAPPIER_PAGE_METRICS.sheetRadiusPx, borderWidth: StyleSheet.hairlineWidth };
}

/** The hairline between the rows of a page section's sheet. */
export function happierPageRowDividerWidth(): number {
  return StyleSheet.hairlineWidth;
}

/**
 * Where a row's hairline runs (P7-R2, the W3 frames): from the row's text edge — its inset plus, when the
 * row or its section reserves one, the leading column and its gap — to the sheet's trailing edge, so a
 * group separator (content width) still reads lighter than a row seam. Logical start and end, so a
 * right-to-left page mirrors it. Core page rows and the public list rows both take it here.
 */
export function happierPageRowDividerInset(input: Readonly<{
  /** The row's own inset from the sheet's edge (`HappierPageSection.rowInsetPx`). */
  rowInsetPx: number;
  /** The leading column plus its gap before the text, or 0 when the row's text starts at its inset. */
  leadingPx?: number;
}>): Readonly<{ marginStart: number; marginEnd: number }> {
  return { marginStart: input.rowInsetPx + (input.leadingPx ?? 0), marginEnd: 0 };
}

export type HappierPageSectionTextRender = (input: Readonly<{
  role: 'sectionTitle' | 'sectionDescription';
  text: string;
}>) => ReactNode;

export type HappierPageSectionHeaderProps = Readonly<{
  /** A string is drawn in the section-title step; an element is drawn as-is. */
  title?: ReactNode;
  /** What this section is about, read before its rows. */
  description?: ReactNode;
  /** A compact section-level action ("Check now", "Add"), aligned with the title. */
  action?: ReactNode;
  /**
   * `inline` (default) stays beside the text while its minimum label column fits.
   * `adaptive` also moves beneath on narrow page widths, preserving the full explanation column.
   * `trailing` never moves: a quiet icon cluster (ⓘ, +) stays at the title line's end in a narrow
   * pane, and the title gives way.
   */
  actionLayout?: 'inline' | 'adaptive' | 'trailing';
  /**
   * From the section's own edge to its title — the sheet's inset plus the
   * heading's optical inset — so the title sits on the page title's line.
   */
  insetPx: number;
  /** How a string title or description is drawn (Happier core passes its own text owner). */
  renderText?: HappierPageSectionTextRender;
  style?: HappierStyleProp;
  testID?: string;
}>;

/**
 * A section title or description in the page-text step and its ink. The children may be rich: a
 * localized sentence around an inline code chip is set in the same description text.
 */
export function HappierPageSectionText(props: Readonly<{ role: 'sectionTitle' | 'sectionDescription'; children: ReactNode }>) {
  const theme = useOptionalHappierUiTheme();
  const typography = useOptionalHappierUiTypography();
  const title = props.role === 'sectionTitle';
  const color = theme ? (title ? theme.colors.text : theme.colors.secondaryText) : undefined;
  return (
    <HappierText
      accessibilityRole={title ? 'header' : undefined}
      style={[
        resolveHappierPageTextStyle(props.role, typography),
        title ? null : { marginTop: 2 },
        color === undefined ? null : { color },
      ]}
    >
      {props.children}
    </HappierText>
  );
}

const renderDefaultSectionText: HappierPageSectionTextRender = (input) => (
  <HappierPageSectionText role={input.role}>{input.text}</HappierPageSectionText>
);

function renderSectionText(
  slot: ReactNode,
  role: 'sectionTitle' | 'sectionDescription',
  renderText: HappierPageSectionTextRender,
): ReactNode {
  if (slot === null || slot === undefined || slot === false || slot === '') return null;
  if (isValidElement(slot)) return slot;
  return renderText({ role, text: String(slot) });
}

/** Between a section's text and its action. */
const SECTION_ACTION_GAP_PX = 12;


/**
 * A page section's heading: a sentence-case title with its description above
 * the rows, and an optional section action aligned with the title. The action
 * defaults to staying beside the text while the page label column fits
 * (`isHappierSectionActionStacked`). An adaptive action also follows the wide
 * page-control rule on narrow pages, keeping the explanation's full column.
 *
 * Happier core's `ItemGroup` (page presentation) and the public plugin
 * `ItemGroup` both render it.
 */
export function HappierPageSectionHeader(props: HappierPageSectionHeaderProps) {
  const [headerWidthPx, setHeaderWidthPx] = useState<number | null>(null);
  const [actionWidthPx, setActionWidthPx] = useState<number | null>(null);
  const [titleWidthPx, setTitleWidthPx] = useState<number | null>(null);
  const hasAction = props.action !== null && props.action !== undefined && props.action !== false;
  const handleLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setHeaderWidthPx((current) => (current === next ? current : next));
  }, []);
  const handleActionLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setActionWidthPx((current) => (current === next ? current : next));
  }, []);
  const handleTitleLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setTitleWidthPx((current) => (current === next ? current : next));
  }, []);
  const renderText = props.renderText ?? renderDefaultSectionText;
  const hasTitle = props.title !== null && props.title !== undefined && props.title !== false && props.title !== '';
  const stacked = hasAction && isHappierSectionActionStacked({
    headerWidthPx: headerWidthPx === null ? null : headerWidthPx - props.insetPx * 2,
    actionWidthPx,
    actionLayout: props.actionLayout,
    gapPx: SECTION_ACTION_GAP_PX,
    hasDescription: props.description !== null && props.description !== undefined && props.description !== false && props.description !== '',
    titleWidthPx,
  });
  return (
    <View
      testID={props.testID}
      // Always attached: React Native Web decides whether to observe a view only when it mounts, and a
      // section's action can arrive after that (a directory's "+ Add source" once its sources load).
      onLayout={handleLayout}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: SECTION_ACTION_GAP_PX,
          paddingTop: HAPPIER_PAGE_METRICS.sectionGapPx,
          paddingBottom: HAPPIER_PAGE_METRICS.sectionHeaderGapPx,
          paddingHorizontal: props.insetPx,
        },
        stacked ? { flexDirection: 'column', alignItems: 'flex-start', gap: 8 } : null,
        props.style,
      ]}
    >
      <View
        style={stacked
          // In a column `flex: 1` is a zero basis, which would collapse the text under the action.
          ? { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', alignSelf: 'stretch' }
          : { flex: 1, minWidth: 0 }}
      >
        {hasTitle ? (
          // Sized to the title (up to the text column), so a short title is measured at its own width.
          <View onLayout={handleTitleLayout} style={{ alignSelf: 'flex-start', maxWidth: '100%' }}>
            {renderSectionText(props.title, 'sectionTitle', renderText)}
          </View>
        ) : null}
        {renderSectionText(props.description, 'sectionDescription', renderText)}
      </View>
      {hasAction ? (
        <View
          onLayout={handleActionLayout}
          // Beside the text the action is centred on the title's line, so its label reads on the
          // title's line whatever the description below; its own box may reach past that line.
          style={stacked || !hasTitle ? null : { height: HAPPIER_PAGE_TEXT.sectionTitle.lineHeight, justifyContent: 'center' }}
        >
          <HappierTextActionEdgeContext.Provider value={stacked ? 'start' : null}>{props.action}</HappierTextActionEdgeContext.Provider>
        </View>
      ) : null}
    </View>
  );
}

export type HappierPageSection = Readonly<{
  /** The colour of the hairline between rows. */
  rowDividerColor: string;
  /**
   * From the sheet's edge to a row's content, on both sides: the page row inset on a page, or the
   * inset of the list a flat sheet sits in (a pane's rows). Rows, group sub-headings and group
   * separators all start and end here.
   */
  rowInsetPx: number;
  /**
   * The rows sit inside a drawn sheet (edge and fill), not laid flat on the page or a pane. A quiet
   * line that stands in for rows (an empty state, a section's one-line description) then takes a
   * row's vertical room so it doesn't touch the sheet's edge.
   */
  framed?: boolean;
}>;

/**
 * Present while rendering the rows of a page section's sheet. A row that reads
 * it takes the page row anatomy (row insets, the page row title and
 * description steps, a hairline from its text to the sheet's trailing edge).
 */
export const HappierPageSectionContext = createContext<HappierPageSection | null>(null);

export function useHappierPageSection(): HappierPageSection | null {
  return useContext(HappierPageSectionContext);
}

type DividerChildProps = Readonly<{ showDivider?: boolean }>;

function flattenSectionRows(children: ReactNode): ReactElement<DividerChildProps>[] {
  // React's map scopes returned row keys through fragments and retains the original
  // child slots. Packing rows before assigning keys remounts later authors when a
  // conditional status line appears, retiring their drafts and pending Actions.
  return Children.toArray(Children.map(children, (child) => {
    if (!isValidElement(child)) return null;
    return child.type === Fragment
      ? flattenSectionRows((child as ReactElement<{ children?: ReactNode }>).props.children)
      : child;
  })) as ReactElement<DividerChildProps>[];
}

/**
 * Put the page hairline between consecutive rows (never after the last), the
 * way a sheet draws them: each row keeps an explicit `showDivider={false}`.
 */
export function withHappierPageSectionDividers(children: ReactNode): ReactNode {
  const rows = flattenSectionRows(children);
  return rows.map((row, index) => cloneElement(row, {
    key: row.key ?? `page-section-row-${index}`,
    showDivider: index < rows.length - 1 && row.props.showDivider !== false,
  } as DividerChildProps & { key: string }));
}

/**
 * One group of a sheet's rows under an optional sub-heading (the event a set of triggers answers,
 * what a set of rows shares). The sheet draws one separator above every group but the first — lighter
 * than a row hairline and only as wide as the rows' content — so a group edge reads as a pause, not a
 * section edge. Row hairlines stay inside a group; its last row draws none.
 *
 * Only meaningful as a direct child (or inside a fragment) of {@link HappierPageSheet}; the header
 * is usually a `HappierCollectionListGroupLabel`, which takes the sub-heading step inside a sheet.
 */
export function HappierPageSheetGroup(props: HappierPageSheetGroupProps): ReactElement {
  return (
    <View testID={props.testID}>
      {props.header ?? null}
      {props.children}
    </View>
  );
}

export type HappierPageSheetGroupProps = Readonly<{
  /** The group's sub-heading, drawn before its rows. */
  header?: ReactNode;
  children?: ReactNode;
  testID?: string;
}>;

function isSheetGroup(element: ReactElement): element is ReactElement<HappierPageSheetGroupProps> {
  return element.type === HappierPageSheetGroup;
}

/**
 * Sheet and edge colours (Happier core's theme, or the palette). `groupDivider` is the separator between
 * {@link HappierPageSheetGroup}s, lighter than `rowDivider`; `sheetEdge` is the host's card lip and grounding.
 */
export type HappierPageSheetColors = Readonly<{
  sheet: string;
  sheetBorder: string;
  sheetEdge?: HappierRaisedEdge;
  rowDivider: string;
  groupDivider: string;
}>;

export type HappierPageSheetProps = Readonly<{
  children?: ReactNode;
  colors: HappierPageSheetColors;
  gradient?: HappierSurfaceGradient | null;
  renderMaterialSurface?: HappierMaterialSurfaceRender;
  /** `none` lays the rows on the page with the same insets and no sheet. */
  surface?: 'sheet' | 'none';
  /**
   * From the sheet's edge to its rows' content, on both sides. Omitted, the page row inset. A flat
   * sheet in a pane passes the pane list's own inset, so its rows line up with the list's rows.
   */
  rowInsetPx?: number;
  /**
   * `false` draws no hairline between rows: space, sub-headings and group separators carry the
   * structure (a flat sheet, where a lone rule between two rows reads as a stray line).
   */
  rowDividers?: boolean;
  style?: HappierStyleProp;
  testID?: string;
}>;

/**
 * A page section's body: the rows on one sheet, separated by hairlines that
 * run from the rows' text to the sheet's trailing edge, each row taking the page row anatomy. Rows may be
 * grouped ({@link HappierPageSheetGroup}); a light, content-width separator
 * then sits between groups.
 */
export function HappierPageSheet(props: HappierPageSheetProps) {
  const sheetStyle: HappierPortableStyle | null = props.surface === 'none'
    ? null
    : {
        ...happierPageSheetShape(),
        borderColor: props.colors.sheetBorder,
        backgroundColor: props.colors.sheet,
        ...happierRaisedEdgeStyle(props.colors.sheetEdge),
      };
  const rowDividerColor = props.colors.rowDivider;
  const rowInsetPx = props.rowInsetPx ?? HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx;
  const framed = props.surface !== 'none';
  const section = useMemo(() => ({ rowDividerColor, rowInsetPx, framed }), [framed, rowDividerColor, rowInsetPx]);
  const rowDividers = props.rowDividers !== false;
  const withRowDividers = (rows: ReactNode) => (rowDividers ? withHappierPageSectionDividers(rows) : withoutHappierPageSectionDividers(rows));
  const children = flattenSectionRows(props.children);
  const grouped = children.some(isSheetGroup);
  return (
    <HappierPageSectionContext.Provider value={section}>
      {/* A sheet inside a widget body draws its rows' own edge again. */}
      <HappierBodyEdgeContext.Provider value={false}>
      <HappierMaterialSurface testID={props.testID} materialRole={props.surface === 'none' ? undefined : 'card'} gradient={props.surface === 'none' ? null : props.gradient} renderMaterialSurface={props.renderMaterialSurface} style={[sheetStyle, props.style]}>
        {grouped
          ? children.map((child, index) => (isSheetGroup(child) ? (
              <Fragment key={child.key ?? `page-sheet-group-${index}`}>
                {index > 0 ? (
                  <View
                    role="separator"
                    style={{
                      height: happierPageRowDividerWidth(),
                      backgroundColor: props.colors.groupDivider,
                      marginLeft: rowInsetPx,
                      marginRight: rowInsetPx,
                      marginTop: HAPPIER_PAGE_METRICS.groupSeparatorGapPx,
                      marginBottom: HAPPIER_PAGE_METRICS.groupSeparatorGapPx,
                    }}
                  />
                ) : null}
                {cloneElement(child, { children: withRowDividers(child.props.children) })}
              </Fragment>
            ) : cloneElement(child, { key: child.key ?? `page-sheet-row-${index}`, showDivider: false } as DividerChildProps & { key: string })))
          : withRowDividers(children)}
      </HappierMaterialSurface>
      </HappierBodyEdgeContext.Provider>
    </HappierPageSectionContext.Provider>
  );
}

function withoutHappierPageSectionDividers(children: ReactNode): ReactNode {
  return flattenSectionRows(children).map((row, index) => cloneElement(row, {
    key: row.key ?? `page-section-row-${index}`,
    showDivider: false,
  } as DividerChildProps & { key: string }));
}
