import { describe, expect, it } from 'vitest';

import { readKnownPendingQueueState } from './pendingQueueState';

describe('pendingQueueState', () => {
    it('rejects fractional pending counters instead of truncating them', () => {
        expect(readKnownPendingQueueState({ pendingCount: 0.9, pendingVersion: 1 })).toBeNull();
        expect(readKnownPendingQueueState({ pendingCount: 1, pendingVersion: 2.5 })).toBeNull();
    });

    it('preserves blocked pending counts and defaults old snapshots to zero blocked rows', () => {
        expect(readKnownPendingQueueState({
            pendingCount: 3,
            pendingBlockedCount: 2,
            pendingVersion: 5,
        })).toEqual({
            known: true,
            pendingCount: 3,
            pendingBlockedCount: 2,
            pendingVersion: 5,
        });

        expect(readKnownPendingQueueState({
            pendingCount: 3,
            pendingVersion: 5,
        })).toEqual({
            known: true,
            pendingCount: 3,
            pendingBlockedCount: 0,
            pendingVersion: 5,
        });
    });
});
