import { describe, expect, it } from 'vitest';

import {
    SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX,
    SESSION_LATERAL_SWIPE_COMMIT_VELOCITY_PX_PER_S,
    SESSION_LATERAL_SWIPE_CONTENT_TRAVEL_PX,
    resolveSessionLateralSwipeCommitDirection,
    resolveSessionLateralSwipeContentMotion,
    resolveSessionLateralSwipeEdgeHitSlop,
    resolveSessionLateralSwipeProgress,
} from './sessionLateralSwipeMotion';

const BOTH_NEIGHBOURS = { canStepPrevious: true, canStepNext: true } as const;

describe('resolveSessionLateralSwipeProgress', () => {
    it('maps a left drag to negative progress and a right drag to positive progress', () => {
        const next = resolveSessionLateralSwipeProgress({ translationX: -SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX, ...BOTH_NEIGHBOURS });
        const previous = resolveSessionLateralSwipeProgress({ translationX: SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX, ...BOTH_NEIGHBOURS });

        expect(next).toBeCloseTo(-1, 5);
        expect(previous).toBeCloseTo(1, 5);
    });

    it('clamps travel past the commit distance so the capsule never runs away from the finger', () => {
        const progress = resolveSessionLateralSwipeProgress({
            translationX: SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX * 4,
            ...BOTH_NEIGHBOURS,
        });

        expect(progress).toBe(1);
    });

    it('rubber-bands at an edge with progressive resistance instead of a dead stop', () => {
        const near = resolveSessionLateralSwipeProgress({
            translationX: SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX,
            canStepPrevious: false,
            canStepNext: true,
        });
        const far = resolveSessionLateralSwipeProgress({
            translationX: SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX * 4,
            canStepPrevious: false,
            canStepNext: true,
        });

        // Still moves (not a dead stop), never reaches the commit point, and the
        // second half of the drag buys strictly less travel than the first.
        expect(near).toBeGreaterThan(0);
        expect(far).toBeGreaterThan(near);
        expect(far).toBeLessThan(1);
        expect(far - near).toBeLessThan(near);
    });
});

describe('resolveSessionLateralSwipeCommitDirection', () => {
    it('does not commit a release below the distance and velocity thresholds', () => {
        expect(resolveSessionLateralSwipeCommitDirection({
            translationX: -20,
            velocityX: -10,
            ...BOTH_NEIGHBOURS,
        })).toBeNull();
    });

    it('commits to the next session on a left drag past the distance threshold', () => {
        expect(resolveSessionLateralSwipeCommitDirection({
            translationX: -SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX,
            velocityX: 0,
            ...BOTH_NEIGHBOURS,
        })).toBe('next');
    });

    it('commits to the previous session on a short but fast right flick', () => {
        expect(resolveSessionLateralSwipeCommitDirection({
            translationX: 24,
            velocityX: SESSION_LATERAL_SWIPE_COMMIT_VELOCITY_PX_PER_S,
            ...BOTH_NEIGHBOURS,
        })).toBe('previous');
    });

    it('ignores a fast flick whose velocity opposes the drag', () => {
        expect(resolveSessionLateralSwipeCommitDirection({
            translationX: 24,
            velocityX: -SESSION_LATERAL_SWIPE_COMMIT_VELOCITY_PX_PER_S * 4,
            ...BOTH_NEIGHBOURS,
        })).toBeNull();
    });

    it('never commits toward a missing neighbour', () => {
        expect(resolveSessionLateralSwipeCommitDirection({
            translationX: -SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX * 3,
            velocityX: -2000,
            canStepPrevious: true,
            canStepNext: false,
        })).toBeNull();
    });
});

describe('resolveSessionLateralSwipeEdgeHitSlop', () => {
    it('keeps the pan out of the iOS interactive-pop strip on the leading edge only', () => {
        const slop = resolveSessionLateralSwipeEdgeHitSlop('ios');

        expect(slop.left).toBeLessThan(0);
        expect(slop.right).toBe(0);
    });

    it('keeps the pan out of both Android system-back strips', () => {
        const slop = resolveSessionLateralSwipeEdgeHitSlop('android');

        expect(slop.left).toBeLessThan(0);
        expect(slop.right).toBeLessThan(0);
    });
});

describe('resolveSessionLateralSwipeContentMotion', () => {
    it('sends the session content the way the finger is going, and recedes it as the swipe deepens', () => {
        const towardNext = resolveSessionLateralSwipeContentMotion({ progress: -1, reducedMotion: false });
        const towardPrevious = resolveSessionLateralSwipeContentMotion({ progress: 1, reducedMotion: false });

        expect(towardNext.translateX).toBe(-SESSION_LATERAL_SWIPE_CONTENT_TRAVEL_PX);
        expect(towardPrevious.translateX).toBe(SESSION_LATERAL_SWIPE_CONTENT_TRAVEL_PX);
        expect(towardNext.scale).toBeCloseTo(0.985, 5);
        expect(towardNext.scale).toBeCloseTo(towardPrevious.scale, 5);
    });

    it('scales the recede with how far the swipe has travelled', () => {
        const half = resolveSessionLateralSwipeContentMotion({ progress: 0.5, reducedMotion: false });

        expect(half.translateX).toBeCloseTo(SESSION_LATERAL_SWIPE_CONTENT_TRAVEL_PX / 2, 5);
        expect(half.opacity).toBeCloseTo(0.725, 5);
        expect(half.scale).toBeCloseTo(0.9925, 5);
    });

    it('leaves the content fully present at rest', () => {
        expect(resolveSessionLateralSwipeContentMotion({ progress: 0, reducedMotion: false }))
            .toEqual({ translateX: 0, scale: 1, opacity: 1 });
    });

    it('never fades a hydrated session toward blank, at any reachable depth', () => {
        for (const progress of [-1, -0.75, 0.75, 1]) {
            expect(resolveSessionLateralSwipeContentMotion({ progress, reducedMotion: false }).opacity)
                .toBeGreaterThan(0.4);
        }
    });

    it('drops travel and scale under reduced motion while still dimming toward the destination', () => {
        const reduced = resolveSessionLateralSwipeContentMotion({ progress: 0.5, reducedMotion: true });

        expect(reduced.translateX).toBe(0);
        expect(reduced.scale).toBe(1);
        expect(reduced.opacity).toBeCloseTo(0.725, 5);
    });
});
