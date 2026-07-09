import { describe, expect, it } from 'vitest';

import { deriveCurrentTranscriptAnchor } from './deriveCurrentTranscriptAnchor';

const anchors = [
    { id: 'turn-1', kind: 'user-turn', sourceIndex: 0 },
    { id: 'pin-a', kind: 'pinned-assistant', sourceIndex: 2 },
    { id: 'turn-2', kind: 'user-turn', sourceIndex: 3 },
    { id: 'pin-tool', kind: 'pinned-tool', sourceIndex: 4 },
] as const;

describe('deriveCurrentTranscriptAnchor', () => {
    it('uses the top visible anchor id when the host reports an exact row', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors,
            topVisibleAnchorId: 'turn-2',
            visibleAnchorIds: ['pin-a', 'turn-2'],
        })).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['pin-a', 'turn-2'],
        });
    });

    it('uses the exact top visible anchor even before a full visible-id list is available', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors,
            topVisibleAnchorId: 'turn-2',
        })).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['turn-2'],
        });
    });

    it('derives visible anchors from a canonical source range when exact row ids are unavailable', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors,
            visibleSourceRange: { firstSourceIndex: 2, lastSourceIndex: 4 },
        })).toEqual({
            currentAnchorId: 'pin-a',
            visibleAnchorIds: ['pin-a', 'turn-2', 'pin-tool'],
        });
    });

    it('can prefer the first visible user-turn anchor for user-turn navigation surfaces', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors,
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 2, lastSourceIndex: 4 },
        })).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['pin-a', 'turn-2', 'pin-tool'],
        });
    });

    it('returns an empty snapshot for empty, invalid, or out-of-range facts', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors,
            visibleSourceRange: { firstSourceIndex: 4, lastSourceIndex: 2 },
        })).toEqual({
            currentAnchorId: null,
            visibleAnchorIds: [],
        });
        expect(deriveCurrentTranscriptAnchor({
            anchors: [],
            visibleAnchorIds: ['turn-1'],
        })).toEqual({
            currentAnchorId: null,
            visibleAnchorIds: [],
        });
        expect(deriveCurrentTranscriptAnchor({
            anchors,
            topVisibleAnchorId: 'missing',
            visibleAnchorIds: ['missing'],
        })).toEqual({
            currentAnchorId: null,
            visibleAnchorIds: [],
        });
    });
});
