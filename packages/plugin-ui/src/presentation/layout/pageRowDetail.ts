import { HAPPIER_PAGE_METRICS, isHappierPageRowNarrow } from './pageMetrics.js';

/** Measured page detail placement; grouped and menu rows keep their own anatomy. */
export function resolveHappierPageRowDetailLayout(input: Readonly<{
  rowWidthPx: number | null;
  detailWidthPx: number | null;
  titleNaturalWidthPx: number | null;
  rowInsetPx: number;
  /** The rendered or section-reserved leading slot, excluding its gap. */
  leadingColumnWidthPx: number;
  /** The adapter's actual trailing controls and their spacing. */
  trailingWidthPx: number;
  detailGapPx: number;
  /** The row carries a description under its label: its shape, never a measurement of the description. */
  described: boolean;
}>): Readonly<{ beneath: boolean; inlineMaxWidthPx: number | null }> {
  if (!isHappierPageRowNarrow(input.rowWidthPx) || input.rowWidthPx === null) {
    return { beneath: false, inlineMaxWidthPx: null };
  }
  // On a phone a described row's value is the answer to its label and the description explains it, so the value
  // goes directly under the label, before the description, however short both are (design owner, 2026-11-26
  // 11:24Z: "Delivery · Not sent" beside a four-line description). A row without one weighs the fit below.
  if (input.described) return { beneath: true, inlineMaxWidthPx: null };
  const metrics = HAPPIER_PAGE_METRICS;
  const rowChromePx = 2 * input.rowInsetPx + (input.leadingColumnWidthPx > 0
    ? input.leadingColumnWidthPx + metrics.rowLeadingGapPx : 0);
  // The label keeps its whole name up to the section floor, and the floor is text width: a name the
  // floor could hold is never cut to make room for the detail (a Machine name beside "Not shared with you"
  // on a phone); the detail moves beneath instead. Unmeasured, the label keeps the floor.
  const labelColumnPx = input.titleNaturalWidthPx !== null
    ? Math.min(metrics.sectionTextMinWidthPx, input.titleNaturalWidthPx) + input.trailingWidthPx + rowChromePx
    : metrics.sectionTextMinWidthPx;
  // Only a short value sits beside a label on a narrow row (the phone rule): a detail that takes more than half
  // of the row's text column is a description, and it reads beneath its title (Session Info "Fork…  Native,
  // replay or configure", L13), however short the label.
  const textColumnPx = input.rowWidthPx - rowChromePx;
  const beneath = input.detailWidthPx !== null
    && (input.rowWidthPx - input.detailWidthPx - metrics.rowLeadingGapPx < labelColumnPx
      || input.detailWidthPx > textColumnPx / 2);
  return {
    beneath,
    inlineMaxWidthPx: !beneath && input.titleNaturalWidthPx !== null && input.titleNaturalWidthPx < metrics.sectionTextMinWidthPx
      ? input.rowWidthPx - (labelColumnPx - input.trailingWidthPx) - metrics.rowLeadingGapPx - input.detailGapPx
      : null,
  };
}
