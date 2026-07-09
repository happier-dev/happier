import { describe, expect, it } from 'vitest';

import {
    resolveTranscriptNavigationRailMarkerMotion,
    resolveTranscriptNavigationRailMotionUpdateIndexes,
    stepTranscriptNavigationRailMarkerMotion,
} from './resolveTranscriptNavigationRailMotion';

describe('resolveTranscriptNavigationRailMarkerMotion', () => {
    it('uses a smooth symmetric falloff around the focused marker', () => {
        const focused = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 10,
            markerIndex: 10,
            reducedMotion: false,
            visible: false,
        });
        const neighbor = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 10,
            markerIndex: 11,
            reducedMotion: false,
            visible: false,
        });
        const symmetricNeighbor = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 10,
            markerIndex: 9,
            reducedMotion: false,
            visible: false,
        });
        const far = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 10,
            markerIndex: 18,
            reducedMotion: false,
            visible: false,
        });

        expect(focused.widthPx).toBeGreaterThan(neighbor.widthPx);
        expect(neighbor.widthPx).toBeGreaterThan(far.widthPx);
        expect(neighbor.widthPx).toBeCloseTo(symmetricNeighbor.widthPx, 3);
        // Markers beyond the update window rest exactly, so focus changes only
        // restyle the bounded falloff window (no all-marker churn).
        expect(far.widthPx).toBe(3);
        expect(far.translateYPx).toBe(0);
    });

    it('keeps active and visible marker opacity above their floors', () => {
        expect(resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: 3,
            focusIndex: null,
            markerIndex: 3,
            reducedMotion: false,
            visible: false,
        }).opacity).toBeGreaterThanOrEqual(0.86);
        expect(resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: null,
            markerIndex: 3,
            reducedMotion: false,
            visible: true,
        }).opacity).toBeGreaterThanOrEqual(0.54);
    });

    it('uses static width and translation for reduced motion while preserving visibility opacity', () => {
        const focused = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 3,
            markerIndex: 3,
            reducedMotion: true,
            visible: true,
        });
        const far = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 3,
            markerIndex: 12,
            reducedMotion: true,
            visible: false,
        });

        expect(focused.widthPx).toBe(far.widthPx);
        expect(focused.translateYPx).toBe(0);
        expect(focused.opacity).toBeGreaterThan(far.opacity);
    });

    it('returns finite safe styles for invalid input', () => {
        const style = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: Number.NaN,
            focusIndex: Number.POSITIVE_INFINITY,
            markerIndex: Number.NaN,
            reducedMotion: false,
            visible: false,
        });

        expect(Number.isFinite(style.widthPx)).toBe(true);
        expect(Number.isFinite(style.opacity)).toBe(true);
        expect(Number.isFinite(style.translateYPx)).toBe(true);
    });

    it('glides toward the target over multiple steps instead of snapping', () => {
        const rest = { opacity: 0.28, translateYPx: 0, widthPx: 3 } as const;
        const target = { opacity: 0.7, translateYPx: -1.5, widthPx: 16 } as const;

        const first = stepTranscriptNavigationRailMarkerMotion(rest, target);
        expect(first.settled).toBe(false);
        expect(first.motion.widthPx).toBeGreaterThan(rest.widthPx);
        expect(first.motion.widthPx).toBeLessThan(target.widthPx);
        expect(first.motion.opacity).toBeGreaterThan(rest.opacity);
        expect(first.motion.opacity).toBeLessThan(target.opacity);

        const second = stepTranscriptNavigationRailMarkerMotion(first.motion, target);
        expect(second.motion.widthPx).toBeGreaterThan(first.motion.widthPx);
        expect(second.motion.widthPx).toBeLessThan(target.widthPx);
    });

    it('settles exactly on the target within a bounded number of steps', () => {
        const target = { opacity: 0.9, translateYPx: 0, widthPx: 16 } as const;
        let current = { opacity: 0.28, translateYPx: 2, widthPx: 3 };
        let settled = false;
        let steps = 0;

        while (!settled && steps < 120) {
            const next = stepTranscriptNavigationRailMarkerMotion(current, target);
            current = { ...next.motion };
            settled = next.settled;
            steps += 1;
        }

        expect(settled).toBe(true);
        expect(steps).toBeLessThan(60);
        expect(current).toEqual(target);
    });

    it('snaps immediately with full smoothing or a missing current value', () => {
        const target = { opacity: 0.7, translateYPx: -1, widthPx: 16 } as const;

        const snapped = stepTranscriptNavigationRailMarkerMotion(
            { opacity: 0.28, translateYPx: 0, widthPx: 3 },
            target,
            1,
        );
        expect(snapped.settled).toBe(true);
        expect(snapped.motion).toEqual(target);

        const fromNull = stepTranscriptNavigationRailMarkerMotion(null, target);
        expect(fromNull.settled).toBe(true);
        expect(fromNull.motion).toEqual(target);
    });

    it('recovers to the target from non-finite current values and smoothing', () => {
        const target = { opacity: 0.7, translateYPx: 0, widthPx: 16 } as const;

        const fromBroken = stepTranscriptNavigationRailMarkerMotion(
            { opacity: Number.NaN, translateYPx: Number.POSITIVE_INFINITY, widthPx: 3 },
            target,
        );
        expect(fromBroken.settled).toBe(true);
        expect(fromBroken.motion).toEqual(target);

        const brokenSmoothing = stepTranscriptNavigationRailMarkerMotion(
            { opacity: 0.28, translateYPx: 0, widthPx: 3 },
            target,
            Number.NaN,
        );
        expect(brokenSmoothing.settled).toBe(true);
        expect(brokenSmoothing.motion).toEqual(target);
    });

    it('bounds pointer-focus style updates to the previous and next falloff windows', () => {
        const indexes = resolveTranscriptNavigationRailMotionUpdateIndexes({
            markerCount: 1000,
            nextFocusIndex: 505,
            previousFocusIndex: 500,
            radius: 4,
        });

        expect(indexes).toContain(500);
        expect(indexes).toContain(505);
        expect(indexes).toContain(501);
        expect(indexes).toContain(509);
        expect(indexes).not.toContain(0);
        expect(indexes).not.toContain(999);
        expect(indexes.length).toBeLessThanOrEqual(18);
    });
});
