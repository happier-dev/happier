/**
 * The slider's geometry, platform-free: the one owner Happier core's `Slider` and the hosted HTML kit's
 * slider both draw from. The thumb is filled with the text ink and ringed in the surface colour, and the
 * track's filled part is ink too.
 */
export const HAPPIER_SLIDER_METRICS = Object.freeze({
  trackHeightPx: 4,
  thumbSizePx: 18,
  thumbRingWidthPx: 2,
  /** The track frame in layout under every pointer; a finger reaches the touch target through the shared hit area. */
  trackHitHeightPx: 40,
  disabledOpacity: 0.5,
});
