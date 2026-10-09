import { HAPPIER_RADIUS_V1 } from '../../environment/radius.js';

/**
 * Geometry of the configuration-page anatomy, for Happier core and plugin pages.
 *
 * The one owner for the measures every page shares — the content column, the
 * title block, the space between sections, the sheet insets and the row insets
 * — so the page title, its purpose line, every section title and every sheet
 * sit on one vertical line on every page, whether the page is one of Happier's
 * own (through `apps/ui`'s `pageListMetrics.ts`) or a plugin page (through the
 * public `PageHeader`, `ItemGroup` and `Item`). A page does not add its own
 * horizontal padding to line something up.
 */
export const HAPPIER_PAGE_METRICS = Object.freeze({
  /**
   * From the column's edge to a sheet's edge. On every platform Happier's
   * grouped list container padding plus its card margin sum to this.
   */
  sheetInsetPx: 16,
  /** Added to the sheet inset so a heading sits just inside the sheet edge, not flush with it. */
  headingOpticalInsetPx: 2,
  /** From the column's edge to the page title, its purpose line and every section title. */
  pageTextInsetPx: 18,
  pageHeaderPaddingTopPx: 32,
  /** The header's top padding when navigation chrome (a native header) already shows the title. */
  pageHeaderUnderChromePaddingTopPx: 12,
  pageHeaderPaddingBottomPx: 4,
  /** Title → purpose line, and purpose → identity details / meta. */
  pageHeaderLineGapPx: 4,
  sectionGapPx: 28,
  sectionHeaderGapPx: 10,
  /** Sheets are cards: the `xl` step of the one radius base. */
  sheetRadiusPx: HAPPIER_RADIUS_V1.xl,
  rowPaddingHorizontalPx: 16,
  /**
   * Above and below the light separator between two groups of a sheet's rows
   * (`HappierPageSheetGroup`): the pause a group edge makes, more than a row
   * edge and less than a section gap.
   */
  groupSeparatorGapPx: 12,
  /** From a group's sub-heading to its first row. */
  groupHeadingGapPx: 6,
  rowPaddingVerticalPx: 14,
  rowMinHeightPx: 52,
  /**
   * A page row's leading column: one icon size in a fixed column, so the titles
   * of a section line up whether a row carries a glyph, an identity mark (which
   * may grow the column) or nothing. The glyph fills the column: beside a title
   * and its description an 18px glyph read as undersized.
   */
  rowIconGlyphPx: 20,
  rowLeadingColumnPx: 20,
  rowLeadingGapPx: 12,
  /** A compact page row: one line in a long index-style list. */
  compactRowPaddingVerticalPx: 9,
  compactRowMinHeightPx: 40,
  /**
   * Below this measured width a row's wide control (segmented choice, visual
   * tiles, a field) — and a section's adaptive action — moves under the label. It is the
   * width at which a ~200px label column and a ~280px control column still fit
   * side by side with their gutters; narrower, the label would wrap word by word.
   */
  rowStackBelowWidthPx: 520,
  /**
   * The narrowest a section title and description may get beside the section's
   * action (the label column above). By default, a compact action ("Cancel", "Add")
   * that leaves more than this on a phone stays on the title's line.
   */
  sectionTextMinWidthPx: 200,
  /** Between the back arrow in the gutter and the content's left edge. */
  backGutterGapPx: 12,
  /**
   * The room the back arrow needs left of the content's edge to sit in the
   * gutter: the control (a 20px glyph with its 4px sides), the gap to the
   * content, and a margin from the pane's edge.
   */
  backGutterWidthPx: 28 + 12 + 8,
} as const);

export type HappierPageBackPlacement = 'gutter' | 'title-row';

/**
 * Where a page header's back arrow goes: in the gutter left of the content
 * column when the pane leaves room for it there, otherwise on the title row.
 * `null` until the pane has been measured, so the arrow is never drawn in one
 * place and then moved.
 */
export function resolveHappierPageBackPlacement(input: Readonly<{
  paneWidthPx: number | null;
  columnMaxWidthPx: number;
}>): HappierPageBackPlacement | null {
  if (input.paneWidthPx === null || !Number.isFinite(input.paneWidthPx) || input.paneWidthPx <= 0) return null;
  const columnWidthPx = Math.min(input.paneWidthPx, input.columnMaxWidthPx);
  const leadingSpacePx = (input.paneWidthPx - columnWidthPx) / 2 + HAPPIER_PAGE_METRICS.pageTextInsetPx;
  return leadingSpacePx >= HAPPIER_PAGE_METRICS.backGutterWidthPx ? 'gutter' : 'title-row';
}

/**
 * Whether a section's action drops beneath its title and description. Every
 * action preserves `sectionTextMinWidthPx`; adaptive actions also follow the
 * existing narrow page-control rule. Until the action is measured it follows
 * that rule too, so the first measured paint is never squeezed.
 */
export function isHappierSectionActionStacked(input: Readonly<{
  headerWidthPx: number | null;
  actionWidthPx: number | null;
  actionLayout?: 'inline' | 'adaptive';
  gapPx: number;
}>): boolean {
  const { headerWidthPx, actionWidthPx } = input;
  if (typeof headerWidthPx !== 'number' || !Number.isFinite(headerWidthPx) || headerWidthPx <= 0) return false;
  if (input.actionLayout === 'adaptive' && isHappierPageRowNarrow(headerWidthPx)) return true;
  if (typeof actionWidthPx !== 'number' || !Number.isFinite(actionWidthPx) || actionWidthPx <= 0) {
    return isHappierPageRowNarrow(headerWidthPx);
  }
  return headerWidthPx - actionWidthPx - input.gapPx < HAPPIER_PAGE_METRICS.sectionTextMinWidthPx;
}

/**
 * Whether a measured row or section header is too narrow for its label and its
 * wide control side by side (see `rowStackBelowWidthPx`). `false` before the
 * first measurement, so a wide layout is the first paint.
 */
export function isHappierPageRowNarrow(widthPx: number | null | undefined): boolean {
  return typeof widthPx === 'number' && Number.isFinite(widthPx) && widthPx > 0
    && widthPx < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx;
}
