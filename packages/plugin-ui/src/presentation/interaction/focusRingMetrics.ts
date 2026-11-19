/**
 * The one focus ring (DESIGN.md, Accessibility): 2px of the focus colour, held 2px off the control so
 * the page shows through as the gap. An outline follows the control's radius on the web and on React
 * Native's native outline props, never takes layout space, and never merges with the control's own
 * border, so it reads on every surface.
 */
export const HAPPIER_FOCUS_RING_V1 = Object.freeze({ widthPx: 2, gapPx: 2 });
