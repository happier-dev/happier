import { describe, expect, it } from 'vitest';

import { resolveNextJumpToBottomDistanceVisibilityState } from './jumpToBottomVisibilityDistanceState';
import { resolveJumpToBottomAffordanceState } from './jumpToBottomAffordanceState';

describe('resolveNextJumpToBottomDistanceVisibilityState', () => {
    it('preserves the distance transition that contradicts a stale renderer pin', () => {
        const distance = resolveNextJumpToBottomDistanceVisibilityState({
            previousCommittedDistance: 200,
            nextDistance: 2482,
            revealThresholdPx: 135,
            viewportHeightPx: 339,
        });
        expect(resolveJumpToBottomAffordanceState({
            distanceFromBottom: distance, enabled: true, isPinned: true,
            minNewActivityCount: 1, newActivityCount: 0,
            revealThresholdPx: 135, viewportHeightPx: 339,
        }).isVisible).toBe(true);
    });
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
