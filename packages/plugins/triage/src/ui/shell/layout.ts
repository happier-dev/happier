import type { TriageRowGeometryV1, TriageScaledTypeMetricsV1 } from '../list/geometry.js';

/**
 * Measured split/stacked composition for the PRs & Issues shell.
 *
 * `core/SURFACE.md` §2.1: the shell measures its own fill region and combines
 * that width with host-stamped accessibility facts. `split` is selected ONLY
 * when the measured width can honour both pane minima — never from a
 * desktop/tablet/phone guess — and its ratio is one static preference clamped
 * by those same minima. V1 has no drag handle, separator role, pane-width
 * Settings value or restoration path, so nothing here is retained or persisted.
 */

/**
 * The one static layout preference (`core/SURFACE.md` §2.1). The list is a scan
 * column near its useful measure while the detail region carries source-native
 * content, so the preference favours detail. It is a starting point for the
 * clamp below, not a stored or user-adjustable value.
 */
export const TRIAGE_SPLIT_LIST_RATIO_PREFERENCE_V1 = 0.38;

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

export type TriageLayoutV1 =
  | Readonly<{
      mode: 'split';
      rowGeometry: TriageRowGeometryV1;
      /** The resolved ratio AFTER both pane minima have clamped the preference. */
      listRatio: number;
    }>
  | Readonly<{ mode: 'stacked'; rowGeometry: TriageRowGeometryV1 }>;

type TriagePaneSpacingV1 = Readonly<{ xsmall: number; small: number; medium: number }>;

export type TriagePaneMeasureInputV1 = Readonly<{
  type: TriageScaledTypeMetricsV1;
  spacing: TriagePaneSpacingV1;
}>;

export type TriageLayoutInputV1 = TriagePaneMeasureInputV1 & Readonly<{
  availableWidth: number;
  rowGeometry: TriageRowGeometryV1;
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

export function resolveTriageLayoutV1(input: TriageLayoutInputV1): TriageLayoutV1 {
  const listMinimum = resolveTriageListPaneMinimumWidthV1(input);
  const detailMinimum = resolveTriageDetailPaneMinimumWidthV1(input);

  if (input.availableWidth < listMinimum + detailMinimum) {
    return Object.freeze({ mode: 'stacked', rowGeometry: input.rowGeometry });
  }

  // Both minima clamp the one static preference. The measured width already
  // clears their sum, so the low bound never crosses the high bound.
  const listRatio = Math.min(
    Math.max(TRIAGE_SPLIT_LIST_RATIO_PREFERENCE_V1, listMinimum / input.availableWidth),
    1 - detailMinimum / input.availableWidth,
  );

  return Object.freeze({ mode: 'split', rowGeometry: input.rowGeometry, listRatio });
}

function measure(fontSize: number, characters: number): number {
  return fontSize * AVERAGE_CHARACTER_ADVANCE_PER_FONT_SIZE * characters;
}
