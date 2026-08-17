/**
 * The downward nudge that puts an icon on a text run's OPTICAL centre.
 *
 * A row centres the icon box on the label's line box, which is geometrically correct and looks
 * wrong. A line box reserves descender space it usually does not use: for the 13px UI text here the
 * box is 16px, the baseline sits 12.6px down, and lowercase mass occupies roughly 5.8–12.6px — so
 * the ink the eye actually weighs is centred about a pixel BELOW the box centre. An icon centred on
 * the box therefore reads a pixel high, which is what makes menu rows and composer chips look
 * subtly off even though every measurement says `dy: 0`.
 *
 * The value is the midpoint between two defensible targets, because the right one depends on the
 * label's own letters. Aligning to the CAP-height centre needs almost no nudge and is what mixed-case
 * text like "Default" wants; aligning to the x-height centre needs ~1.4px and is what lowercase-only
 * text wants. Calibrating to either extreme visibly misses the other — measured at 1.37 the chip
 * glyphs read low against capitalised labels, and at 0 they read high against lowercase ones.
 */
export const ICON_LABEL_OPTICAL_NUDGE_PX = 0.7;

/**
 * Apply the nudge as a TRANSFORM, not a margin.
 *
 * A margin would be wrong twice over: inside a `alignItems: 'center'` row the margin box is what
 * gets centred, so only half of it lands as movement, and the other half silently grows the row.
 * A translate moves the drawn glyph and nothing else.
 */
export const ICON_LABEL_OPTICAL_NUDGE_STYLE: { transform: { translateY: number }[] } = {
    transform: [{ translateY: ICON_LABEL_OPTICAL_NUDGE_PX }],
};
