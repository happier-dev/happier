import { describe, expect, it } from 'vitest';

import { readUsagePoolQueueNextRank } from './UsagePoolOrder';

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
