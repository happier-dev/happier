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
import { resolveHappierPageTextStyle } from './pageText.js';
import { HappierMaterialSurface, type HappierMaterialSurfaceRender } from './Surface.js';
import type { HappierSurfaceGradient } from './material.js';

/**
 * The shape of a page section's sheet: the page radius and a hairline edge on
 * every side (a page sheet is flat paper — no highlight edge, no shadow).
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

function DefaultSectionText(props: Readonly<{ role: 'sectionTitle' | 'sectionDescription'; text: string }>) {
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
      {props.text}
    </HappierText>
  );
}

const renderDefaultSectionText: HappierPageSectionTextRender = (input) => (
  <DefaultSectionText role={input.role} text={input.text} />
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
  const hasAction = props.action !== null && props.action !== undefined && props.action !== false;
  const handleLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setHeaderWidthPx((current) => (current === next ? current : next));
  }, []);
  const handleActionLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setActionWidthPx((current) => (current === next ? current : next));
  }, []);
  const renderText = props.renderText ?? renderDefaultSectionText;
  const stacked = hasAction && isHappierSectionActionStacked({
    headerWidthPx: headerWidthPx === null ? null : headerWidthPx - props.insetPx * 2,
    actionWidthPx,
    actionLayout: props.actionLayout,
    gapPx: SECTION_ACTION_GAP_PX,
  });
  return (
    <View
      testID={props.testID}
      onLayout={hasAction ? handleLayout : undefined}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'flex-end',
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
        {renderSectionText(props.title, 'sectionTitle', renderText)}
        {renderSectionText(props.description, 'sectionDescription', renderText)}
      </View>
      {hasAction ? <View onLayout={handleActionLayout}>{props.action}</View> : null}
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
}>;

/**
 * Present while rendering the rows of a page section's sheet. A row that reads
 * it takes the page row anatomy (row insets, the page row title and
 * description steps, a full-width hairline divider).
 */
export const HappierPageSectionContext = createContext<HappierPageSection | null>(null);

export function useHappierPageSection(): HappierPageSection | null {
  return useContext(HappierPageSectionContext);
}

type DividerChildProps = Readonly<{ showDivider?: boolean }>;

function flattenSectionRows(children: ReactNode): ReactElement<DividerChildProps>[] {
  const rows: ReactElement<DividerChildProps>[] = [];
  const visit = (node: ReactNode) => {
    Children.forEach(node, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === Fragment) {
        visit((child as ReactElement<{ children?: ReactNode }>).props.children);
        return;
      }
      rows.push(child as ReactElement<DividerChildProps>);
    });
  };
  visit(children);
  return rows;
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

export type HappierPageSheetProps = Readonly<{
  children?: ReactNode;
  /**
   * Sheet and edge colours (Happier core's theme, or the palette). `groupDivider` is the separator
   * between {@link HappierPageSheetGroup}s, lighter than `rowDivider`.
   */
  colors: Readonly<{ sheet: string; sheetBorder: string; rowDivider: string; groupDivider: string }>;
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
 * A page section's body: the rows on one hairline sheet, separated by
 * full-width hairlines, each row taking the page row anatomy. Rows may be
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
      };
  const rowDividerColor = props.colors.rowDivider;
  const rowInsetPx = props.rowInsetPx ?? HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx;
  const section = useMemo(() => ({ rowDividerColor, rowInsetPx }), [rowDividerColor, rowInsetPx]);
  const rowDividers = props.rowDividers !== false;
  const withRowDividers = (rows: ReactNode) => (rowDividers ? withHappierPageSectionDividers(rows) : withoutHappierPageSectionDividers(rows));
  const children = flattenSectionRows(props.children);
  const grouped = children.some(isSheetGroup);
  return (
    <HappierPageSectionContext.Provider value={section}>
      <HappierMaterialSurface testID={props.testID} materialRole={props.surface === 'none' ? undefined : 'content'} gradient={props.surface === 'none' ? null : props.gradient} renderMaterialSurface={props.renderMaterialSurface} style={[sheetStyle, props.style]}>
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
    </HappierPageSectionContext.Provider>
  );
}

function withoutHappierPageSectionDividers(children: ReactNode): ReactNode {
  return flattenSectionRows(children).map((row, index) => cloneElement(row, {
    key: row.key ?? `page-section-row-${index}`,
    showDivider: false,
  } as DividerChildProps & { key: string }));
}
