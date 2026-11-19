/** The switch's geometry, platform-free: the drawn web switch, the native adapter and the hosted HTML kit read it. */
export const HAPPIER_SWITCH_METRICS = Object.freeze({
  default: Object.freeze({ trackWidth: 40, trackHeight: 24, thumbSize: 20, padding: 2 }),
  compact: Object.freeze({ trackWidth: 32, trackHeight: 18, thumbSize: 14, padding: 2 }),
  /**
   * While pressed, the thumb widens toward the track's centre (the physical
   * squash of a switch about to move), by this much, and settles back on release.
   */
  pressStretchPx: 4,
  /** The web control's hit area around the drawn track (the shared hit-area owner's frame); it takes no layout. */
  webTargetPx: 44,
  disabledOpacity: 0.6,
});
