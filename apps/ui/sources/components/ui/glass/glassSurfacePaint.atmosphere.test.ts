import { describe, expect, it } from 'vitest';
import { glassPresetMaterials } from './glassMaterial';
import { glassNavigationBackgroundColor, glassSurfaceBackgroundColor, glassSurfacePlaneBackdropStyle, resolveGlassSurfacePlaneMaterial } from './glassSurfacePaint';

describe('session atmosphere coats at the glass owner', () => {
    const clear = { glassSurfaceMaterials: glassPresetMaterials('clear') };
    const wallpaper = { atmosphereBehind: 'wallpaper' as const };
    it('clears the background plane for every glass setting while keeping Solid functional surfaces opaque', () => {
        for (const preset of ['solid', 'auto', 'everywhere', 'clear', 'custom'] as const) {
            const settings = { glassSurfaceMaterials: preset === 'custom'
                ? { ...glassPresetMaterials('clear'), content: { blur: 'off' as const, opacity: 0.347 } }
                : glassPresetMaterials(preset) };
            for (const overrides of [{}, { reduceTransparency: true }]) {
                for (const atmosphereBehind of ['band', 'wallpaper'] as const) {
                    const environment = { ...overrides, atmosphereBehind };
                    expect(resolveGlassSurfacePlaneMaterial(settings, 'content', environment)).toEqual({ blur: 'off', opacity: 0 });
                    if (preset === 'solid' || 'reduceTransparency' in overrides) {
                        for (const group of ['chrome', 'sidebar', 'card', 'floating'] as const) {
                            expect(resolveGlassSurfacePlaneMaterial(settings, group, environment)).toEqual({ blur: 'off', opacity: 1 });
                            expect(glassSurfacePlaneBackdropStyle(settings, group, false, environment)).toBeNull();
                        }
                    }
                }
            }
        }
    });
    it('keeps the transcript opaque by default and calibrates opt-in reading coats by theme', () => {
        expect(resolveGlassSurfacePlaneMaterial(clear, 'content', wallpaper, 'opaque', false).opacity).toBe(1);
        expect(resolveGlassSurfacePlaneMaterial(clear, 'content', wallpaper, 'reading', false)).toEqual({ blur: 'regular', opacity: 0.56 });
        expect(resolveGlassSurfacePlaneMaterial(clear, 'content', wallpaper, 'reading', true)).toEqual({ blur: 'regular', opacity: 0.66 });
    });
    it('honors Solid, reduce transparency and authored Custom opacity without a new blur scale', () => {
        expect(resolveGlassSurfacePlaneMaterial(clear, 'content', { ...wallpaper, reduceTransparency: true }, 'reading', false).opacity).toBe(1);
        expect(resolveGlassSurfacePlaneMaterial({ glassSurfaceMaterials: glassPresetMaterials('solid') }, 'content', wallpaper, 'reading', true).opacity).toBe(1);
        const custom = { glassSurfaceMaterials: { ...glassPresetMaterials('clear'), content: { blur: 'light' as const, opacity: 0.23 } } };
        expect(resolveGlassSurfacePlaneMaterial(custom, 'content', wallpaper, 'reading', true)).toEqual({ blur: 'light', opacity: 0.23 });
    });
    it('lets only an opt-in reading coat blur the common picture through the content material', () => {
        expect(glassSurfacePlaneBackdropStyle(clear, 'content', false, wallpaper, 'reading')).not.toBeNull();
        expect(glassSurfacePlaneBackdropStyle(clear, 'content', false, wallpaper)).toBeNull();
    });
});

describe('navigation background under the atmosphere', () => {
    const canvas = 'rgb(242, 240, 235)';
    const opaqueChrome = glassSurfaceBackgroundColor(canvas, 'chrome', true);
    it('lets the route background clear only while the atmosphere paints behind the active surface', () => {
        expect(glassNavigationBackgroundColor(canvas, { atmosphereBehind: 'wallpaper' })).toBe('transparent');
        expect(glassNavigationBackgroundColor(canvas, { atmosphereBehind: 'band' })).toBe('transparent');
    });
    it('keeps the opaque chrome background on every route the atmosphere does not cover', () => {
        expect(opaqueChrome).not.toBe('transparent');
        expect(glassNavigationBackgroundColor(canvas, {})).toBe(opaqueChrome);
        expect(glassNavigationBackgroundColor(canvas, { atmosphereBehind: 'none' })).toBe(opaqueChrome);
        expect(glassNavigationBackgroundColor(canvas, { atmosphereBehind: 'none', reduceTransparency: true })).toBe(opaqueChrome);
    });
    it('keeps a desktop overlay window clear regardless of the atmosphere', () => {
        expect(glassNavigationBackgroundColor(canvas, {}, true)).toBe('transparent');
    });
});
