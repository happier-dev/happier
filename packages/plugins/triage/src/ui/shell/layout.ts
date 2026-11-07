/**
 * Content-owned readable pane measures for the PRs & Issues shell.
 *
 * `core/SURFACE.md` §2.1: Triage supplies scaled reading measures and one ratio
 * preference to the shared ListDetailLayout, which owns measurement and
 * split/stacked composition and the shared resize handle. The surface can give
 * the Collection a stable resizeKey for device-local width restoration.
 */

/**
 * The one static layout preference (`core/SURFACE.md` §2.1). Beside a detail the list is a scan column of
 * two-line rows (the lens toolbar sits above both panes), while the detail carries source-native content, so the
 * preference favours detail: the approved composition (`c7-merged.html`) gives the list about 440 of 1188 pt. It
 * is the default before a person resizes the Collection rail.
 */
export const TRIAGE_SPLIT_LIST_RATIO_PREFERENCE_V1 = 0.37;

/**
 * The board's narrowest card at normal text size. The approved board (`c7-merged.html`) gives each card about 276 pt
 * of a 1440 window; narrower, a two-line title breaks to a word per line and the reason chip meets the mark. When the
 * columns cannot all keep it (the detail pane open beside the board, a narrow window) the board scrolls sideways
 * rather than squeezing every card.
 */
export const TRIAGE_BOARD_CARD_MIN_WIDTH_V1 = 280;

/**
 * Minimum legible measure for the row title, in characters. Below it the
 * design's two-line tail-truncated title can no longer show the discriminating
 * part of an identifier, which is the row's whole scanning purpose.
 */
const TRIAGE_LIST_TITLE_MEASURE_CHARACTERS_V1 = 24;

/** Minimum measure for the row's quiet trailing metadata ("2 hours ago"). */
const TRIAGE_LIST_META_MEASURE_CHARACTERS_V1 = 8;

/**
 * Minimum comfortable reading measure for source-native prose (descriptions,
 * comments, review feedback), in characters. 45 is the low end of the standard
 * 45–75 character line-length range for continuous reading; a narrower detail
 * pane stops being readable rather than merely tight.
 */
const TRIAGE_DETAIL_BODY_MEASURE_CHARACTERS_V1 = 45;

/**
 * Characters-to-width conversion for a proportional UI face. The typographic
 * convention is that one lowercase character averages about half its font size
 * in advance width, which is why measure is quoted in characters at all.
 */
const AVERAGE_CHARACTER_ADVANCE_PER_FONT_SIZE = 0.5;

/**
 * One already-scaled text role metric projected from the host theme.
 *
 * The canonical text-scale owner is `@happier-dev/plugin-ui`'s `Text`
 * presentation (`scaleTextStyleMetrics`), which the surface applies to the
 * host-projected `SurfaceContext.theme.typography` before measuring here.
 * Rescaling locally would put a second text-scale decision in the product.
 */
export type TriageScaledLineMetricsV1 = Readonly<{
  fontSize: number;
  lineHeight: number;
}>;

/** The four text roles the pane minima below are measured from. */
export type TriageScaledTypeMetricsV1 = Readonly<{
  title: TriageScaledLineMetricsV1;
  body: TriageScaledLineMetricsV1;
  caption: TriageScaledLineMetricsV1;
  label: TriageScaledLineMetricsV1;
}>;

type TriagePaneSpacingV1 = Readonly<{ xsmall: number; small: number; medium: number }>;

export type TriagePaneMeasureInputV1 = Readonly<{
  type: TriageScaledTypeMetricsV1;
  spacing: TriagePaneSpacingV1;
}>;

/**
 * The narrowest list pane that still renders the design's row anatomy: leading
 * padding and selection edge, the kind mark, the title measure, the quiet
 * trailing metadata, and trailing padding.
 */
export function resolveTriageListPaneMinimumWidthV1(input: TriagePaneMeasureInputV1): number {
  return Math.ceil(
    input.spacing.medium
    + input.type.label.lineHeight
    + input.spacing.small
    + measure(input.type.title.fontSize, TRIAGE_LIST_TITLE_MEASURE_CHARACTERS_V1)
    + input.spacing.small
    + measure(input.type.caption.fontSize, TRIAGE_LIST_META_MEASURE_CHARACTERS_V1)
    + input.spacing.medium,
  );
}

/** The narrowest detail pane that keeps source-native prose readable. */
export function resolveTriageDetailPaneMinimumWidthV1(input: TriagePaneMeasureInputV1): number {
  return Math.ceil(
    input.spacing.medium
    + measure(input.type.body.fontSize, TRIAGE_DETAIL_BODY_MEASURE_CHARACTERS_V1)
    + input.spacing.medium,
  );
}

function measure(fontSize: number, characters: number): number {
  return fontSize * AVERAGE_CHARACTER_ADVANCE_PER_FONT_SIZE * characters;
}
