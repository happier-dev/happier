import { describe, expect, it } from 'vitest';

import { resolveGlassCapability } from './resolveGlassCapability';
import { glassPresetMaterials } from './glassMaterial';

describe('resolveGlassCapability', () => {
    it('uses tint for native Elements even with both SDK materials available, while web Elements can blur', () => {
        const input = { liquidGlassAvailable: true, blurAvailable: true, reduceTransparency: false,
            atmosphereBehind: 'wallpaper' as const, surfaceGroup: 'card' as const,
            settings: { glassSurfaceMaterials: glassPresetMaterials('auto') } };
        expect(resolveGlassCapability(input)).toBe('tint');
        expect(resolveGlassCapability({ ...input, webBlurAvailable: true })).toBe('webBlur');
        expect(resolveGlassCapability({ ...input, reduceTransparency: true })).toBe('solid');
        expect(resolveGlassCapability({ ...input, atmosphereBehind: 'none' })).toBe('solid');
    });
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
    });

    it.each([
        { name: 'prefers Liquid Glass when available', liquidGlassAvailable: true, blurAvailable: true, reduceTransparency: false, expected: 'liquidGlass' },
        { name: 'falls back to blur when Liquid Glass is unavailable', liquidGlassAvailable: false, blurAvailable: true, reduceTransparency: false, expected: 'blur' },
        { name: 'falls back to solid when neither material is available', liquidGlassAvailable: false, blurAvailable: false, reduceTransparency: false, expected: 'solid' },
        { name: 'forces solid when Reduce Transparency is enabled, even if Liquid Glass is available', liquidGlassAvailable: true, blurAvailable: true, reduceTransparency: true, expected: 'solid' },
        { name: 'forces solid when Reduce Transparency is enabled, even if only blur is available', liquidGlassAvailable: false, blurAvailable: true, reduceTransparency: true, expected: 'solid' },
        { name: 'uses web blur (backdrop-filter) when only web blur is available', liquidGlassAvailable: false, blurAvailable: false, webBlurAvailable: true, reduceTransparency: false, expected: 'webBlur' },
        { name: 'prefers native blur over web blur', liquidGlassAvailable: false, blurAvailable: true, webBlurAvailable: true, reduceTransparency: false, expected: 'blur' },
        { name: 'forces solid over web blur when Reduce Transparency is enabled', liquidGlassAvailable: false, blurAvailable: false, webBlurAvailable: true, reduceTransparency: true, expected: 'solid' },
    ] as const)('$name', ({ name: _name, expected, ...input }) => {
        expect(resolveGlassCapability(input)).toBe(expected);
    });
});
