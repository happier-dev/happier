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

    it('shows the affordance when a stale pin claim is contradicted by physical distance', () => {
        // E-7. An explicit jump leaves the derived pin bit stale `true`, and `isPinned` was the
        // first thing consulted — so the ONLY escape from a 69,000px-deep window was silently
        // deleted. "Am I at the tail" has one answer: physical distance. More than a full
        // viewport from the tail is not "at the tail" no matter what the pin bit says.
        expect(resolveJumpToBottomAffordanceState({
            distanceFromBottom: 69_000,
            enabled: true,
            isPinned: true,
            minNewActivityCount: 1,
            newActivityCount: 0,
            revealThresholdPx: 300,
            viewportHeightPx: 600,
        })).toEqual({
            count: 0,
            isVisible: true,
            presentation: 'standard',
        });

        // Within one viewport the pin bit still owns the answer: renderer maintain-at-end and
        // the near-tail dead-zone are exactly the band where a pinned reader sees no pill.
        expect(resolveJumpToBottomAffordanceState({
            distanceFromBottom: 400,
            enabled: true,
            isPinned: true,
            minNewActivityCount: 1,
            newActivityCount: 0,
            revealThresholdPx: 300,
            viewportHeightPx: 600,
        }).isVisible).toBe(false);
    });

    it('shows the affordance in target-window mode with more-newer content regardless of local distance', () => {
        // A jump landing can sit at the RENDERED window's bottom edge (local dfb=0) while the
        // session tail is far below (hasMoreNewer). The affordance must offer the way back to
        // the live tail (live RG4 cold-route evidence: pill absent after a correct landing).
        expect(resolveJumpToBottomAffordanceState({
            distanceFromBottom: 0,
            enabled: true,
            hasMoreNewerBeyondRenderedWindow: true,
            isPinned: true,
            minNewActivityCount: 1,
            newActivityCount: 0,
            revealThresholdPx: 500,
        })).toEqual({
            count: 0,
            isVisible: true,
            presentation: 'standard',
        });
        expect(resolveJumpToBottomAffordanceState({
            distanceFromBottom: 0,
            enabled: false,
            hasMoreNewerBeyondRenderedWindow: true,
            isPinned: true,
            minNewActivityCount: 1,
            newActivityCount: 0,
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
