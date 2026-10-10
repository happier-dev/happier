import { describe, expect, it } from 'vitest';
import { GlassSurfaceMaterialsSchema } from '@happier-dev/protocol';

import {
    GLASS_SURFACE_GROUPS, glassPresetMaterials, readGlassMaterials, readGlassPreset, resolveGlassPresetSettingsDelta,
    resolveGlassSurfaceMaterial, resolveGlassSurfaceSettingsDelta, resolveGlassIntensitySettingsDelta, resolveGlassBackdropTone,
} from './glassMaterial';

describe('glass material Account owner', () => {
    it('preserves a visible black-to-white backdrop band and does not desaturate enabled floating defaults', () => {
        for (const dark of [false, true]) {
            const tone = resolveGlassBackdropTone({}, 'floating', dark);
            const contrast = Number(/contrast\(([^)]+)\)/.exec(tone)?.[1]);
            const brightness = Number(/brightness\(([^)]+)\)/.exec(tone)?.[1]);
            const saturation = Number(/saturate\(([^)]+)\)/.exec(tone)?.[1]);
            // This is the owner-approved material range, not an incidental CSS spelling.
            const clamp = (value: number) => Math.min(1, Math.max(0, value));
            const curve = (value: number) => clamp(clamp(0.5 + (value - 0.5) * contrast) * brightness);
            expect((curve(1) - curve(0)) * (1 - glassPresetMaterials('auto').floating.opacity)).toBeGreaterThanOrEqual(0.25);
            expect(saturation).toBeGreaterThanOrEqual(1);
            // Owner-approved final curve makes the own-page lift subtler without narrowing its band.
            expect(contrast).toBe(0.55);
            expect(brightness).toBe(0.5);
        }
    });
    it('selects Clear with strong blur and low coats, round-trips through existing settings and preserves exact custom values', () => {
        const settings = { glassBlurIntensity: 'regular' as const };
        const clear = { ...settings, ...resolveGlassPresetSettingsDelta(settings, 'clear') };
        expect(readGlassPreset(clear)).toBe('clear');
        expect(clear.glassBlurIntensity).toBe('strong');
        for (const group of GLASS_SURFACE_GROUPS) {
            const material = readGlassMaterials(clear)[group];
            expect(material.blur).toBe('strong');
            expect(material.opacity).toBeGreaterThan(0);
            expect(material.opacity).toBeLessThanOrEqual(0.1);
        }
        expect(readGlassMaterials(clear).floating.opacity).toBe(0.02);
        const custom = { ...clear, ...resolveGlassSurfaceSettingsDelta(clear, 'floating', { opacity: 0.013 }) };
        expect(readGlassPreset(custom)).toBe('custom');
        expect(resolveGlassSurfaceMaterial(custom, 'floating').material.opacity).toBe(0.013);
        expect(resolveGlassSurfaceMaterial(clear, 'floating', { reduceTransparency: true }).material).toEqual({ blur: 'off', opacity: 1 });
        expect(readGlassPreset({})).toBe('auto');
    });
    it('reads predecessor off and all three intensity values without requiring a new table', () => {
        expect(readGlassPreset({ glassBlurEnabled: false, glassBlurIntensity: 'strong' })).toBe('solid');
        for (const glassBlurIntensity of ['light', 'regular', 'strong'] as const) {
            const materials = readGlassMaterials({ glassBlurEnabled: true, glassBlurIntensity });
            expect(materials.floating).toEqual({ blur: 'strong', opacity: 0.02 });
            expect(materials.chrome.blur).toBe(glassBlurIntensity);
            expect(materials.content.blur).toBe(glassBlurIntensity);
        }
    });

    it('defaults Auto to the layered W3 coats, not chrome-only or uniform Everywhere', () => {
        const materials = readGlassMaterials({});
        expect(materials.chrome).toEqual({ blur: 'regular', opacity: 0.70 });
        expect(materials.sidebar.opacity).toBeCloseTo(0.754);
        expect(materials.content).toEqual({ blur: 'regular', opacity: 0.84 });
        expect(materials.floating).toEqual({ blur: 'strong', opacity: 0.02 });
        expect(resolveGlassSurfaceMaterial({}, 'content', { desktopWindow: true, nativeWindowMaterialLive: true }).material)
            .toEqual(materials.content);
    });

    it('keeps custom transparency active even when every blur step is Off', () => {
        const start = { glassBlurEnabled: false };
        const custom = { ...start, ...resolveGlassSurfaceSettingsDelta(start, 'content', { opacity: 0 }) };
        expect(custom.glassBlurEnabled).toBe(true);
        expect(readGlassPreset(custom)).toBe('custom');
        expect(readGlassMaterials(custom).content).toEqual({ blur: 'off', opacity: 0 });
    });

    it('lets predecessor clients re-enable glass after a current client selected Solid', () => {
        const settings = { glassBlurEnabled: true, glassBlurIntensity: 'regular' as const };
        const solid = { ...settings, ...resolveGlassPresetSettingsDelta(settings, 'solid') };
        expect(readGlassPreset(solid)).toBe('solid');
        expect(readGlassPreset({ ...solid, glassBlurEnabled: true })).toBe('auto');
    });

    it('stores named tables and edits only the requested group, making the choice Custom', () => {
        const start = { glassBlurEnabled: true, glassBlurIntensity: 'regular' as const };
        const everywhere = { ...start, ...resolveGlassPresetSettingsDelta(start, 'everywhere') };
        expect(readGlassPreset(everywhere)).toBe('everywhere');
        expect(readGlassMaterials(everywhere).chrome).toEqual({ blur: 'regular', opacity: 0.70 });
        expect(readGlassMaterials(everywhere).floating).toEqual({ blur: 'strong', opacity: 0.02 });
        const custom = { ...everywhere, ...resolveGlassSurfaceSettingsDelta(everywhere, 'content', { opacity: 0, blur: 'strong' }) };
        expect(readGlassPreset(custom)).toBe('custom');
        expect(custom.glassSurfaceMaterials.floating).toEqual(everywhere.glassSurfaceMaterials?.floating);
        expect(resolveGlassSurfaceMaterial(custom, 'content', { desktopWindow: true, nativeWindowMaterialLive: true, highContrast: true }).material)
            .toEqual({ blur: 'strong', opacity: 0 });
    });

    it('keeps choice stored while Reduce Transparency and inactive windows temporarily resolve Solid', () => {
        const settings = { glassSurfaceMaterials: glassPresetMaterials('everywhere') };
        expect(resolveGlassSurfaceMaterial(settings, 'floating', { reduceTransparency: true })).toEqual({ material: { blur: 'off', opacity: 1 }, reason: 'reduceTransparency' });
        expect(resolveGlassSurfaceMaterial(settings, 'floating', { windowActive: false }).material.blur).toBe('off');
        expect(readGlassPreset(settings)).toBe('everywhere');
        expect(resolveGlassSurfaceMaterial(settings, 'floating').material.blur).toBe('strong');
    });

    it('resolves Auto per device and refuses to clear desktop fills before native material is live', () => {
        const settings = {};
        expect(resolveGlassSurfaceMaterial(settings, 'chrome').material.blur).toBe('off');
        expect(resolveGlassSurfaceMaterial(settings, 'chrome', { desktopWindow: true }).reason).toBe('unavailable');
        expect(resolveGlassSurfaceMaterial(settings, 'chrome', { desktopWindow: true, nativeWindowMaterialLive: true }).material.blur).toBe('regular');
        expect(resolveGlassSurfaceMaterial(settings, 'floating').material.blur).toBe('strong');
    });

    it('uses blur Off without discarding exact custom opacity on supported surfaces', () => {
        const settings = { glassSurfaceMaterials: { ...glassPresetMaterials('everywhere'), content: { blur: 'off' as const, opacity: 0.1 } } };
        expect(resolveGlassSurfaceMaterial(settings, 'content', { desktopWindow: true, nativeWindowMaterialLive: true }).material)
            .toEqual({ blur: 'off', opacity: 0.1 });
    });

    it('updates preset blur uniformly without overriding custom opacity', () => {
        const settings = { glassSurfaceMaterials: { ...glassPresetMaterials('everywhere'), floating: { blur: 'light' as const, opacity: 0.12 } } };
        const updated = resolveGlassIntensitySettingsDelta(settings, 'strong');
        expect(updated.glassSurfaceMaterials?.floating).toEqual({ blur: 'strong', opacity: 0.12 });
    });

    it('keeps every named floating preset clear and strongly frosted across intensity changes, leaving stored custom tables exact', () => {
        for (const preset of ['auto', 'everywhere', 'clear'] as const) {
            for (const intensity of ['light', 'regular', 'strong'] as const) {
                const settings = { glassBlurIntensity: intensity, ...resolveGlassPresetSettingsDelta({ glassBlurIntensity: intensity }, preset) };
                const updated = { ...settings, ...resolveGlassIntensitySettingsDelta(settings, intensity) };
                expect(readGlassPreset(updated)).toBe(preset);
                expect(resolveGlassSurfaceMaterial(updated, 'floating').material).toEqual({ blur: 'strong', opacity: 0.02 });
                expect(readGlassMaterials(updated).chrome.blur).toBe(intensity);
            }
        }
        const table = { ...glassPresetMaterials('everywhere'), floating: { blur: 'light' as const, opacity: 0.013 } };
        const custom = { glassSurfaceMaterials: table };
        expect(readGlassMaterials(custom)).toBe(table);
        expect(resolveGlassSurfaceMaterial(custom, 'floating').material).toBe(table.floating);
        expect(readGlassPreset(custom)).toBe('custom');
    });

    it('admits the full custom range while rejecting unknown material fields and invalid values', () => {
        expect(GlassSurfaceMaterialsSchema.safeParse({ ...glassPresetMaterials('everywhere'), content: { blur: 'strong', opacity: 0 } }).success).toBe(true);
        expect(GlassSurfaceMaterialsSchema.safeParse({ ...glassPresetMaterials('everywhere'), content: { blur: 'strong', opacity: -0.1 } }).success).toBe(false);
        expect(GlassSurfaceMaterialsSchema.safeParse({ ...glassPresetMaterials('everywhere'), extra: {} }).success).toBe(false);
    });
});
