/**
 * Shared pointer-drag tuning for floating companions (the pet, the Voice orb).
 *
 * These are perception constants, not per-companion taste: the threshold that separates a tap from
 * a drag and the window a release velocity is measured over behave the same whatever object is
 * being dragged. Motion that *is* per-companion — the release spring and the throw projection —
 * is injected at the call site instead (see `companionReleaseMotion.ts`).
 */
export const COMPANION_DRAG_THRESHOLD_PX = 4;
export const COMPANION_VELOCITY_SAMPLE_WINDOW_MS = 100;
export const COMPANION_VELOCITY_MIN_SPAN_MS = 16;
export const COMPANION_VELOCITY_MIN_MAGNITUDE_PX_PER_S = 320;
export const COMPANION_VELOCITY_MAX_MAGNITUDE_PX_PER_S = 1600;
