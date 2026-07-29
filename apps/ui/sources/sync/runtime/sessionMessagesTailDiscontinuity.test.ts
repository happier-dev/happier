import { describe, expect, it } from 'vitest';

import {
    applyTailDiscontinuityOlderPage,
    openTailDiscontinuityFromSnapshot,
} from './sessionMessagesTailDiscontinuity';

describe('openTailDiscontinuityFromSnapshot', () => {
    it('opens a discontinuity when the snapshot island starts above the contiguous prefix', () => {
        const record = openTailDiscontinuityFromSnapshot({
            prev: null,
            prefixMaxSeq: 410,
            snapshotMinSeq: 1951,
        });
        expect(record).toEqual({ prefixMaxSeq: 410, walkCursor: 1951 });
    });

    it('does not open on a contiguous or overlapping snapshot', () => {
        expect(openTailDiscontinuityFromSnapshot({
            prev: null,
            prefixMaxSeq: 410,
            snapshotMinSeq: 411,
        })).toBeNull();
        expect(openTailDiscontinuityFromSnapshot({
            prev: null,
            prefixMaxSeq: 410,
            snapshotMinSeq: 380,
        })).toBeNull();
    });

    it('does not open when there was no prior materialized content', () => {
        expect(openTailDiscontinuityFromSnapshot({
            prev: null,
            prefixMaxSeq: 0,
            snapshotMinSeq: 1951,
        })).toBeNull();
    });

    it('keeps the deepest prefix on a stacked reset while a discontinuity is already open', () => {
        const first = openTailDiscontinuityFromSnapshot({
            prev: null,
            prefixMaxSeq: 410,
            snapshotMinSeq: 1951,
        });
        // A second large gap opens while the first hole is still unfilled: the island head
        // advanced to 2600, the new snapshot starts at 5000. The walk restarts from the new
        // island but must still bridge all the way down to the ORIGINAL prefix.
        const second = openTailDiscontinuityFromSnapshot({
            prev: first,
            prefixMaxSeq: 2600,
            snapshotMinSeq: 5000,
        });
        expect(second).toEqual({ prefixMaxSeq: 410, walkCursor: 5000 });
    });

    it('keeps the open record when a later snapshot is contiguous with the island', () => {
        const first = openTailDiscontinuityFromSnapshot({
            prev: null,
            prefixMaxSeq: 410,
            snapshotMinSeq: 1951,
        });
        const unchanged = openTailDiscontinuityFromSnapshot({
            prev: first,
            prefixMaxSeq: 2000,
            snapshotMinSeq: 1990,
        });
        expect(unchanged).toBe(first);
    });
});

describe('applyTailDiscontinuityOlderPage', () => {
    const record = { prefixMaxSeq: 410, walkCursor: 1951 } as const;

    it('advances the walk cursor from a fetched older page', () => {
        expect(applyTailDiscontinuityOlderPage({
            prev: record,
            pageMinSeq: 1801,
            nextBeforeSeq: 1801,
        })).toEqual({ prefixMaxSeq: 410, walkCursor: 1801 });
    });

    it('prefers the server cursor when it is provided and lower', () => {
        expect(applyTailDiscontinuityOlderPage({
            prev: record,
            pageMinSeq: 1810,
            nextBeforeSeq: 1801,
        })).toEqual({ prefixMaxSeq: 410, walkCursor: 1801 });
    });

    it('closes when the walk bridges the prefix', () => {
        expect(applyTailDiscontinuityOlderPage({
            prev: record,
            pageMinSeq: 411,
            nextBeforeSeq: 411,
        })).toBeNull();
        expect(applyTailDiscontinuityOlderPage({
            prev: record,
            pageMinSeq: 380,
            nextBeforeSeq: 380,
        })).toBeNull();
    });

    it('closes on an empty page (nothing exists below the walk any more)', () => {
        expect(applyTailDiscontinuityOlderPage({
            prev: record,
            pageMinSeq: null,
            nextBeforeSeq: null,
        })).toBeNull();
    });

    it('never raises the walk cursor', () => {
        expect(applyTailDiscontinuityOlderPage({
            prev: record,
            pageMinSeq: 1990,
            nextBeforeSeq: null,
        })).toEqual(record);
    });
});
