import { describe, expect, it } from 'vitest';
import { presentConnectedServiceQuotaFreshness } from './presentConnectedServiceQuotaFreshness';

describe('presentConnectedServiceQuotaFreshness', () => {
    it.each([null, undefined, { fetchedAt: null }, { fetchedAt: 0 }, { state: 'not_loaded', fetchedAt: 1_000 }])(
        'leaves missing observations undated and never stale (%j)', (snapshot) => {
            expect(presentConnectedServiceQuotaFreshness(snapshot, 10_000)).toEqual({ fetchedAt: null, staleSince: null });
        },
    );
    it('preserves a real observation through its freshness boundary', () => {
        const snapshot = { fetchedAt: 1_000, staleAfterMs: 2_000 };
        expect(presentConnectedServiceQuotaFreshness(snapshot, 3_000)).toEqual({ fetchedAt: 1_000, staleSince: null });
        expect(presentConnectedServiceQuotaFreshness(snapshot, 3_001)).toEqual({ fetchedAt: 1_000, staleSince: 1_000 });
    });
});
