/**
 * The slider's geometry, platform-free, for plugin-ui's slider (the hosted HTML kit). It is Happier core's
 * `Slider` geometry: the thumb is filled with the text ink and ringed in the surface colour, and the track's
 * filled part is ink too. Core reads its own copy until this is a public plugin-ui export (API governance).
 */
export const HAPPIER_SLIDER_METRICS = Object.freeze({
  trackHeightPx: 4,
  thumbSizePx: 18,
  thumbRingWidthPx: 2,
  /** The track frame in layout under every pointer; a finger reaches the touch target through the shared hit area. */
  trackHitHeightPx: 40,
  disabledOpacity: 0.5,
});
