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

export type LiquidGlassProbes = Readonly<{
    /** Whether the BUILD supports Liquid Glass (toolchain + iOS version). */
    isLiquidGlassAvailable?: () => boolean;
    /** Whether the Liquid Glass API is actually present on THIS device at runtime. */
    isGlassEffectAPIAvailable?: () => boolean;
}>;

/**
 * Pure availability decision, kept separate from the native `require` so it is testable without
 * standing up the native module.
 *
 * BOTH probes are required. `isLiquidGlassAvailable` answers "was this built against a toolchain
 * that supports Liquid Glass"; `isGlassEffectAPIAvailable` was added by `expo-glass-effect`
 * specifically because some iOS 26 builds report the first as true while the runtime API is absent,
 * and rendering a `GlassView` there crashes. Checking only the build-level flag is exactly the case
 * that guard exists to catch. A probe that is missing or throws counts as unavailable, so an older
 * module version degrades to blur instead of crashing.
 */
export function resolveLiquidGlassAvailability(probes: LiquidGlassProbes | null): boolean {
    if (!probes) return false;
    try {
        if (probes.isLiquidGlassAvailable?.() !== true) return false;
        return probes.isGlassEffectAPIAvailable?.() === true;
    } catch {
        return false;
    }
}

export function isLiquidGlassAvailable(): boolean {
    return resolveLiquidGlassAvailability(loadGlassModule());
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
