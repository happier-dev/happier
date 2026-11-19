import { HAPPIER_RADIUS_V1 } from '../../environment/radius.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';

/**
 * The field box's geometry, platform-free: `HAPPIER_FIELD_BOX_METRICS` adds the platform value type for
 * React and React Native, and the hosted HTML kit draws its select from the same numbers.
 */
export const HAPPIER_FIELD_BOX_GEOMETRY = Object.freeze({
  minHeightPx: HAPPIER_PAGE_METRICS.controlHeightPx,
  /** A control: the `md` step of the one radius base. */
  radiusPx: HAPPIER_RADIUS_V1.md,
  borderWidthPx: 1,
  paddingLeftPx: 12,
  paddingRightPx: 8,
  /** Narrowest width beside a label; stacked under the label a field spans the row instead. */
  inlineMinWidthPx: HAPPIER_PAGE_METRICS.fieldInlineMinWidthPx,
  /** A select trigger's box: wide enough for a short choice, never wider than a long one needs. */
  triggerMinWidthPx: 132,
  triggerMaxWidthPx: 280,
  /** Between the leading mark, the value and the trailing chevron. */
  triggerGapPx: 8,
  /** The chip density: a select that sits among a row's quiet facts (a role's engine) as a soft pill. */
  chipHeightPx: 28,
  chipPaddingLeftPx: 10,
  chipPaddingRightPx: 8,
  chipGapPx: 6,
});
