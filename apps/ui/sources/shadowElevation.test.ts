import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDarkShadowLevels, buildLightShadowLevels } from './shadowElevation';

describe('shadow elevation recipes', () => {
    it('keeps dark shadow recipes subtler than light recipes across the shared ladder', () => {
        const darkLevels = buildDarkShadowLevels();
        const lightLevels = buildLightShadowLevels();

        for (const level of [1, 2, 3, 4, 5] as const) {
            expect(darkLevels[level].shadowOpacity).toBeLessThan(lightLevels[level].shadowOpacity);
            expect(darkLevels[level].shadowRadius).toBeLessThanOrEqual(lightLevels[level].shadowRadius);
        }
    });
});

async function loadShadowElevationForPlatform(os: 'web' | 'ios' | 'android') {
    vi.resetModules();
    vi.doMock('react-native', () => ({
        Platform: { OS: os, select: (spec: Record<string, unknown>) => spec[os] ?? spec.default },
    }));
    return import('./shadowElevation');
}

describe('buildGlassCastShadowStyle', () => {
    afterEach(() => {
        vi.resetModules();
        vi.doUnmock('react-native');
    });

    it('uses the dedicated glass cast box-shadow token verbatim on web/android', async () => {
        const cast = '0px 8px 28px rgba(0, 0, 0, 0.07)';
        for (const os of ['web', 'android'] as const) {
            const mod = await loadShadowElevationForPlatform(os);
            const style = mod.buildGlassCastShadowStyle(mod.buildLightShadowLevels()[4], cast, false) as { boxShadow: string };
            expect(style.boxShadow).toBe(cast);
        }
    });

    it('uses soft (halved) native shadow props on iOS, ignoring the box-shadow token', async () => {
        const ios = await loadShadowElevationForPlatform('ios');
        const level = ios.buildLightShadowLevels()[4];
        const style = ios.buildGlassCastShadowStyle(level, '0px 8px 28px rgba(0, 0, 0, 0.07)', true) as {
            shadowOpacity: number; elevation: number; boxShadow?: string;
        };

        expect(style.shadowOpacity).toBeCloseTo(level.shadowOpacity * 0.5);
        expect(style.elevation).toBe(0);
        expect(style.boxShadow).toBeUndefined();
    });

    it('keeps the dark glass cast shadow stronger than light (black shadow on dark needs more alpha)', async () => {
        const mod = await loadShadowElevationForPlatform('web');
        const alpha = (s: string) => Number(s.match(/rgba\([^)]*,\s*([\d.]+)\)/)![1]);
        expect(alpha(mod.buildGlassCastShadow(true))).toBeGreaterThan(alpha(mod.buildGlassCastShadow(false)));
    });
});

describe('buildGlassInnerShadow opacity scale', () => {
    afterEach(() => {
        vi.resetModules();
        vi.doUnmock('react-native');
    });

    const alpha = (s: string) => Number(s.match(/rgba\([^)]*,\s*([\d.]+)\)/)![1]);

    it('is byte-identical at the default scale (shared glass surfaces are unchanged)', async () => {
        const mod = await loadShadowElevationForPlatform('web');
        expect(mod.buildGlassInnerShadow(false, 1)).toBe(mod.buildGlassInnerShadow(false));
        expect(mod.buildGlassInnerShadow(true, 1)).toBe(mod.buildGlassInnerShadow(true));
    });

    it('fades the inset alpha when scaled below 1 (composer-only fainter recess)', async () => {
        const mod = await loadShadowElevationForPlatform('web');
        for (const dark of [false, true]) {
            const faded = alpha(mod.buildGlassInnerShadow(dark, 0.7));
            expect(faded).toBeGreaterThan(0);
            expect(faded).toBeLessThan(alpha(mod.buildGlassInnerShadow(dark)));
        }
    });
});
