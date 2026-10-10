import { describe, expect, it } from 'vitest';

import { glassPresetMaterials } from './glassMaterial';
import { resolveGlassSurfaceColor } from './useGlassSurfaceColor';

const liveDesktop = { desktopWindow: true, nativeWindowMaterialLive: true };
const settings = { glassSurfaceMaterials: glassPresetMaterials('everywhere') };

describe('glass renderer paint', () => {
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
        expect(resolveGlassSurfaceColor('#112233', 'content', settings, { ...liveDesktop, windowActive: false }, true)).toBe('#112233');
    });

    it('keeps SDK colors solid on platforms without a tint fallback', () => {
        expect(resolveGlassSurfaceColor('#112233', 'content', settings, liveDesktop, false)).toBe('#112233');
    });
});
