/**
 * Exact scan-row geometry for the PRs & Issues list.
 *
 * `design/DESIGN-SPEC.md` §2.1 and `core/SURFACE.md` §4.2 require ONE exact
 * height for every row inside a compact-density/text-scale bucket, supplied to
 * the section virtualizer rather than measured per row. That is what makes
 * `getItemLayout`, sticky section headers, focus reveal and a 2,000-row
 * recycling budget honest.
 *
 * This module derives geometry from metrics that are ALREADY scaled. The
 * canonical text-scale owner is `@happier-dev/plugin-ui`'s `Text` presentation
 * (`scaleTextStyleMetrics`), which the surface applies to the host-projected
 * `SurfaceContext.theme.typography` before calling here. Rescaling locally
 * would put a second text-scale decision in the product.
 */

/** One already-scaled text role metric projected from the host theme. */
export type TriageScaledLineMetricsV1 = Readonly<{
  fontSize: number;
  lineHeight: number;
}>;

/** The four text roles the scan row and its section header consume. */
export type TriageScaledTypeMetricsV1 = Readonly<{
  title: TriageScaledLineMetricsV1;
  body: TriageScaledLineMetricsV1;
  caption: TriageScaledLineMetricsV1;
  label: TriageScaledLineMetricsV1;
}>;

export type TriageRowGeometryInputV1 = Readonly<{
  type: TriageScaledTypeMetricsV1;
  spacing: Readonly<{ xsmall: number; small: number; medium: number }>;
  density: 'compact' | 'regular';
  /**
   * The host's resolved minimum interactive target size (44 pt iOS / 48 dp
   * Android through `resolveHappierMinimumInteractiveTargetSize`). Rows are
   * pressable and section headers collapse, so both are interactive targets and
   * this platform contract — not a visual preference — is their height floor.
   */
  minimumInteractiveTargetSize: number;
}>;

export type TriageRowGeometryV1 = Readonly<{
  /** The one exact height every row in this bucket occupies. */
  rowHeight: number;
  /** Section headers carry their own exact geometry (`core/SURFACE.md` §4.2). */
  sectionHeaderHeight: number;
  /**
   * Always `0`. The public `List.Item` owner draws its divider inside the row,
   * so a separator band would double-count height in `getItemLayout`.
   */
  separatorHeight: 0;
  /**
   * Reserved title lines. The design allows at most two; a bucket reserves its
   * whole ceiling so a two-line title cannot clip a row that shares one height.
   */
  titleLineCeiling: 1 | 2;
}>;

const TITLE_LINE_CEILING_BY_DENSITY = {
  compact: 1,
  regular: 2,
} as const satisfies Readonly<Record<TriageRowGeometryInputV1['density'], 1 | 2>>;

export function resolveTriageRowGeometryV1(input: TriageRowGeometryInputV1): TriageRowGeometryV1 {
  const titleLineCeiling = TITLE_LINE_CEILING_BY_DENSITY[input.density];
  const verticalPadding = input.density === 'compact' ? input.spacing.xsmall : input.spacing.small;

  // Title block, the gap the design puts between it and the quiet context line,
  // then the context line itself.
  const rowContentHeight = input.type.title.lineHeight * titleLineCeiling
    + input.spacing.xsmall
    + input.type.caption.lineHeight;
  const sectionHeaderContentHeight = input.type.label.lineHeight + input.spacing.xsmall * 2;

  return Object.freeze({
    rowHeight: exactHeight(rowContentHeight + verticalPadding * 2, input.minimumInteractiveTargetSize),
    sectionHeaderHeight: exactHeight(sectionHeaderContentHeight, input.minimumInteractiveTargetSize),
    separatorHeight: 0,
    titleLineCeiling,
  });
}

/**
 * Integers only: a fractional height accumulates subpixel drift across a
 * 2,000-row `getItemLayout`, which puts sticky headers and keyboard focus
 * reveal off target. Rounding up never clips the reserved content.
 */
function exactHeight(contentHeight: number, minimumInteractiveTargetSize: number): number {
  return Math.ceil(Math.max(contentHeight, minimumInteractiveTargetSize));
}
