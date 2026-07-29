import type * as ExpoBlur from 'expo-blur';

/**
 * Boundary seam around `expo-blur` (the translucent blur fallback material).
 *
 * Loaded lazily via `require` — mirroring the `expo-glass-effect` seam in
 * `liquidGlass.ts` — so the module is never part of the static import graph.
 * That keeps it crash-safe (a missing/incompatible native module falls back to a
 * solid surface instead of throwing) and means consuming tests don't each have to
 * mock `expo-blur` just because they render a `GlassPanel`.
 */
type BlurModule = typeof ExpoBlur;

let cachedModule: BlurModule | null | undefined;

function loadBlurModule(): BlurModule | null {
    if (cachedModule !== undefined) {
        return cachedModule;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        cachedModule = require('expo-blur') as BlurModule;
    } catch {
        cachedModule = null;
    }
    return cachedModule;
}

export function getBlurViewComponent(): BlurModule['BlurView'] | null {
    return loadBlurModule()?.BlurView ?? null;
}
