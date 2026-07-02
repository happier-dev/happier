export const TRANSCRIPT_TOP_GUTTER_PX = 12;
export const TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS = 16;
export const TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS = 32;
// Per-wait fallback slice for rAF-backed visual-update waits (plan D5): a starved
// requestAnimationFrame must never stall fill/prepend-restore paths.
export const TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS = 250;
