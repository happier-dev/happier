/**
 * The disclosure caret's geometry (lab `.wf-cv`): a 12pt chevron in a 24pt box whose hit area the caller extends
 * to the touch floor. The drawn mark is the lab caret's own proportion — a 6-unit run over 12 in a 24-unit glyph,
 * so each arm is √72/24 ≈ 0.354 of the glyph box — at the lab's 2.2-of-24 stroke (1.1pt at 12pt).
 * Platform-free: the React chevron and the hosted HTML kit's select chevron read it.
 */
export const HAPPIER_DISCLOSURE_CHEVRON_METRICS = Object.freeze({
  boxPx: 24,
  glyphPx: 12,
  armRatio: Math.SQRT2 / 4,
  strokePx: 1.1,
});
