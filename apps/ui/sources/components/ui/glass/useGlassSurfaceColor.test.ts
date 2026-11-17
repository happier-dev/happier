import { describe, expect, it } from 'vitest';
import Color from 'color';

import { glassPresetMaterials, resolveGlassBackdropMap } from './glassMaterial';
import { resolveGlassSurfaceColor, resolveGlassSurfacePaint } from './useGlassSurfaceColor';

const liveDesktop = { desktopWindow: true, nativeWindowMaterialLive: true };
const settings = { glassSurfaceMaterials: glassPresetMaterials('everywhere') };

describe('glass renderer paint', () => {
    it('keeps solid source, derives alpha from its input and attributes an alternate inner coat to that coat', () => {
        const fill = { color: '#112233', source: { kind: 'token' as const, ref: 'control.input.background' } };
        const inner = { color: 'rgba(235, 230, 225, 0.1)', source: { kind: 'token' as const, ref: 'surface.selected' } };
        const solid = { glassSurfaceMaterials: glassPresetMaterials('solid') };
        expect(resolveGlassSurfacePaint(fill, 'content', solid, liveDesktop, true)).toEqual(fill);
        const alpha = resolveGlassSurfacePaint(fill, 'content', settings, liveDesktop, true, false);
        expect(alpha.color).toBe(resolveGlassSurfaceColor(fill.color, 'content', settings, liveDesktop, true, false));
        expect(alpha.source).toEqual({ kind: 'derived', from: ['control.input.background'] });
        expect(resolveGlassSurfacePaint(fill, 'content', settings, liveDesktop, true, true, inner)).toEqual(inner);
        expect(resolveGlassSurfacePaint(fill, 'content', settings,
            { ...liveDesktop, atmosphereBehind: 'wallpaper' }, true, false, undefined, true))
            .toEqual({ color: 'transparent', source: { kind: 'fixed' } });
    });
    it('carries a feasible saturated coat into independent paint while nested and solid paint keep their decisions', () => {
        const settings = { glassSurfaceMaterials: glassPresetMaterials('auto'), glassTintIntensity: 50 };
        const map = resolveGlassBackdropMap(settings, 'floating', true, {}, { page: 'rgb(20,10,10)', solid: 'rgb(100,20,20)' });
        expect(map?.opacity).toBeGreaterThan(0.02);
        const color = resolveGlassSurfaceColor(map!.coat!, 'floating', settings, {}, true, false, undefined, false, map!.opacity);
        expect(Color(color).alpha()).toBeCloseTo(map!.opacity!, 2);
        expect(Color(resolveGlassSurfaceColor(map!.coat!, 'floating', settings, {}, true, true, undefined, false, map!.opacity)).alpha()).toBe(0);
        expect(resolveGlassSurfaceColor('rgb(100,20,20)', 'floating', settings, { reduceTransparency: true }, true, false, undefined, false, map!.opacity)).toBe('rgb(100,20,20)');
    });
    it('clears only the content plane over atmosphere while retaining surface materials and solid fallback decisions', () => {
        for (const preset of ['solid', 'auto', 'everywhere', 'clear', 'custom'] as const) {
            const settings = { glassSurfaceMaterials: preset === 'custom'
                ? { ...glassPresetMaterials('everywhere'), content: { blur: 'off' as const, opacity: 0.347 } }
                : glassPresetMaterials(preset) };
            for (const overrides of [{}, { reduceTransparency: true }]) {
                const environment = { ...liveDesktop, ...overrides };
                const ordinary = resolveGlassSurfaceColor('#112233', 'content', settings, environment, true, false);
                expect(resolveGlassSurfaceColor('#112233', 'content', settings, { ...environment, atmosphereBehind: 'none' }, true, false, undefined, true)).toBe(ordinary);
                for (const atmosphereBehind of ['band', 'wallpaper'] as const) {
                    const behind = { ...environment, atmosphereBehind };
                    expect(resolveGlassSurfaceColor('#112233', 'content', settings, behind, true, false, undefined, true)).toBe('transparent');
                    // Renderer-owned terminal/editor page grounds inherit the same clear coat.
                    expect(resolveGlassSurfaceColor('#112233', 'content', settings, behind, true)).toBe('transparent');
                    expect(resolveGlassSurfaceColor('#112233', 'content', settings, behind, true, false)).toBe(ordinary);
                    expect(resolveGlassSurfaceColor('#112233', 'sidebar', settings, behind, true, false, undefined, true))
                        .toBe(resolveGlassSurfaceColor('#112233', 'sidebar', settings, environment, true, false));
                }
            }
        }
    });
    it('keeps descendant ink paint translucent in every glass group and restores exact solid paint', () => {
        for (const group of ['chrome', 'sidebar', 'content', 'floating'] as const) {
            expect(resolveGlassSurfaceColor('#112233', group, settings, liveDesktop, true, true, 'rgba(235, 230, 225, 0.1)')).toBe('rgba(235, 230, 225, 0.1)');
            expect(resolveGlassSurfaceColor('#112233', group, settings, { ...liveDesktop, reduceTransparency: true }, true, true, 'rgba(235, 230, 225, 0.1)')).toBe('#112233');
            expect(resolveGlassSurfaceColor('rgba(20, 30, 40, 0.07)', group, settings, liveDesktop, true, true, 'rgba(235, 230, 225, 0.1)')).toBe('rgba(20, 30, 40, 0.07)');
        }
    });

    it('clears nested terminal/editor coats while keeping the containing content coat exact', () => {
        const custom = { glassSurfaceMaterials: { ...settings.glassSurfaceMaterials, content: { blur: 'strong' as const, opacity: 0.125 } } };
        expect(resolveGlassSurfaceColor('#112233', 'content', custom, liveDesktop, true)).toBe('#11223300');
        expect(resolveGlassSurfaceColor('#112233', 'content', custom, liveDesktop, true, false)).toBe('#11223320');
        expect(resolveGlassSurfaceColor('rgba(17, 34, 51, 0.5)', 'content', custom, liveDesktop, true, false)).toBe('#11223310');
        const transparent = { glassSurfaceMaterials: { ...custom.glassSurfaceMaterials, content: { blur: 'strong' as const, opacity: 0 } } };
        expect(resolveGlassSurfaceColor('#112233', 'content', transparent, liveDesktop, true, false)).toBe('#11223300');
    });

    it('restores solid SDK paint for full opacity and canonical accessibility/availability decisions', () => {
        const solid = { glassSurfaceMaterials: glassPresetMaterials('solid') };
        expect(resolveGlassSurfaceColor('#112233', 'content', solid, liveDesktop, true)).toBe('#112233');
        expect(resolveGlassSurfaceColor('#112233', 'content', settings, { ...liveDesktop, reduceTransparency: true }, true)).toBe('#112233');
        expect(resolveGlassSurfaceColor('#112233', 'content', settings, { desktopWindow: true }, true)).toBe('#112233');
    });

    it('keeps SDK colors solid on platforms without a tint fallback', () => {
        expect(resolveGlassSurfaceColor('#112233', 'content', settings, liveDesktop, false)).toBe('#112233');
    });
});
