import { describe, expect, it } from 'vitest';
import { loadSyncTuning } from './syncTuning';

describe('loadSyncTuning', () => {
    it('applies env JSON overrides', () => {
        const tuning = loadSyncTuning({
            env: {
                EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: JSON.stringify({
                    messageLargeGapSeq: 12,
                    transcriptForwardPrefetchThresholdPx: 34,
                    transcriptFlashListEstimatedItemSize: 222,
                    transcriptWebHotTailItemCount: 9,
                    transcriptInitialFillBudgetMs: 4321,
                    transcriptInitialFillMaxNoProgressLoads: 7,
                    resumeConcurrencyLimit: 5,
                }),
            },
        });

        expect(tuning.messageLargeGapSeq).toBe(12);
        expect(tuning.transcriptForwardPrefetchThresholdPx).toBe(34);
        expect(tuning.transcriptFlashListEstimatedItemSize).toBe(222);
        expect(tuning.transcriptWebHotTailItemCount).toBe(9);
        expect(tuning.transcriptInitialFillBudgetMs).toBe(4321);
        expect(tuning.transcriptInitialFillMaxNoProgressLoads).toBe(7);
        expect(tuning.resumeConcurrencyLimit).toBe(5);
    });

    it('ignores invalid env JSON overrides', () => {
        const tuning = loadSyncTuning({
            env: {
                EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: JSON.stringify({
                    messageLargeGapSeq: -1,
                    transcriptWebHotTailItemCount: 0,
                    transcriptInitialFillBudgetMs: 10,
                    transcriptInitialFillMaxNoProgressLoads: 0,
                    resumeConcurrencyLimit: 0,
                }),
            },
        });

        expect(tuning.messageLargeGapSeq).toBeGreaterThan(0);
        expect(tuning.transcriptWebHotTailItemCount).toBeGreaterThan(0);
        expect(tuning.transcriptInitialFillBudgetMs).toBeGreaterThanOrEqual(250);
        expect(tuning.transcriptInitialFillMaxNoProgressLoads).toBeGreaterThan(0);
        expect(tuning.resumeConcurrencyLimit).toBeGreaterThan(0);
    });
});
