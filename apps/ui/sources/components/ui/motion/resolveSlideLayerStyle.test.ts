import { describe, expect, it } from 'vitest';

import { resolveSlideLayerStyle } from './resolveSlideLayerStyle';

const DISTANCE = 100;
const MAX_BLUR = 12;

describe('resolveSlideLayerStyle (pure worklet helper, JS-callable)', () => {
    describe('current role', () => {
        it('sits centered with full opacity at progress=0', () => {
            const style = resolveSlideLayerStyle({ role: 'current', progress: 0, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(style.translateX).toBe(0);
            expect(style.opacity).toBe(1);
            expect(style.blurPx).toBe(0);
        });

        it('translates right by half-distance and halves opacity at progress=+0.5', () => {
            const style = resolveSlideLayerStyle({ role: 'current', progress: 0.5, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(style.translateX).toBe(50);
            expect(style.opacity).toBeCloseTo(0.5);
            expect(style.blurPx).toBeCloseTo(MAX_BLUR);
        });

        it('translates left by half-distance and halves opacity at progress=-0.5', () => {
            const style = resolveSlideLayerStyle({ role: 'current', progress: -0.5, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(style.translateX).toBe(-50);
            expect(style.opacity).toBeCloseTo(0.5);
            expect(style.blurPx).toBeCloseTo(MAX_BLUR);
        });

        it('slides fully right and fades out at progress=+1', () => {
            const style = resolveSlideLayerStyle({ role: 'current', progress: 1, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(style.translateX).toBe(DISTANCE);
            expect(style.opacity).toBe(0);
            expect(style.blurPx).toBe(0);
        });

        it('slides fully left and fades out at progress=-1', () => {
            const style = resolveSlideLayerStyle({ role: 'current', progress: -1, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(style.translateX).toBe(-DISTANCE);
            expect(style.opacity).toBe(0);
            expect(style.blurPx).toBe(0);
        });
    });

    describe('previous role', () => {
        it('sits off-screen left with zero opacity at progress=0', () => {
            const style = resolveSlideLayerStyle({ role: 'previous', progress: 0, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(style.translateX).toBe(-DISTANCE);
            expect(style.opacity).toBe(0);
            expect(style.blurPx).toBe(0);
        });

        it('slides in toward center as progress goes positive (progress=+0.5)', () => {
            const style = resolveSlideLayerStyle({ role: 'previous', progress: 0.5, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(style.translateX).toBe(-50);
            expect(style.opacity).toBeCloseTo(0.5);
            expect(style.blurPx).toBeCloseTo(MAX_BLUR);
        });

        it('reaches center with full opacity at progress=+1', () => {
            const style = resolveSlideLayerStyle({ role: 'previous', progress: 1, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(style.translateX).toBe(0);
            expect(style.opacity).toBe(1);
            expect(style.blurPx).toBe(0);
        });

        it('stays clamped to 0 opacity for negative progress', () => {
            const style = resolveSlideLayerStyle({ role: 'previous', progress: -0.5, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(style.opacity).toBe(0);
        });
    });

    describe('next role', () => {
        it('sits off-screen right with zero opacity at progress=0', () => {
            const style = resolveSlideLayerStyle({ role: 'next', progress: 0, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(style.translateX).toBe(DISTANCE);
            expect(style.opacity).toBe(0);
            expect(style.blurPx).toBe(0);
        });

        it('slides in toward center as progress goes negative (progress=-0.5)', () => {
            const style = resolveSlideLayerStyle({ role: 'next', progress: -0.5, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(style.translateX).toBe(50);
            expect(style.opacity).toBeCloseTo(0.5);
            expect(style.blurPx).toBeCloseTo(MAX_BLUR);
        });

        it('reaches center with full opacity at progress=-1', () => {
            const style = resolveSlideLayerStyle({ role: 'next', progress: -1, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(style.translateX).toBe(0);
            expect(style.opacity).toBe(1);
            expect(style.blurPx).toBe(0);
        });

        it('stays clamped to 0 opacity for positive progress', () => {
            const style = resolveSlideLayerStyle({ role: 'next', progress: 0.5, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(style.opacity).toBe(0);
        });
    });

    describe('blur disabled (maxBlur=0)', () => {
        it('returns blurPx=0 for every role at every non-extreme progress', () => {
            for (const role of ['previous', 'current', 'next'] as const) {
                for (const progress of [-1, -0.5, 0, 0.5, 1]) {
                    const style = resolveSlideLayerStyle({ role, progress, distance: DISTANCE, maxBlur: 0 });
                    expect(style.blurPx).toBe(0);
                }
            }
        });
    });

    describe('blur curve peaks at midpoint', () => {
        it('returns 0 blur at progress=0 and progress=±1', () => {
            const center = resolveSlideLayerStyle({ role: 'current', progress: 0, distance: DISTANCE, maxBlur: MAX_BLUR });
            const right = resolveSlideLayerStyle({ role: 'current', progress: 1, distance: DISTANCE, maxBlur: MAX_BLUR });
            const left = resolveSlideLayerStyle({ role: 'current', progress: -1, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(center.blurPx).toBe(0);
            expect(right.blurPx).toBe(0);
            expect(left.blurPx).toBe(0);
        });

        it('returns max blur at progress=±0.5', () => {
            const right = resolveSlideLayerStyle({ role: 'current', progress: 0.5, distance: DISTANCE, maxBlur: MAX_BLUR });
            const left = resolveSlideLayerStyle({ role: 'current', progress: -0.5, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(right.blurPx).toBeCloseTo(MAX_BLUR);
            expect(left.blurPx).toBeCloseTo(MAX_BLUR);
        });

        it('returns half blur at progress=±0.25 (linear ramp up)', () => {
            const right = resolveSlideLayerStyle({ role: 'current', progress: 0.25, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(right.blurPx).toBeCloseTo(MAX_BLUR / 2);
        });

        it('returns half blur at progress=±0.75 (linear ramp down)', () => {
            const right = resolveSlideLayerStyle({ role: 'current', progress: 0.75, distance: DISTANCE, maxBlur: MAX_BLUR });
            expect(right.blurPx).toBeCloseTo(MAX_BLUR / 2);
        });
    });
});
