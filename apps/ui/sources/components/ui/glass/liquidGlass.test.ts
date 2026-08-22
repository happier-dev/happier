import { describe, expect, it } from 'vitest';

import { resolveLiquidGlassAvailability } from './liquidGlass';

describe('resolveLiquidGlassAvailability', () => {
    it('reports available only when the build AND the runtime API both support Liquid Glass', () => {
        expect(resolveLiquidGlassAvailability({
            isLiquidGlassAvailable: () => true,
            isGlassEffectAPIAvailable: () => true,
        })).toBe(true);
    });

    it('reports unavailable when the runtime API is missing even though the build supports it', () => {
        // `isGlassEffectAPIAvailable` is the guard expo-glass-effect added specifically because some
        // iOS 26 builds report the build-level flag as true while the API is absent, and rendering a
        // `GlassView` there crashes. Checking only the build flag is the exact case it exists for.
        expect(resolveLiquidGlassAvailability({
            isLiquidGlassAvailable: () => true,
            isGlassEffectAPIAvailable: () => false,
        })).toBe(false);
    });

    it('reports unavailable when the build does not support Liquid Glass at all', () => {
        expect(resolveLiquidGlassAvailability({
            isLiquidGlassAvailable: () => false,
            isGlassEffectAPIAvailable: () => true,
        })).toBe(false);
    });

    it('degrades to unavailable when a module version predates the runtime guard', () => {
        // An older `expo-glass-effect` exports no runtime probe. Falling back to blur is correct;
        // assuming the API is present would reintroduce the crash on the affected builds.
        expect(resolveLiquidGlassAvailability({ isLiquidGlassAvailable: () => true })).toBe(false);
    });

    it('degrades to unavailable when a probe throws or the module is absent', () => {
        expect(resolveLiquidGlassAvailability({
            isLiquidGlassAvailable: () => true,
            isGlassEffectAPIAvailable: () => {
                throw new Error('native module missing');
            },
        })).toBe(false);
        expect(resolveLiquidGlassAvailability(null)).toBe(false);
    });
});
