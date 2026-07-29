/**
 * One size for the session header's icon actions.
 *
 * The cluster had grown to 22 / 21 / 22 / 22 across four separately-owned buttons, which reads as
 * misalignment rather than as variety — nobody chose those numbers together.
 */
export const SESSION_HEADER_ICON_SIZE_PX = 20;

/**
 * The optical correction, not an exception to the rule above.
 *
 * A declared icon size is an em box, not the ink inside it. Outline glyphs that fill their box edge
 * to edge — `terminal-outline` is a full-bleed rectangle — paint noticeably more area than the
 * mostly-empty boxes of `ellipsis-horizontal` or `list-outline` at the same number. Matching the
 * numbers would leave the terminal glyph looking the largest in the row, which is exactly what it
 * looked like. Matching the ink means giving the boxy glyph a smaller box.
 */
export const SESSION_HEADER_BOXY_ICON_SIZE_PX = 18;
