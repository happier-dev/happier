import { HAPPIER_RADIUS_V1 } from '../../environment/radius.js';
import type { HappierCollectionLayoutMode } from '../collection/collectionLayout.js';

/** Shared profile band geometry (lab `pphero`) for measured hosts and cold raster adapters. */
export const HAPPIER_PUBLIC_PROFILE_HERO_METRICS = Object.freeze({
  bandHeightPx: Object.freeze({ wide: 420, phone: 300 }),
  avatarPx: Object.freeze({ wide: 84, phone: 64 }),
  /** Paint at 1× and 2×; the selected edition covers the reserved band. */
  rasterWidthPx: Object.freeze({ wide: 1440, phone: 390 }),
  /** Existing owner-preview recomposition threshold. */
  singleColumnBelowWidthPx: 640,
  horizonAt: 0.6,
  /** A paused or unavailable page's quiet horizon (lab `ppstate-X`): a small planet, no picture. */
  quietBandHeightPx: Object.freeze({ wide: 260, phone: 220 }),
});

/**
 * A Rise planet in a profile band (lab `c3hero`): round, its radius from the column rather than Home's
 * pane-wide arc, and its limb high in the band. The identity starts under the band, so the planet fills
 * the sky under the brand bar instead of leaving it empty. App and server paint the band from this.
 */
export function resolveHappierPublicProfilePlanetBand(pane: Readonly<{ width: number; height: number }>):
  Readonly<{ limb: number; radius: number }> {
  const phone = pane.width < HAPPIER_PUBLIC_PROFILE_HERO_METRICS.singleColumnBelowWidthPx;
  return { limb: 0.25 * pane.height, radius: phone ? 0.68 * pane.width : Math.min(0.46 * pane.width, 680) };
}

/** The gap between a row's title and its title-line meta (one owner with the gap the renderers draw). */
export const HAPPIER_ROW_TITLE_META_GAP_PX = 12;

/**
 * The title gives way to its readable minimum before the whole meta moves beneath it.
 * Shared by core Item and Collection; unmeasured input stays inline. Pure geometry
 * lives here so host composition need not initialize native typography to use it.
 */
export function resolveHappierRowTitleMetaPlacement(input: Readonly<{
  rowContentWidthPx: number;
  titleNaturalWidthPx: number;
  metaNaturalWidthPx: number;
  titleMinWidthPx: number;
}>): 'inline' | 'beneath' {
  if (input.rowContentWidthPx <= 0) return 'inline';
  const titleNeeds = Math.min(input.titleNaturalWidthPx, input.titleMinWidthPx);
  return titleNeeds + HAPPIER_ROW_TITLE_META_GAP_PX + input.metaNaturalWidthPx <= input.rowContentWidthPx ? 'inline' : 'beneath';
}

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
   * Page columns, each including its sheets' 16 px inset on both sides: `reading` (sheets 672), `wide`
   * (a grid or a library, sheets 912) and `dashboard` (a dashboard's card grid, cards 1200; Home's widgets,
   * atmosphere lab `.at-wsec`, so the grid reads wider than the composer above it).
   */
  columnMaxWidthPx: Object.freeze({ reading: 704, wide: 944, dashboard: 1232 }),
  /** Centred task dialogs: narrow confirmation, standard task, and a wider form. */
  dialogWidthPx: Object.freeze({ narrow: 360, default: 464, wide: 560 }),
  /** Inside a card or a free-standing group: the row inset, so a card's text lines up with a sheet's rows. */
  cardPaddingPx: 16,
  /** Between cards or tiles in a grid. */
  cardGapPx: 12,
  /** A long reading block inside a sheet (a skill's instructions) shows this much before "Show all". */
  readingClipHeightPx: 420,
  /** Settings lab .page/.detail: 80px; work-document lab: 60px. Pages use the settings measure. */
  pagePaddingBottomPx: 80,
  /**
   * The band a column opens with on a desktop: the session header and a side pane's header, read
   * through `calculateHeaderHeight`. Unified-work lab `.uw-phd` and app-surfaces `.am-pin` (56); the
   * app-surfaces main header `.am-head` (52) is a page title strip, not this band.
   */
  paneHeaderHeightPx: 56,
  /** An iPhone's band (app-surfaces `.phone .am-phn`), the native navigation bar's height. */
  paneHeaderUnderNativeChromeHeightPx: 44,
  controlHeightPx: 32,
  /** The dense control inside a row, card or detail header (settings lab `.btn.sm`): a small button draws this tall. */
  smallControlHeightPx: 28,
  /**
   * A Collection toolbar's row: the inline find capsule (the search field that leads it) is its tallest control,
   * and the host's loading identity for a toolbar page holds the same height so the title does not move.
   */
  collectionToolbarHeightPx: 36,
  /**
   * From the column's edge to a sheet's edge. On every platform Happier's
   * grouped list container padding plus its card margin sum to this.
   */
  sheetInsetPx: 16,
  /**
   * A page beside a collection's list keeps this much between the list's edge and its column, so a page wider
   * than its pane (a `wide` home or account page in a settings detail at 1440) does not hug the list. Store lab
   * `t-providers` stands its sheets 40 px from the divider: this plus `sheetInsetPx`. A column narrower than the
   * pane is centred as before and lands where it did.
   */
  detailSideInsetPx: 24,
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
  /**
   * Across a page header's title row: its leading mark → the title block → the actions. A page that
   * lines content up under the title (a document's chips and steps) reads the title's edge from it.
   */
  pageHeaderColumnGapPx: 14,
  /**
   * A page header's leading mark: a square slot with one stable footprint for the thing the page is
   * about, and the glyph drawn inside it. Core's identity header and a plugin's own header both use it,
   * so the title never moves when a loading page swaps one for the other.
   */
  pageHeaderMarkSlotPx: 44,
  pageHeaderMarkGlyphPx: 28,
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
  /**
   * A row whose leading element is a picture of the thing itself (a window's or a screen's thumbnail,
   * a file's preview) rather than a glyph: a landscape box, so the picture reads at a glance. Computer
   * lab `.cu-prow .th` and the anchored switcher's rows.
   */
  rowLeadingMediaPx: Object.freeze({ width: 56, height: 36 }),
  /** A compact page row: one line in a long index-style list. */
  compactRowPaddingVerticalPx: 9,
  compactRowMinHeightPx: 40,
  /**
   * Below this measured width a two-column composition that is not a row (a
   * banner's actions, a compact pane's centered header, a wide meter)
   * recomposes: a ~200px text column and a ~280px control column still fit side
   * by side with their gutters. A row's own control follows
   * `isHappierPageRowNarrow`, which sizes the control column by a field's
   * inline minimum instead.
   */
  rowStackBelowWidthPx: 520,
  /**
   * Below this width a Collection's one toolbar row (the page's name, a readable search, the lens and filters
   * leading; freshness, Refresh, ⋯, the arrangement switch and the page's Run on trailing) no longer fits, so
   * `CollectionToolbar` folds into its two calm rows instead of wrapping control by control — a list narrowed
   * beside a details pane, a small window, a phone. It is the least fold width: a page whose real controls need more
   * (a long freshness, Run on) reports its wrapped row and `Collection` folds at that measured width instead.
   */
  toolbarFoldBelowWidthPx: 1080,
  /**
   * The narrowest a section title and description may get beside the section's
   * action (the label column above). By default, a compact action ("Cancel", "Add")
   * that leaves more than this on a phone stays on the title's line.
   */
  sectionTextMinWidthPx: 200,
  /**
   * The narrowest a field box gets beside its label; stacked under the label a
   * field spans the row instead (the field box's `inlineMinWidthPx`).
   */
  fieldInlineMinWidthPx: 240,
  /** Between the back arrow in the gutter and the content's left edge. */
  backGutterGapPx: 12,
  /**
   * The room the back arrow needs left of the content's edge to sit in the
   * gutter: the control (a 20px glyph with its 4px sides), the gap to the
   * content, and a margin from the pane's edge.
   */
  backGutterWidthPx: 28 + 12 + 8,
  /** The back control's own box (a 20px glyph with its 4px sides): the height of its line above a title. */
  backControlSizePx: 28,
} as const);

/**
 * The list column of a settings collection beside its detail, by role instead of one number per page,
 * so every collection's rail is the same width unless its rows need more room. `standard` is the
 * one-line row (a name, a glyph and a quiet fact); `detailed` is for rows that carry a description or
 * a facts line of their own. Host-internal: no plugin draws a settings collection's rail.
 */
export const HAPPIER_COLLECTION_RAIL_WIDTH_PX = Object.freeze({
  standard: 272,
  detailed: 320,
} as const);

export type HappierCollectionRailWidth = keyof typeof HAPPIER_COLLECTION_RAIL_WIDTH_PX;

export type HappierPageBackPlacement = 'gutter' | 'above-title';

/**
 * Where a page header's back arrow goes: in the gutter left of the content
 * column when the pane leaves room for it there, otherwise on its own line
 * above the title, so the title, purpose and sections keep one left edge
 * (DESIGN.md "Back stays out of the title"). `null` until the pane has been
 * measured, so the arrow is never drawn in one place and then moved.
 */
export function resolveHappierPageBackPlacement(input: Readonly<{
  paneWidthPx: number | null;
  columnMaxWidthPx: number;
  /** Whether a back control will render at all; a hidden one takes no place (default: it will). */
  backShown?: boolean;
}>): HappierPageBackPlacement | null {
  if (input.backShown === false) return null;
  if (input.paneWidthPx === null || !Number.isFinite(input.paneWidthPx) || input.paneWidthPx <= 0) return null;
  const columnWidthPx = Math.min(input.paneWidthPx, input.columnMaxWidthPx);
  const leadingSpacePx = (input.paneWidthPx - columnWidthPx) / 2 + HAPPIER_PAGE_METRICS.pageTextInsetPx;
  return leadingSpacePx >= HAPPIER_PAGE_METRICS.backGutterWidthPx ? 'gutter' : 'above-title';
}

/**
 * Whether a header still measuring its pane reserves the line above its title. A detail beside a
 * collection's list is narrow by construction and almost always lands there, so where the split has
 * not published the detail's width it reserves the line and never grows when the measurement arrives.
 * Where the width is known the placement is decided from it on the first paint, so nothing is reserved
 * that a wide window then takes back; any other page assumes the gutter, where wide panes land.
 */
export function resolveHappierPageBackMeasuringLine(input: Readonly<{
  /** Whether a back control will render; a page whose back is hidden reserves nothing. */
  backShown: boolean;
  collectionMode: HappierCollectionLayoutMode | null;
  /** The split's published detail width, when it knows it. */
  detailWidthPx: number | null;
}>): boolean {
  return input.backShown && input.collectionMode === 'split' && input.detailWidthPx === null;
}

/**
 * Whether a section's action drops beneath its title and description. Inline
 * and adaptive actions preserve `sectionTextMinWidthPx`; adaptive actions also
 * follow the existing narrow page-control rule. Until the action is measured it
 * follows that rule too, so the first measured paint is never squeezed. A
 * `trailing` action (a quiet icon cluster) never drops. On a narrow (phone)
 * header a labelled action beside a description drops too: next to wrapped
 * explanation lines it reads as part of the text, not the section's action.
 */
export function isHappierSectionActionStacked(input: Readonly<{
  headerWidthPx: number | null;
  actionWidthPx: number | null;
  actionLayout?: 'inline' | 'adaptive' | 'trailing';
  gapPx: number;
  hasDescription?: boolean;
  /**
   * A title-only heading's measured title width (capped at the room it was laid out in). A short title
   * that fits beside the action keeps the action on its line even below the shared label column.
   */
  titleWidthPx?: number | null;
}>): boolean {
  const { headerWidthPx, actionWidthPx } = input;
  // A trailing icon cluster needs no text column of its own: the title beside it shrinks instead.
  if (input.actionLayout === 'trailing') return false;
  if (typeof headerWidthPx !== 'number' || !Number.isFinite(headerWidthPx) || headerWidthPx <= 0) return false;
  if ((input.actionLayout === 'adaptive' || input.hasDescription === true) && isHappierPageRowNarrow(headerWidthPx)) return true;
  if (typeof actionWidthPx !== 'number' || !Number.isFinite(actionWidthPx) || actionWidthPx <= 0) {
    return isHappierPageRowNarrow(headerWidthPx);
  }
  const roomBesideActionPx = headerWidthPx - actionWidthPx - input.gapPx;
  if (roomBesideActionPx >= HAPPIER_PAGE_METRICS.sectionTextMinWidthPx) return false;
  // A title that already fills the room beside the action is wrapping there: it keeps the rule above.
  const titleWidthPx = input.titleWidthPx;
  return !(input.hasDescription !== true && typeof titleWidthPx === 'number' && titleWidthPx > 0
    && titleWidthPx < roomBesideActionPx - 0.5);
}

/**
 * The width a layout event reports when it describes a visible box, else `null`. A retained pane that is
 * hidden (`display: none`, an inactive Activity) reports width 0, which says nothing about the layout it will
 * have when shown: measuring consumers keep their last visible width until a real resize. This is the one
 * owner of that rule, so a consumer cannot forget it and recompose for a phantom zero.
 */
export function readHappierVisibleLayoutWidth(widthPx: number): number | null {
  return Number.isFinite(widthPx) && widthPx > 0 ? widthPx : null;
}

/**
 * Whether a measured row or section header is too narrow for its label and a
 * control side by side: narrower than the label's column
 * (`sectionTextMinWidthPx`), the gap, a field at its inline minimum
 * (`fieldInlineMinWidthPx`) and the row's two insets (484 px). Every phone
 * sheet is; a pane or dialog column that fits all four keeps a select trailing,
 * as on a page. A control wider than its share of a wide row still moves
 * beneath through the row's own measure. `false` before the first
 * measurement, so a wide layout is the first paint.
 */
export function isHappierPageRowNarrow(widthPx: number | null | undefined): boolean {
  return typeof widthPx === 'number' && Number.isFinite(widthPx) && widthPx > 0
    && widthPx < HAPPIER_PAGE_METRICS.sectionTextMinWidthPx + HAPPIER_PAGE_METRICS.rowLeadingGapPx
      + HAPPIER_PAGE_METRICS.fieldInlineMinWidthPx + 2 * HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx;
}

/** The most of a wide row an adaptive control (a segmented bar, a field select) may take beside its label. */
export const HAPPIER_PAGE_ADAPTIVE_ACCESSORY_MAX_ROW_SHARE = 0.5;

/**
 * The one rule for whether a page row's control moves beneath its label, for Happier core's `Item` and
 * the public `Item` alike.
 *
 * - `operation` (a button, a short value): it is the phone rule's "short value". It stays on its label's
 *   line in a narrow row while the label keeps its column (`sectionTextMinWidthPx`), and moves beneath
 *   only when its measured width would squeeze the label below that column.
 * - `adaptive` (a segmented choice, a field select): it moves beneath on a narrow row
 *   ({@link isHappierPageRowNarrow}), except in a menu, which is narrow by design.
 *
 * Either moves beneath when it is wider than its share of a wide row. Unmeasured, a control stays inline,
 * because only the inline position reports its natural width.
 */
export function isHappierPageRowAccessoryStacked(input: Readonly<{
  kind: 'operation' | 'adaptive';
  rowWidthPx: number | null;
  accessoryWidthPx: number | null;
  menuRow?: boolean;
}>): boolean {
  const { rowWidthPx, accessoryWidthPx } = input;
  const measured = rowWidthPx !== null && accessoryWidthPx !== null;
  const overflows = measured && accessoryWidthPx > rowWidthPx * HAPPIER_PAGE_ADAPTIVE_ACCESSORY_MAX_ROW_SHARE;
  if (input.kind === 'operation') {
    return overflows || (measured
      && rowWidthPx - accessoryWidthPx - HAPPIER_PAGE_METRICS.rowLeadingGapPx < HAPPIER_PAGE_METRICS.sectionTextMinWidthPx);
  }
  return overflows || (isHappierPageRowNarrow(rowWidthPx) && input.menuRow !== true);
}
