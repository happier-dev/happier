import { describe, expect, it } from 'vitest';
import { GlassSurfaceMaterialsSchema } from '@happier-dev/protocol';

import {
    glassPresetMaterials, readGlassMaterials, readGlassPreset, resolveGlassPresetSettingsDelta,
    resolveGlassSurfaceMaterial, resolveGlassSurfaceSettingsDelta, resolveGlassIntensitySettingsDelta,
} from './glassMaterial';

describe('glass material Account owner', () => {
    it('reads predecessor off and all three intensity values without requiring a new table', () => {
        expect(readGlassPreset({ glassBlurEnabled: false, glassBlurIntensity: 'strong' })).toBe('solid');
        for (const glassBlurIntensity of ['light', 'regular', 'strong'] as const) {
            const materials = readGlassMaterials({ glassBlurEnabled: true, glassBlurIntensity });
            expect(materials.floating.blur).toBe(glassBlurIntensity);
            expect(materials.chrome.blur).toBe(glassBlurIntensity);
            expect(materials.content.blur).toBe(glassBlurIntensity);
        }
    });

    it('defaults Auto to the layered W3 coats, not chrome-only or uniform Everywhere', () => {
        const materials = readGlassMaterials({});
        expect(materials.chrome).toEqual({ blur: 'regular', opacity: 0.70 });
        expect(materials.sidebar.opacity).toBeCloseTo(0.754);
        expect(materials.content).toEqual({ blur: 'regular', opacity: 0.84 });
        expect(materials.floating.opacity).toBe(0.90);
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
        expect(new Set(Object.values(readGlassMaterials(everywhere)).map(material => JSON.stringify(material))).size).toBe(1);
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
        expect(resolveGlassSurfaceMaterial(settings, 'floating').material.blur).toBe('regular');
    });

    it('resolves Auto per device and refuses to clear desktop fills before native material is live', () => {
        const settings = {};
        expect(resolveGlassSurfaceMaterial(settings, 'chrome').material.blur).toBe('off');
        expect(resolveGlassSurfaceMaterial(settings, 'chrome', { desktopWindow: true }).reason).toBe('unavailable');
        expect(resolveGlassSurfaceMaterial(settings, 'chrome', { desktopWindow: true, nativeWindowMaterialLive: true }).material.blur).toBe('regular');
        expect(resolveGlassSurfaceMaterial(settings, 'floating').material.blur).toBe('regular');
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

    it('admits the full custom range while rejecting unknown material fields and invalid values', () => {
        expect(GlassSurfaceMaterialsSchema.safeParse({ ...glassPresetMaterials('everywhere'), content: { blur: 'strong', opacity: 0 } }).success).toBe(true);
        expect(GlassSurfaceMaterialsSchema.safeParse({ ...glassPresetMaterials('everywhere'), content: { blur: 'strong', opacity: -0.1 } }).success).toBe(false);
        expect(GlassSurfaceMaterialsSchema.safeParse({ ...glassPresetMaterials('everywhere'), extra: {} }).success).toBe(false);
    });
});
