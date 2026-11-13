import { Platform } from 'react-native';
import type * as ExpoBlur from 'expo-blur';
import type { GlassSurfaceGroup } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';

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
 * Native blur without an explicit content target is supported only on iOS.
 * SDK 55 Android requires a BlurTargetView outside its consuming blur views; until the
 * composition owner supplies that target, consumers use their tint/dim fallback.
 */
export function isNativeBlurAvailable(): boolean {
    return Platform.OS === 'ios';
}

/**
 * Where native blur is unavailable (Android), a surface standing on the app's own page or picture (chrome,
 * sidebar, content planes, in-flow cards) keeps its authored tint. A floating surface (dialog, sheet, menu,
 * popover) can have anything behind it, so it follows the capability instead: opaque, unless its material
 * is an explicitly unblurred tint (owner 11-13: the Welcome hero read through an Android sheet).
 */
export function drawsTintWithoutBlur(group: GlassSurfaceGroup): boolean {
    return Platform.OS === 'android' && group !== 'floating';
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
    if (!isNativeBlurAvailable()) return null;
    return loadBlurModule()?.BlurView ?? null;
}
