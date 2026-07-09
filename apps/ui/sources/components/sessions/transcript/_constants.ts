export const TRANSCRIPT_TOP_GUTTER_PX = 12;
/**
 * Bottom-edge gutter (px) for the catch-up overlay: it floats this far ABOVE the
 * composer (on top of the dynamic composer inset) so its glass pill + cast shadow
 * clear the composer instead of sitting flush against it. Mirrors
 * {@link TRANSCRIPT_TOP_GUTTER_PX} and matches the jump-to-bottom button's gap.
 */
export const TRANSCRIPT_BOTTOM_GUTTER_PX = 12;
export const TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS = 16;
export const TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS = 32;
/**
 * Genuine-top tolerance (px) for the web DOM-scroll "at the very top" classifier and the
 * older-pagination machine's exact-edge re-arm. The web scroll element reports `scrollTop`
 * as an integer-rounded (dpr=1) or sub-pixel-residue (Retina) value, so a viewport resting
 * at the genuine top is rarely EXACTLY 0 (browser-proven: ~1 at dpr=1, ~0.5/0.33 on Retina).
 * Classifying only `=== 0` as the genuine top (and only accepting `=== 0` in the machine's
 * `edge-reached` re-arm) makes both mis-fire on those near-top frames, leaving a viewport
 * parked at the rendered top unable to re-arm "load previous". A small fixed epsilon (1.5px)
 * covers the rounding residues without widening the band enough to admit a real mid-content
 * frame, so the anti-burst guarantees are preserved.
 */
export const TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX = 1.5;
// Per-wait fallback slice for rAF-backed visual-update waits (plan D5): a starved
// requestAnimationFrame must never stall fill/prepend-restore paths.
export const TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS = 250;
