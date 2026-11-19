import { HAPPIER_RADIUS_V1, happierInnerRadius } from '../../environment/radius.js';

/**
 * The segmented control's geometry, platform-free so every realm that draws a segmented choice reads one
 * source: Happier core's `SegmentedTabBar`, the plugin segmented `Select` (through
 * `HAPPIER_SEGMENTED_METRICS`, which adds the platform label type) and the hosted HTML kit.
 *
 * These are padding-driven visible heights: a segment never carries a `minHeight`, because a minimum sized
 * for a touch target silently becomes the drawn box. `labelSlotPx` is the label's nominal optical slot
 * (Inter's line box at these sizes), used only to reason about a press frame; scaled text grows the
 * segment past it.
 *
 * `segmentMinWidthPx` is not the platform touch target: segments are flush siblings in one track, so a
 * 44/48 floor multiplies across them. A dense pointer layout meets WCAG 2.2 SC 2.5.8 (24 CSS px) instead.
 */
const SEGMENTED_TRACK_PADDING_PX = 2;

export const HAPPIER_SEGMENTED_GEOMETRY = Object.freeze({
  /** The track's inset: the gap around the segments and the thumb's inset. */
  trackPaddingPx: SEGMENTED_TRACK_PADDING_PX,
  /** A control (`md`); the compact track one step smaller (`sm`). Segments sit concentric inside it. */
  trackRadiusPx: Object.freeze({ default: HAPPIER_RADIUS_V1.md, compact: HAPPIER_RADIUS_V1.sm }),
  segmentRadiusPx: Object.freeze({
    default: happierInnerRadius(HAPPIER_RADIUS_V1.md, SEGMENTED_TRACK_PADDING_PX),
    compact: happierInnerRadius(HAPPIER_RADIUS_V1.sm, SEGMENTED_TRACK_PADDING_PX),
  }),
  segmentPaddingVerticalPx: Object.freeze({ default: 6, compact: 4 }),
  /** A content-sized segment's side padding (a segment hugging its label). */
  segmentPaddingHorizontalPx: 12,
  /** The side padding when the track is too narrow for its labels at their natural width. */
  segmentPaddingTightPx: 4,
  /**
   * The default label is the control text role (selects, buttons and segment labels read as one
   * family beside the row titles); the track stays 32px tall (2 + 6 + 16 + 6 + 2).
   */
  labelSlotPx: Object.freeze({ default: 16, compact: 12 }),
  /** The chosen label's emphasis: a face, never a numeric weight over the regular face. */
  labelActiveEmphasis: 'semiBold' as const,
  segmentMinWidthPx: 24,
  /** One unavailable segment, or a whole unavailable control. */
  disabledOpacity: 0.5,
  /** Separate list-filter pills share the tab interaction owner, without a segmented track. */
  pills: Object.freeze({ gapPx: 8, radiusPx: 999, paddingVerticalPx: 4, paddingHorizontalPx: 8, labelSlotPx: 18 }),
  /**
   * A destination's page tabs (lab `p-overview` header): no track, a glyph beside each label, the
   * chosen tab on the ink selection fill. Controls' radius step; the label on the pill type step.
   */
  plain: Object.freeze({ gapPx: 2, radiusPx: HAPPIER_RADIUS_V1.md, paddingVerticalPx: 6, paddingHorizontalPx: 11, labelSlotPx: 18, iconGapPx: 7 }),
});
