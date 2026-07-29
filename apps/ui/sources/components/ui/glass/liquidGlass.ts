import * as React from 'react';
import { Platform } from 'react-native';

/**
 * Boundary seam around `expo-glass-effect` (iOS 26 Liquid Glass native module).
 *
 * The module is loaded lazily and only on iOS so web/Android bundles never touch
 * a native entry that may not be available there. Every access is guarded; if the
 * module or API is missing we report "unavailable" and callers fall back to blur
 * or a solid surface. This keeps Liquid Glass purely additive and crash-safe.
 */
type GlassModule = typeof import('expo-glass-effect');

let cachedModule: GlassModule | null | undefined;

function loadGlassModule(): GlassModule | null {
    if (cachedModule !== undefined) {
        return cachedModule;
    }
    if (Platform.OS !== 'ios') {
        cachedModule = null;
        return cachedModule;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        cachedModule = require('expo-glass-effect') as GlassModule;
    } catch {
        cachedModule = null;
    }
    return cachedModule;
}

export function isLiquidGlassAvailable(): boolean {
    const module = loadGlassModule();
    if (!module) {
        return false;
    }
    try {
        return module.isLiquidGlassAvailable() === true;
    } catch {
        return false;
    }
}

export function getGlassViewComponent(): GlassModule['GlassView'] | null {
    return loadGlassModule()?.GlassView ?? null;
}

/**
 * Liquid Glass availability for a render pass. The native flag is fixed per app
 * launch (it depends on the build toolchain and iOS version), so it is read once
 * and memoized to avoid repeated native bridge calls. Accessibility-driven
 * translucency changes are handled separately via `useReduceTransparency`.
 */
export function useLiquidGlassAvailable(): boolean {
    return React.useMemo(() => isLiquidGlassAvailable(), []);
}
