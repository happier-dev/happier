import { describe, expect, it } from 'vitest';

import { resolveJumpToBottomAffordanceState } from './jumpToBottomAffordanceState';
import { reduceTranscriptScrollPinState, type TranscriptScrollPinState } from './transcriptBottomFollowMode';

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

    it('follows the renderer at-end watermark for detach, unseen-count, and reset transitions', () => {
        const initial: TranscriptScrollPinState = {
            isPinned: true,
            lastActivityKey: null,
            newActivityCount: 0,
        };
        const detached = reduceTranscriptScrollPinState(initial, {
            type: 'rendererAtEnd',
            enabled: true,
            isAtEnd: false,
        });
        const withUnseen = reduceTranscriptScrollPinState(detached, {
            type: 'newActivity',
            enabled: true,
            activityKey: 'm1',
        });

        expect(resolveJumpToBottomAffordanceState({
            distanceFromBottom: 300,
            enabled: true,
            isPinned: withUnseen.isPinned,
            minNewActivityCount: 1,
            newActivityCount: withUnseen.newActivityCount,
            revealThresholdPx: 600,
        })).toEqual({
            count: 1,
            isVisible: true,
            presentation: 'activity',
        });

        const reachedTail = reduceTranscriptScrollPinState(withUnseen, {
            type: 'rendererAtEnd',
            enabled: true,
            isAtEnd: true,
        });
        expect(resolveJumpToBottomAffordanceState({
            distanceFromBottom: 0,
            enabled: true,
            isPinned: reachedTail.isPinned,
            minNewActivityCount: 1,
            newActivityCount: reachedTail.newActivityCount,
            revealThresholdPx: 600,
        })).toEqual({
            count: 0,
            isVisible: false,
            presentation: 'standard',
        });
    });
});
