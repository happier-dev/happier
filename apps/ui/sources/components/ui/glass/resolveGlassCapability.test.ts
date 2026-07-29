import { describe, expect, it } from 'vitest';

import { resolveGlassCapability } from './resolveGlassCapability';

describe('resolveGlassCapability', () => {
    it('prefers Liquid Glass when available', () => {
        expect(resolveGlassCapability({
            liquidGlassAvailable: true,
            blurAvailable: true,
            reduceTransparency: false,
        })).toBe('liquidGlass');
    });

    it('falls back to blur when Liquid Glass is unavailable', () => {
        expect(resolveGlassCapability({
            liquidGlassAvailable: false,
            blurAvailable: true,
            reduceTransparency: false,
        })).toBe('blur');
    });

    it('falls back to solid when neither material is available', () => {
        expect(resolveGlassCapability({
            liquidGlassAvailable: false,
            blurAvailable: false,
            reduceTransparency: false,
        })).toBe('solid');
    });

    it('forces solid when Reduce Transparency is enabled, even if Liquid Glass is available', () => {
        expect(resolveGlassCapability({
            liquidGlassAvailable: true,
            blurAvailable: true,
            reduceTransparency: true,
        })).toBe('solid');
    });

    it('forces solid when Reduce Transparency is enabled, even if only blur is available', () => {
        expect(resolveGlassCapability({
            liquidGlassAvailable: false,
            blurAvailable: true,
            reduceTransparency: true,
        })).toBe('solid');
    });

    it('uses web blur (backdrop-filter) when only web blur is available', () => {
        expect(resolveGlassCapability({
            liquidGlassAvailable: false,
            blurAvailable: false,
            webBlurAvailable: true,
            reduceTransparency: false,
        })).toBe('webBlur');
    });

    it('prefers native blur over web blur', () => {
        expect(resolveGlassCapability({
            liquidGlassAvailable: false,
            blurAvailable: true,
            webBlurAvailable: true,
            reduceTransparency: false,
        })).toBe('blur');
    });

    it('forces solid over web blur when Reduce Transparency is enabled', () => {
        expect(resolveGlassCapability({
            liquidGlassAvailable: false,
            blurAvailable: false,
            webBlurAvailable: true,
            reduceTransparency: true,
        })).toBe('solid');
    });
});
