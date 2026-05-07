import { describe, expect, it } from 'vitest';

import * as metrics from './petCompanionDisplayMetrics';

type OverlayMetrics = Readonly<{
    scale: number;
    spriteWidth: number;
    spriteHeight: number;
    windowWidth: number;
    windowHeight: number;
}>;

type MetricsModule = typeof metrics & Partial<{
    resolvePetCompanionOverlayMetrics: (sizeScale: unknown) => OverlayMetrics;
}>;

describe('petCompanionDisplayMetrics', () => {
    it('resolves default overlay metrics without changing existing pet dimensions', () => {
        const exportedMetrics: MetricsModule = metrics;

        expect(typeof exportedMetrics.resolvePetCompanionOverlayMetrics).toBe('function');
        if (!exportedMetrics.resolvePetCompanionOverlayMetrics) return;

        const resolved = exportedMetrics.resolvePetCompanionOverlayMetrics(undefined);

        expect(resolved.scale).toBeCloseTo(metrics.PET_COMPANION_OVERLAY_SCALE, 6);
        expect(resolved.spriteWidth).toBeCloseTo(92, 4);
        expect(resolved.spriteHeight).toBeCloseTo(99.6666666667, 4);
        expect(resolved.windowWidth).toBe(116);
        expect(resolved.windowHeight).toBe(124);
    });

    it('clamps and applies the local size multiplier to sprite and padded window metrics', () => {
        const exportedMetrics: MetricsModule = metrics;

        expect(typeof exportedMetrics.resolvePetCompanionOverlayMetrics).toBe('function');
        if (!exportedMetrics.resolvePetCompanionOverlayMetrics) return;

        const enlarged = exportedMetrics.resolvePetCompanionOverlayMetrics(1.5);
        const tooLarge = exportedMetrics.resolvePetCompanionOverlayMetrics(99);
        const tooSmall = exportedMetrics.resolvePetCompanionOverlayMetrics(0);

        expect(enlarged.spriteWidth).toBeCloseTo(138, 4);
        expect(enlarged.spriteHeight).toBeCloseTo(149.5, 4);
        expect(enlarged.windowWidth).toBe(162);
        expect(enlarged.windowHeight).toBe(174);
        expect(tooLarge).toEqual(enlarged);
        expect(tooSmall.spriteWidth).toBeCloseTo(69, 4);
        expect(tooSmall.windowWidth).toBe(93);
    });
});
