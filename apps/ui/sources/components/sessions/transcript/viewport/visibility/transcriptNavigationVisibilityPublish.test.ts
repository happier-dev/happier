import { describe, expect, it } from 'vitest';

import type { TranscriptNavigationAnchorCandidate } from './deriveCurrentTranscriptAnchor';
import {
    publishTranscriptNavigationVisibility,
    resolveTranscriptNavigationVisibilityWrite,
} from './transcriptNavigationVisibilityPublish';
import { createTranscriptNavigationVisibilityStore } from './transcriptNavigationVisibilityStore';

const TURN_1: TranscriptNavigationAnchorCandidate = { id: 'turn-1', kind: 'user-turn', sourceIndex: 1 };
const TURN_2: TranscriptNavigationAnchorCandidate = { id: 'turn-2', kind: 'user-turn', sourceIndex: 9 };
const ANCHORS = [TURN_1, TURN_2];

const GOOD_SNAPSHOT = {
    currentAnchorId: 'turn-2',
    visibleAnchorIds: ['turn-2'],
} as const;

describe('resolveTranscriptNavigationVisibilityWrite', () => {
    it('writes the derived snapshot for a measured range', () => {
        expect(resolveTranscriptNavigationVisibilityWrite({
            anchors: ANCHORS,
            itemCount: 20,
            visibleSourceRange: { startIndex: 9, endIndex: 14 },
        })).toEqual({ kind: 'write', snapshot: GOOD_SNAPSHOT });
    });

    it('writes empty intentionally when the anchor set is genuinely empty', () => {
        expect(resolveTranscriptNavigationVisibilityWrite({
            anchors: [],
            itemCount: 20,
            visibleSourceRange: { startIndex: 0, endIndex: 4 },
        })).toEqual({
            kind: 'write',
            snapshot: { currentAnchorId: null, visibleAnchorIds: [] },
        });
    });

    it('skips instead of clobbering when the frame has no measured range', () => {
        expect(resolveTranscriptNavigationVisibilityWrite({
            anchors: ANCHORS,
            itemCount: 20,
            visibleSourceRange: null,
        })).toEqual({ kind: 'skip', reason: 'unmeasured-viewport' });
    });

    it('skips a frame that reports no rendered items', () => {
        expect(resolveTranscriptNavigationVisibilityWrite({
            anchors: ANCHORS,
            itemCount: 0,
            visibleSourceRange: { startIndex: 0, endIndex: 0 },
        })).toEqual({ kind: 'skip', reason: 'unmeasured-viewport' });
    });

    it('lets a landed jump anchor own current while the renderer still leads with the previous turn', () => {
        expect(resolveTranscriptNavigationVisibilityWrite({
            anchors: ANCHORS,
            itemCount: 20,
            landedAnchorId: 'turn-2',
            visibleSourceRange: { startIndex: 7, endIndex: 14 },
        })).toEqual({
            kind: 'write',
            snapshot: { currentAnchorId: 'turn-2', visibleAnchorIds: ['turn-2'] },
        });
    });

    it('normalizes an inverted renderer range and clamps it to the rendered item count', () => {
        expect(resolveTranscriptNavigationVisibilityWrite({
            anchors: ANCHORS,
            itemCount: 12,
            visibleSourceRange: { startIndex: 40, endIndex: 9 },
        })).toEqual({ kind: 'write', snapshot: GOOD_SNAPSHOT });
    });
});

describe('publishTranscriptNavigationVisibility', () => {
    it('does not clobber a good snapshot when the frame is unmeasured', () => {
        const store = createTranscriptNavigationVisibilityStore(GOOD_SNAPSHOT);
        store.subscribe(() => {});

        expect(publishTranscriptNavigationVisibility({
            anchors: ANCHORS,
            itemCount: 20,
            readVisibleSourceRange: () => null,
            store,
        })).toEqual({ kind: 'skip', reason: 'unmeasured-viewport' });
        expect(store.get()).toEqual(GOOD_SNAPSHOT);
    });

    it('distinguishes an unmeasured renderer from one genuinely showing the first row', () => {
        const unmeasured = createTranscriptNavigationVisibilityStore(GOOD_SNAPSHOT);
        unmeasured.subscribe(() => {});
        const atFirstRow = createTranscriptNavigationVisibilityStore(GOOD_SNAPSHOT);
        atFirstRow.subscribe(() => {});

        expect(publishTranscriptNavigationVisibility({
            anchors: ANCHORS,
            itemCount: 20,
            readVisibleSourceRange: () => null,
            store: unmeasured,
        })).toEqual({ kind: 'skip', reason: 'unmeasured-viewport' });
        expect(unmeasured.get()).toEqual(GOOD_SNAPSHOT);

        const firstTurn: TranscriptNavigationAnchorCandidate = { id: 'turn-0', kind: 'user-turn', sourceIndex: 0 };
        expect(publishTranscriptNavigationVisibility({
            anchors: [firstTurn, ...ANCHORS],
            itemCount: 20,
            readVisibleSourceRange: () => ({ startIndex: 0, endIndex: 0 }),
            store: atFirstRow,
        })).toEqual({
            kind: 'write',
            snapshot: { currentAnchorId: 'turn-0', visibleAnchorIds: ['turn-0'] },
        });
    });

    it('writes empty when the anchor set drained', () => {
        const store = createTranscriptNavigationVisibilityStore(GOOD_SNAPSHOT);
        store.subscribe(() => {});

        expect(publishTranscriptNavigationVisibility({
            anchors: [],
            itemCount: 20,
            readVisibleSourceRange: () => ({ startIndex: 0, endIndex: 4 }),
            store,
        })).toEqual({
            kind: 'write',
            snapshot: { currentAnchorId: null, visibleAnchorIds: [] },
        });
        expect(store.get()).toEqual({ currentAnchorId: null, visibleAnchorIds: [] });
    });

    it('never reads the renderer while nothing is subscribed', () => {
        const store = createTranscriptNavigationVisibilityStore(null);
        let reads = 0;

        expect(publishTranscriptNavigationVisibility({
            anchors: ANCHORS,
            itemCount: 20,
            readVisibleSourceRange: () => {
                reads += 1;
                return { startIndex: 9, endIndex: 14 };
            },
            store,
        })).toEqual({ kind: 'skip', reason: 'no-subscribers' });
        expect(reads).toBe(0);
    });

    it('survives a renderer read that throws', () => {
        const store = createTranscriptNavigationVisibilityStore(GOOD_SNAPSHOT);
        store.subscribe(() => {});

        expect(publishTranscriptNavigationVisibility({
            anchors: ANCHORS,
            itemCount: 20,
            readVisibleSourceRange: () => {
                throw new Error('renderer detached');
            },
            store,
        })).toEqual({ kind: 'skip', reason: 'unmeasured-viewport' });
        expect(store.get()).toEqual(GOOD_SNAPSHOT);
    });
});
