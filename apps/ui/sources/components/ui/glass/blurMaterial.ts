import { Platform } from 'react-native';
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

/**
 * Whether a native `BlurView` may be mounted on this platform. The single decision for every
 * native blur consumer (glass surfaces, popover backdrops, slide transitions, overlay scrims).
 *
 * iOS only. On Android, expo-blur's blur (Dimezis BlurView) redraws the whole app root into a
 * software bitmap on every frame per mounted view, and any expo-blur view — even with no blur
 * method — registers root pre-draw hooks that are never removed on unmount, so the cost
 * accumulates until the app restarts. Android consumers use their non-blur fallback instead.
 */
export function isNativeBlurAvailable(): boolean {
    return Platform.OS === 'ios';
}

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
    if (!isNativeBlurAvailable()) {
        return null;
    }
    return loadBlurModule()?.BlurView ?? null;
}
