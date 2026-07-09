import { describe, expect, it } from 'vitest';

import { deriveWebTranscriptVisibleAnchorFacts } from './webTranscriptVisibleAnchorFacts';

describe('web transcript visible anchor facts', () => {
    it('derives top-visible and visible anchor ids from DOM-friendly rect facts', () => {
        expect(deriveWebTranscriptVisibleAnchorFacts({
            anchors: [
                { id: 'turn-1', kind: 'user-turn', sourceIndex: 0 },
                { id: 'turn-2', kind: 'user-turn', sourceIndex: 1 },
                { id: 'turn-3', kind: 'user-turn', sourceIndex: 2 },
            ],
            rows: [
                { anchorId: 'turn-1', topPx: -40, bottomPx: 20 },
                { anchorId: 'turn-2', topPx: 24, bottomPx: 80 },
                { anchorId: 'turn-3', topPx: 120, bottomPx: 180 },
            ],
            viewport: { topPx: 0, bottomPx: 100 },
        })).toEqual({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['turn-1', 'turn-2'],
            shouldReleasePinnedReader: false,
        });
    });

    it('ignores invalid DOM rects and dedupes repeated row facts', () => {
        expect(deriveWebTranscriptVisibleAnchorFacts({
            anchors: [
                { id: 'turn-2', kind: 'user-turn', sourceIndex: 1 },
            ],
            rows: [
                { anchorId: '', topPx: 0, bottomPx: 20 },
                { anchorId: 'turn-1', topPx: Number.NaN, bottomPx: 20 },
                { anchorId: 'turn-2', topPx: 10, bottomPx: 20 },
                { anchorId: 'turn-2', topPx: 12, bottomPx: 22 },
            ],
            viewport: { topPx: 0, bottomPx: 100 },
        })).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['turn-2'],
            shouldReleasePinnedReader: false,
        });
    });

    it('does not classify programmatic scroll echoes as reader-release intent', () => {
        expect(deriveWebTranscriptVisibleAnchorFacts({
            anchors: [
                { id: 'turn-1', kind: 'user-turn', sourceIndex: 0 },
            ],
            rows: [
                { anchorId: 'turn-1', topPx: 0, bottomPx: 40 },
            ],
            scrollIntent: {
                isTrusted: true,
                programmaticScrollActive: true,
            },
            viewport: { topPx: 0, bottomPx: 100 },
        })).toEqual({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['turn-1'],
            shouldReleasePinnedReader: false,
        });
    });

    it('can mark trusted non-programmatic DOM movement separately from visibility facts', () => {
        expect(deriveWebTranscriptVisibleAnchorFacts({
            anchors: [
                { id: 'turn-1', kind: 'user-turn', sourceIndex: 0 },
            ],
            rows: [
                { anchorId: 'turn-1', topPx: 0, bottomPx: 40 },
            ],
            scrollIntent: {
                isTrusted: true,
                programmaticScrollActive: false,
            },
            viewport: { topPx: 0, bottomPx: 100 },
        })).toEqual({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['turn-1'],
            shouldReleasePinnedReader: true,
        });
    });

    it('keeps the containing user turn current while reading its region below the turn row', () => {
        expect(deriveWebTranscriptVisibleAnchorFacts({
            anchors: [
                { id: 'turn-1', kind: 'user-turn', sourceIndex: 0 },
                { id: 'turn-2', kind: 'user-turn', sourceIndex: 1 },
            ],
            preferUserTurnAnchor: true,
            rows: [
                { anchorId: 'turn-1', topPx: -500, bottomPx: -460 },
            ],
            viewport: { topPx: 0, bottomPx: 100 },
        })).toEqual({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: [],
            shouldReleasePinnedReader: false,
        });
    });

    it('does not hand current off to the next turn while its row only peeks below the fold', () => {
        expect(deriveWebTranscriptVisibleAnchorFacts({
            anchors: [
                { id: 'turn-1', kind: 'user-turn', sourceIndex: 0 },
                { id: 'turn-2', kind: 'user-turn', sourceIndex: 1 },
            ],
            preferUserTurnAnchor: true,
            rows: [
                { anchorId: 'turn-1', topPx: -500, bottomPx: -460 },
                { anchorId: 'turn-2', topPx: 80, bottomPx: 130 },
            ],
            viewport: { topPx: 0, bottomPx: 100 },
        })).toEqual({
            currentAnchorId: 'turn-1',
            visibleAnchorIds: ['turn-2'],
            shouldReleasePinnedReader: false,
        });
    });

    it('treats a turn row just under the viewport top as current', () => {
        expect(deriveWebTranscriptVisibleAnchorFacts({
            anchors: [
                { id: 'turn-1', kind: 'user-turn', sourceIndex: 0 },
                { id: 'turn-2', kind: 'user-turn', sourceIndex: 1 },
            ],
            preferUserTurnAnchor: true,
            rows: [
                { anchorId: 'turn-1', topPx: -500, bottomPx: -460 },
                { anchorId: 'turn-2', topPx: 15, bottomPx: 60 },
            ],
            viewport: { topPx: 0, bottomPx: 100 },
        })).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['turn-2'],
            shouldReleasePinnedReader: false,
        });
    });

    it('uses the canonical current-anchor derivation for web DOM facts', () => {
        expect(deriveWebTranscriptVisibleAnchorFacts({
            anchors: [
                { id: 'turn-1', kind: 'user-turn', sourceIndex: 0 },
                { id: 'pin-a', kind: 'pinned-assistant', sourceIndex: 1 },
                { id: 'turn-2', kind: 'user-turn', sourceIndex: 2 },
            ],
            preferUserTurnAnchor: true,
            rows: [
                { anchorId: 'pin-a', topPx: -20, bottomPx: 40 },
                { anchorId: 'turn-2', topPx: 48, bottomPx: 120 },
                { anchorId: 'unknown', topPx: 52, bottomPx: 90 },
            ],
            viewport: { topPx: 0, bottomPx: 100 },
        })).toEqual({
            currentAnchorId: 'turn-2',
            visibleAnchorIds: ['pin-a', 'turn-2'],
            shouldReleasePinnedReader: false,
        });
    });
});
