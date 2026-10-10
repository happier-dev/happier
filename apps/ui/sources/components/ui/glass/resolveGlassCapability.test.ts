import { describe, expect, it } from 'vitest';

import { resolveGlassCapability } from './resolveGlassCapability';
import { glassPresetMaterials } from './glassMaterial';

describe('resolveGlassCapability', () => {
    it('lets Liquid Glass adapt named floating presets while honoring authored Strong blur', () => {
        const input = { liquidGlassAvailable: true, blurAvailable: true, reduceTransparency: false, surfaceGroup: 'floating' as const };
        for (const preset of ['auto', 'everywhere', 'clear'] as const) {
            expect(resolveGlassCapability({ ...input, settings: { glassSurfaceMaterials: glassPresetMaterials(preset) } })).toBe('liquidGlass');
            expect(resolveGlassCapability({ ...input, surfaceGroup: undefined, settings: { glassSurfaceMaterials: glassPresetMaterials(preset) } })).toBe('liquidGlass');
        }
        expect(resolveGlassCapability({ ...input, settings: { glassSurfaceMaterials: {
            ...glassPresetMaterials('auto'), floating: { blur: 'strong', opacity: 0.13 },
        } } })).toBe('blur');
    });
    it('honors Solid from predecessor account settings instead of independently enabling web blur', () => {
        expect(resolveGlassCapability({
            liquidGlassAvailable: false,
            blurAvailable: false,
            webBlurAvailable: true,
            reduceTransparency: false,
            settings: { glassBlurEnabled: false, glassBlurIntensity: 'strong' },
            surfaceGroup: 'floating',
        })).toBe('solid');
    });

    it('keeps Auto working content solid and follows native inactive-window behavior', () => {
        const input = {
            liquidGlassAvailable: false,
            blurAvailable: false,
            webBlurAvailable: true,
            reduceTransparency: false,
            settings: { glassBlurEnabled: true, glassBlurIntensity: 'regular' as const },
        };
        expect(resolveGlassCapability({ ...input, surfaceGroup: 'content' })).toBe('solid');
        expect(resolveGlassCapability({ ...input, surfaceGroup: 'floating', highContrast: true })).toBe('webBlur');
        expect(resolveGlassCapability({ ...input, surfaceGroup: 'floating', windowActive: false })).toBe('solid');
    });

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
