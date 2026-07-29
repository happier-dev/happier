import { describe, expect, it } from 'vitest';

import type { TranscriptNavigationAnchorCandidate } from './deriveCurrentTranscriptAnchor';
import { resolveRetainedTranscriptNavigationLandedAnchor } from './transcriptNavigationLandedAnchor';

const ANCHORS: readonly TranscriptNavigationAnchorCandidate[] = [
    { id: 'turn-1', kind: 'user-turn', sourceIndex: 1 },
    { id: 'turn-2', kind: 'user-turn', sourceIndex: 9 },
];

const LANDED = { anchorId: 'turn-2', sessionId: 'session-1' } as const;

describe('resolveRetainedTranscriptNavigationLandedAnchor', () => {
    it('retains the landing while the reader has not moved', () => {
        expect(resolveRetainedTranscriptNavigationLandedAnchor({
            anchors: ANCHORS,
            genuineUserMovement: false,
            landed: LANDED,
            sessionId: 'session-1',
        })).toEqual(LANDED);
    });

    it('releases the landing on genuine user movement', () => {
        expect(resolveRetainedTranscriptNavigationLandedAnchor({
            anchors: ANCHORS,
            genuineUserMovement: true,
            landed: LANDED,
            sessionId: 'session-1',
        })).toBeNull();
    });

    it('releases a landing inherited from another session', () => {
        expect(resolveRetainedTranscriptNavigationLandedAnchor({
            anchors: ANCHORS,
            genuineUserMovement: false,
            landed: LANDED,
            sessionId: 'session-2',
        })).toBeNull();
    });

    it('releases a landing whose anchor left the anchor set', () => {
        expect(resolveRetainedTranscriptNavigationLandedAnchor({
            anchors: [ANCHORS[0]!],
            genuineUserMovement: false,
            landed: LANDED,
            sessionId: 'session-1',
        })).toBeNull();
    });

    it('has nothing to retain without a landing', () => {
        expect(resolveRetainedTranscriptNavigationLandedAnchor({
            anchors: ANCHORS,
            genuineUserMovement: false,
            landed: null,
            sessionId: 'session-1',
        })).toBeNull();
    });
});
