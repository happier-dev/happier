import { describe, expect, it } from 'vitest';

import { resolveTranscriptInitialFillTuning } from './resolveTranscriptInitialFillTuning';

describe('resolveTranscriptInitialFillTuning', () => {
    it('falls back to safe defaults when tuning values are missing or invalid', () => {
        expect(resolveTranscriptInitialFillTuning({})).toEqual({
            budgetMs: 1500,
            maxNoProgressLoads: 2,
        });

        expect(resolveTranscriptInitialFillTuning({
            transcriptInitialFillBudgetMs: Number.NaN,
            transcriptInitialFillMaxNoProgressLoads: -1,
        })).toEqual({
            budgetMs: 1500,
            maxNoProgressLoads: 2,
        });
    });

    it('normalizes finite values into bounded integers', () => {
        expect(resolveTranscriptInitialFillTuning({
            transcriptInitialFillBudgetMs: 2048.9,
            transcriptInitialFillMaxNoProgressLoads: 3.8,
        })).toEqual({
            budgetMs: 2048,
            maxNoProgressLoads: 3,
        });
    });
});
