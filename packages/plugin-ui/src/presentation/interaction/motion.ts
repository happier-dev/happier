/**
 * The state-transition motion scale shared by Happier core and plugin controls.
 *
 * A control that changes state on its own (a switch sliding, a field settling)
 * moves on these durations and this curve, so a core switch and a plugin
 * toggle travel identically. Happier core's `motionTokens.durationMs.fast` /
 * `.base` and its standard easing read these values rather than restating
 * them (the same arrangement as `HAPPIER_PRESS_FEEDBACK_V1`).
 *
 * - `hoverMs`: a hover paint (colour or background only; hover never moves anything).
 * - `fastMs`: a colour or opacity settle (a switch track filling).
 * - `baseMs`: a short travel (a switch thumb crossing its track), a disclosure or a list insert/remove.
 * - `slowMs`: a large shared-element move (a table opening into list + detail).
 * - `standard`: the one standard curve, as cubic-bezier control points; the
 *   CSS form is derived from them so the two cannot disagree.
 */
const STANDARD_BEZIER = Object.freeze([0.2, 0, 0, 1] as const);

export const HAPPIER_MOTION_V1 = Object.freeze({
  hoverMs: 120,
  fastMs: 140,
  baseMs: 220,
  slowMs: 320,
  standardBezier: STANDARD_BEZIER,
  standardEasingCss: `cubic-bezier(${STANDARD_BEZIER.join(', ')})`,
});
