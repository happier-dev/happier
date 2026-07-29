import { describe, expect, it } from 'vitest';

import { deriveCurrentTranscriptAnchor } from './deriveCurrentTranscriptAnchor';

const anchors = [
    { id: 'turn-1', kind: 'user-turn', sourceIndex: 0 },
    { id: 'pin-a', kind: 'pinned-assistant', sourceIndex: 2 },
    { id: 'turn-2', kind: 'user-turn', sourceIndex: 3 },
    { id: 'pin-tool', kind: 'pinned-tool', sourceIndex: 4 },
] as const;

describe('deriveCurrentTranscriptAnchor', () => {
    it('reports the greatest anchor at or above the leading visible row', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors,
            visibleSourceRange: { firstSourceIndex: 2, lastSourceIndex: 4 },
        })).toEqual({
            currentAnchorId: 'pin-a',
            visibleAnchorIds: ['pin-a', 'turn-2', 'pin-tool'],
        });
    });

    // Virtualization unmounts the current turn's own prompt row long before the
    // reader leaves that turn, so "the anchor row is mounted" cannot answer this.
    it('keeps the containing turn current after its prompt row scrolled out of the window', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors,
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 8, lastSourceIndex: 12 },
        })).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: [],
        });
    });

    it('prefers the containing user turn over a pin that merely peeks in from below', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors,
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 3, lastSourceIndex: 4 },
        })).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['turn-2', 'pin-tool'],
        });
    });

    it('falls back to any containing anchor when no user turn is at or above the leading row', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors: [
                { id: 'pin-a', kind: 'pinned-assistant', sourceIndex: 2 },
                { id: 'turn-2', kind: 'user-turn', sourceIndex: 6 },
            ],
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 3, lastSourceIndex: 6 },
        })).toEqual({
            currentAnchorId: 'pin-a',
            visibleAnchorIds: ['turn-2'],
        });
    });

    // A landing routinely settles the renderer window one or two rows ABOVE the
    // target row, and geometry cannot tell that apart from genuinely reading the
    // previous turn — so the landing intent wins until the reader moves.
    it('lets a landed jump anchor own current against containment', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors,
            landedAnchorId: 'turn-2',
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 2, lastSourceIndex: 4 },
        })).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['pin-a', 'turn-2', 'pin-tool'],
        });
    });

    it('ignores a landed anchor that is not in the anchor set', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors,
            landedAnchorId: 'gone',
            preferUserTurnAnchor: true,
            visibleSourceRange: { firstSourceIndex: 2, lastSourceIndex: 4 },
        })).toEqual({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['pin-a', 'turn-2', 'pin-tool'],
        });
    });

    it('returns an empty snapshot for empty or invalid facts', () => {
        expect(deriveCurrentTranscriptAnchor({
            anchors,
            visibleSourceRange: { firstSourceIndex: 4, lastSourceIndex: 2 },
        })).toEqual({
            currentAnchorId: null,
            visibleAnchorIds: [],
        });
        expect(deriveCurrentTranscriptAnchor({
            anchors: [],
            visibleSourceRange: { firstSourceIndex: 0, lastSourceIndex: 4 },
        })).toEqual({
            currentAnchorId: null,
            visibleAnchorIds: [],
        });
        expect(deriveCurrentTranscriptAnchor({
            anchors,
            visibleSourceRange: null,
        })).toEqual({
            currentAnchorId: null,
            visibleAnchorIds: [],
        });
    });
});
