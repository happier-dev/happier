import { describe, expect, it } from 'vitest';

import { resolveNextJumpToBottomDistanceVisibilityState } from './jumpToBottomVisibilityDistanceState';

describe('resolveNextJumpToBottomDistanceVisibilityState', () => {
    it('reuses committed state while scroll movement stays on the same side of the reveal threshold', () => {
        expect(resolveNextJumpToBottomDistanceVisibilityState({
            previousCommittedDistance: 900,
            nextDistance: 1200,
            revealThresholdPx: 600,
        })).toBe(900);
        expect(resolveNextJumpToBottomDistanceVisibilityState({
            previousCommittedDistance: 0,
            nextDistance: 320,
            revealThresholdPx: 600,
        })).toBe(0);
    });

    it('commits only visibility transitions across the reveal threshold', () => {
        expect(resolveNextJumpToBottomDistanceVisibilityState({
            previousCommittedDistance: 0,
            nextDistance: 700,
            revealThresholdPx: 600,
        })).toBe(700);
        expect(resolveNextJumpToBottomDistanceVisibilityState({
            previousCommittedDistance: 700,
            nextDistance: 10,
            revealThresholdPx: 600,
        })).toBe(0);
    });
});
