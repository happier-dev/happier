import { describe, expect, it } from 'vitest';

import { readKnownPendingQueueState } from './pendingQueueState';

describe('pendingQueueState', () => {
    it('rejects fractional pending counters instead of truncating them', () => {
        expect(readKnownPendingQueueState({ pendingCount: 0.9, pendingVersion: 1 })).toBeNull();
        expect(readKnownPendingQueueState({ pendingCount: 1, pendingVersion: 2.5 })).toBeNull();
    });
});
