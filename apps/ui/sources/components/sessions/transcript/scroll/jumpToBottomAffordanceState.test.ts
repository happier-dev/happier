import { describe, expect, it } from 'vitest';

import { resolveJumpToBottomAffordanceState } from './jumpToBottomAffordanceState';

describe('resolveJumpToBottomAffordanceState', () => {
    it('stays hidden while pinned or disabled', () => {
        expect(resolveJumpToBottomAffordanceState({
            distanceFromBottom: 600,
            enabled: false,
            isPinned: false,
            minNewActivityCount: 1,
            newActivityCount: 3,
            revealThresholdPx: 500,
        }).isVisible).toBe(false);
        expect(resolveJumpToBottomAffordanceState({
            distanceFromBottom: 600,
            enabled: true,
            isPinned: true,
            minNewActivityCount: 1,
            newActivityCount: 3,
            revealThresholdPx: 500,
        }).isVisible).toBe(false);
    });

    it('keeps the full jump affordance hidden in the near-bottom dead-zone without new activity', () => {
        expect(resolveJumpToBottomAffordanceState({
            distanceFromBottom: 300,
            enabled: true,
            isPinned: false,
            minNewActivityCount: 1,
            newActivityCount: 0,
            revealThresholdPx: 600,
        })).toEqual({
            count: 0,
            isVisible: false,
            presentation: 'standard',
        });
    });

    it('shows a compact activity affordance in the near-bottom dead-zone when new activity arrives', () => {
        expect(resolveJumpToBottomAffordanceState({
            distanceFromBottom: 300,
            enabled: true,
            isPinned: false,
            minNewActivityCount: 1,
            newActivityCount: 2,
            revealThresholdPx: 600,
        })).toEqual({
            count: 2,
            isVisible: true,
            presentation: 'activity',
        });
    });

    it('shows the standard affordance past the reveal threshold', () => {
        expect(resolveJumpToBottomAffordanceState({
            distanceFromBottom: 700,
            enabled: true,
            isPinned: false,
            minNewActivityCount: 2,
            newActivityCount: 1,
            revealThresholdPx: 600,
        })).toEqual({
            count: 0,
            isVisible: true,
            presentation: 'standard',
        });
    });

    it('shows the standard affordance when a target window has newer live-tail content outside the rendered window', () => {
        expect(resolveJumpToBottomAffordanceState({
            distanceFromBottom: 0,
            enabled: true,
            hasMoreNewerBeyondRenderedWindow: true,
            isPinned: false,
            minNewActivityCount: 2,
            newActivityCount: 0,
            revealThresholdPx: 600,
        })).toEqual({
            count: 0,
            isVisible: true,
            presentation: 'standard',
        });
    });
});
