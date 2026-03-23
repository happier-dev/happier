import { describe, expect, it } from 'vitest';

import type { MemorySearchHitV1 } from '@happier-dev/protocol';

import { groupMemorySearchHitsBySession } from './groupMemorySearchHitsBySession';

describe('groupMemorySearchHitsBySession', () => {
    it('groups hits by session while preserving hit order and preferred labels', () => {
        const hits: MemorySearchHitV1[] = [
            { sessionId: 's1', seqFrom: 1, seqTo: 2, createdAtFromMs: 10, createdAtToMs: 20, summary: 'First', score: 0.9 },
            { sessionId: 's2', seqFrom: 3, seqTo: 4, createdAtFromMs: 30, createdAtToMs: 40, summary: 'Second', score: 0.8 },
            { sessionId: 's1', seqFrom: 5, seqTo: 6, createdAtFromMs: 50, createdAtToMs: 60, summary: 'Third', score: 0.7 },
        ];

        const groups = groupMemorySearchHitsBySession({
            hits,
            sessionLabelById: new Map([
                ['s1', 'Session One'],
                ['s2', 'Session Two'],
            ]),
        });

        expect(groups).toEqual([
            {
                sessionId: 's1',
                sessionLabel: 'Session One',
                hits: [hits[0], hits[2]],
            },
            {
                sessionId: 's2',
                sessionLabel: 'Session Two',
                hits: [hits[1]],
            },
        ]);
    });

    it('falls back to the session id when no label is known', () => {
        const hits: MemorySearchHitV1[] = [
            { sessionId: 's9', seqFrom: 1, seqTo: 1, createdAtFromMs: 10, createdAtToMs: 10, summary: 'Only', score: 0.5 },
        ];

        const groups = groupMemorySearchHitsBySession({
            hits,
            sessionLabelById: new Map(),
        });

        expect(groups[0]).toEqual({
            sessionId: 's9',
            sessionLabel: 's9',
            hits,
        });
    });
});
