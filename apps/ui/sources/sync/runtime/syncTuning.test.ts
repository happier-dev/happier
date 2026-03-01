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
                    resumeConcurrencyLimit: 5,
                }),
            },
        });

        expect(tuning.messageLargeGapSeq).toBe(12);
        expect(tuning.transcriptForwardPrefetchThresholdPx).toBe(34);
        expect(tuning.transcriptFlashListEstimatedItemSize).toBe(222);
        expect(tuning.resumeConcurrencyLimit).toBe(5);
    });

    it('ignores invalid env JSON overrides', () => {
        const tuning = loadSyncTuning({
            env: {
                EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: JSON.stringify({
                    messageLargeGapSeq: -1,
                    resumeConcurrencyLimit: 0,
                }),
            },
        });

        expect(tuning.messageLargeGapSeq).toBeGreaterThan(0);
        expect(tuning.resumeConcurrencyLimit).toBeGreaterThan(0);
    });
});
