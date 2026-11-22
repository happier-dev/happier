import { describe, expect, it } from 'vitest';

import { readUsagePoolNextQuotaRetry, readUsagePoolQueueNextRank } from './UsagePoolOrder';

describe('readUsagePoolQueueNextRank', () => {
    it('names one next account: the first ranked one the selector did not pick, wherever the picked one sits', () => {
        // Acceptance 1113 #7: the account in use was fourth, so ranks 1 and 2 were both labelled "next".
        expect(readUsagePoolQueueNextRank([
            { rank: 1, selected: false }, { rank: 2, selected: false }, { rank: 3, selected: false }, { rank: 4, selected: true },
        ])).toBe(1);
        expect(readUsagePoolQueueNextRank([{ rank: 1, selected: true }, { rank: 2, selected: false }, { rank: 3, selected: false }])).toBe(2);
        expect(readUsagePoolQueueNextRank([{ rank: null, selected: false }, { rank: 1, selected: true }])).toBeNull();
    });
});

describe('readUsagePoolNextQuotaRetry', () => {
    // Acceptance 11-22 #31: with no account read, Limits said "Every account is used up" and named a next retry.
    it('claims a next return only when every member of the pool has a reading: an unread account is unknown, never used up', () => {
        const pool = { key: 'pool', accountKeys: ['a', 'b'] } as never;
        const selection = { nextQuotaRetry: { profileId: 'a', retryAtMs: 2_000 } } as never;
        const read = (key: string, observedAtMs: number | null) => ({ key, observedAtMs }) as never;
        expect(readUsagePoolNextQuotaRetry(pool, [read('a', 1), read('b', 1)], selection, 1_000)).toEqual({ profileId: 'a', retryAtMs: 2_000 });
        expect(readUsagePoolNextQuotaRetry(pool, [read('a', 1), read('b', null)], selection, 1_000)).toBeUndefined();
        expect(readUsagePoolNextQuotaRetry(pool, [read('a', null), read('b', null)], selection, 1_000)).toBeUndefined();
        expect(readUsagePoolNextQuotaRetry(pool, [], selection, 1_000)).toBeUndefined();
    });
});
