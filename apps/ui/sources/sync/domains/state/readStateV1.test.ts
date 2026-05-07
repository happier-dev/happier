import { describe, expect, it } from 'vitest';

import { computeManualUnreadReadStateV1, computeNextReadStateV1 } from './readStateV1';

describe('computeNextReadStateV1', () => {
    it('does not change state when existing marker already covers current activity', () => {
        expect(computeNextReadStateV1({
            prev: { v: 1, sessionSeq: 10, pendingActivityAt: 20, updatedAt: 100 },
            sessionSeq: 10,
            pendingActivityAt: 20,
            now: 200,
        })).toEqual({
            didChange: false,
            next: { v: 1, sessionSeq: 10, pendingActivityAt: 20, updatedAt: 100 },
        });
    });

    it('advances markers when activity increases', () => {
        expect(computeNextReadStateV1({
            prev: { v: 1, sessionSeq: 10, pendingActivityAt: 20, updatedAt: 100 },
            sessionSeq: 11,
            pendingActivityAt: 25,
            now: 200,
        })).toEqual({
            didChange: true,
            next: { v: 1, sessionSeq: 11, pendingActivityAt: 25, updatedAt: 200 },
        });
    });

    it('repairs invalid markers when previous sessionSeq exceeds current sessionSeq', () => {
        expect(computeNextReadStateV1({
            prev: { v: 1, sessionSeq: 50_000, pendingActivityAt: 20, updatedAt: 100 },
            sessionSeq: 11,
            pendingActivityAt: 20,
            now: 200,
        })).toEqual({
            didChange: true,
            next: { v: 1, sessionSeq: 11, pendingActivityAt: 20, updatedAt: 200 },
        });
    });
});

describe('computeManualUnreadReadStateV1', () => {
    it('lowers stale legacy metadata to the manual unread boundary', () => {
        expect(computeManualUnreadReadStateV1({
            prev: { v: 1, sessionSeq: 8, pendingActivityAt: 25, updatedAt: 100 },
            sessionSeq: 8,
            lastViewedSessionSeq: null,
            now: 200,
        })).toEqual({
            didChange: true,
            next: { v: 1, sessionSeq: 7, pendingActivityAt: 25, updatedAt: 200 },
        });
    });

    it('uses the numeric server cursor when provided', () => {
        expect(computeManualUnreadReadStateV1({
            prev: { v: 1, sessionSeq: 8, pendingActivityAt: 25, updatedAt: 100 },
            sessionSeq: 8,
            lastViewedSessionSeq: 4,
            now: 200,
        })).toEqual({
            didChange: true,
            next: { v: 1, sessionSeq: 4, pendingActivityAt: 25, updatedAt: 200 },
        });
    });

    it('keeps legacy metadata when it is already at or before the unread boundary', () => {
        const prev = { v: 1 as const, sessionSeq: 3, pendingActivityAt: 25, updatedAt: 100 };

        expect(computeManualUnreadReadStateV1({
            prev,
            sessionSeq: 8,
            lastViewedSessionSeq: null,
            now: 200,
        })).toEqual({
            didChange: false,
            next: prev,
        });
    });
});
