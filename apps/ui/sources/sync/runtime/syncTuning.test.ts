import { describe, expect, it } from 'vitest';
import { loadSyncTuning } from './syncTuning';

describe('loadSyncTuning', () => {
    it('keeps default message decrypt batches small enough for responsive page hydration', () => {
        const tuning = loadSyncTuning();

        expect(tuning.messageDecryptBatchSize).toBeGreaterThan(0);
        expect(tuning.messageDecryptBatchSize).toBeLessThanOrEqual(8);
        expect(tuning.messageDecryptYieldDelayMs).toBe(0);
        expect(tuning.encryptionAesBatchConcurrencyLimit).toBeGreaterThan(0);
        expect(tuning.encryptionAesBatchConcurrencyLimit).toBeLessThanOrEqual(8);
        expect(tuning.sessionSocketApplyCoalescingEnabled).toBe(true);
        expect(tuning.sessionSocketApplyCoalescingWindowMs).toBeGreaterThan(0);
        expect(tuning.sessionSocketApplyCoalescingWindowMs).toBeLessThanOrEqual(32);
        expect(tuning.sessionSocketApplyCoalescingMaxBatchSize).toBeGreaterThan(1);
        expect(tuning.nativeCryptoWorkerMode).toBe('auto');
    });

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
                    sessionListBackgroundHydrationConcurrencyLimit: 2,
                    sessionListBackgroundHydrationYieldDelayMs: 3,
                    sessionListBackgroundHydrationApplyBatchSize: 4,
                    sessionListBackgroundHydrationApplyFlushDelayMs: 17,
                    messageDecryptBatchSize: 5,
                    messageDecryptYieldDelayMs: 6,
                    encryptionAesBatchConcurrencyLimit: 6,
                    sessionSocketApplyCoalescingEnabled: false,
                    sessionSocketApplyCoalescingWindowMs: 24,
                    sessionSocketApplyCoalescingMaxBatchSize: 9,
                    changesMaxPagesPerResume: 8,
                    webSyncInstanceLiveTtlMs: 12_000,
                    webSyncInstanceHeartbeatMs: 4_000,
                    webSyncInstanceCursorRetentionMs: 123_000,
                    webLifecycleHeartbeatTickMs: 31_000,
                    webLifecycleHeartbeatDriftMs: 61_000,
                    nativeInactiveCheckpointDebounceMs: 350,
                    safeCursorLagAlertMs: 301_000,
                    streamingMarkdownRepairWorkletTimeoutMs: 321,
                    syncPerformanceTelemetryEnabled: true,
                    syncPerformanceTelemetrySlowThresholdMs: 45,
                    syncPerformanceTelemetryFlushIntervalMs: 1234,
                    nativeCryptoWorkerMode: 'auto',
                    nativeCryptoWorkerMaxBatchSize: 512,
                    nativeCryptoWorkerMinBatchSize: 3,
                    nativeCryptoWorkerMinPayloadBytes: 65_536,
                    nativeCryptoWorkerTimeoutMs: 100,
                    nativeCryptoWorkerLogFallbacks: true,
                    nativeCryptoWorkerTelemetryEnabled: true,
                    nativeCryptoWorkerStreamingSampleRate: 0.25,
                    nativeCryptoWorkerCapabilityStalenessMs: 60_000,
                    jsThreadLagTelemetrySampleIntervalMs: 40,
                    jsThreadLagTelemetryThresholdMs: 30,
                    jsThreadLagTelemetryMaxSamples: 128,
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
        expect(tuning.sessionListBackgroundHydrationConcurrencyLimit).toBe(2);
        expect(tuning.sessionListBackgroundHydrationYieldDelayMs).toBe(3);
        expect(tuning.sessionListBackgroundHydrationApplyBatchSize).toBe(4);
        expect(tuning.sessionListBackgroundHydrationApplyFlushDelayMs).toBe(17);
        expect(tuning.messageDecryptBatchSize).toBe(5);
        expect(tuning.messageDecryptYieldDelayMs).toBe(6);
        expect(tuning.encryptionAesBatchConcurrencyLimit).toBe(6);
        expect(tuning.sessionSocketApplyCoalescingEnabled).toBe(false);
        expect(tuning.sessionSocketApplyCoalescingWindowMs).toBe(24);
        expect(tuning.sessionSocketApplyCoalescingMaxBatchSize).toBe(9);
        expect(tuning.changesMaxPagesPerResume).toBe(8);
        expect(tuning.webSyncInstanceLiveTtlMs).toBe(12_000);
        expect(tuning.webSyncInstanceHeartbeatMs).toBe(4_000);
        expect(tuning.webSyncInstanceCursorRetentionMs).toBe(123_000);
        expect(tuning.webLifecycleHeartbeatTickMs).toBe(31_000);
        expect(tuning.webLifecycleHeartbeatDriftMs).toBe(61_000);
        expect(tuning.nativeInactiveCheckpointDebounceMs).toBe(350);
        expect(tuning.safeCursorLagAlertMs).toBe(301_000);
        expect(tuning.streamingMarkdownRepairWorkletTimeoutMs).toBe(321);
        expect(tuning.syncPerformanceTelemetryEnabled).toBe(true);
        expect(tuning.syncPerformanceTelemetrySlowThresholdMs).toBe(45);
        expect(tuning.syncPerformanceTelemetryFlushIntervalMs).toBe(1234);
        expect(tuning.nativeCryptoWorkerMode).toBe('auto');
        expect(tuning.nativeCryptoWorkerMaxBatchSize).toBe(512);
        expect(tuning.nativeCryptoWorkerMinBatchSize).toBe(3);
        expect(tuning.nativeCryptoWorkerMinPayloadBytes).toBe(65_536);
        expect(tuning.nativeCryptoWorkerTimeoutMs).toBe(100);
        expect(tuning.nativeCryptoWorkerLogFallbacks).toBe(true);
        expect(tuning.nativeCryptoWorkerTelemetryEnabled).toBe(true);
        expect(tuning.nativeCryptoWorkerStreamingSampleRate).toBe(0.25);
        expect(tuning.nativeCryptoWorkerCapabilityStalenessMs).toBe(60_000);
        expect(tuning.jsThreadLagTelemetrySampleIntervalMs).toBe(40);
        expect(tuning.jsThreadLagTelemetryThresholdMs).toBe(30);
        expect(tuning.jsThreadLagTelemetryMaxSamples).toBe(128);
    });

    it('applies Expo app config JSON overrides for native release builds', () => {
        const tuning = loadSyncTuning({
            readExpoConfig: () => ({
                extra: {
                    app: {
                        syncTuningJson: JSON.stringify({
                            syncPerformanceTelemetryEnabled: true,
                            nativeCryptoWorkerMode: 'auto',
                            nativeCryptoWorkerTelemetryEnabled: true,
                        }),
                    },
                },
            }),
        });

        expect(tuning.syncPerformanceTelemetryEnabled).toBe(true);
        expect(tuning.nativeCryptoWorkerMode).toBe('auto');
        expect(tuning.nativeCryptoWorkerTelemetryEnabled).toBe(true);
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
                    sessionListBackgroundHydrationConcurrencyLimit: 0,
                    sessionListBackgroundHydrationYieldDelayMs: -1,
                    sessionListBackgroundHydrationApplyBatchSize: 0,
                    sessionListBackgroundHydrationApplyFlushDelayMs: -1,
                    messageDecryptBatchSize: 0,
                    messageDecryptYieldDelayMs: -1,
                    encryptionAesBatchConcurrencyLimit: 0,
                    sessionSocketApplyCoalescingEnabled: 'yes',
                    sessionSocketApplyCoalescingWindowMs: -1,
                    sessionSocketApplyCoalescingMaxBatchSize: 0,
                    changesMaxPagesPerResume: 0,
                    webSyncInstanceLiveTtlMs: 0,
                    webSyncInstanceHeartbeatMs: 0,
                    webSyncInstanceCursorRetentionMs: -1,
                    webLifecycleHeartbeatTickMs: 0,
                    webLifecycleHeartbeatDriftMs: -1,
                    nativeInactiveCheckpointDebounceMs: -1,
                    safeCursorLagAlertMs: 0,
                    streamingMarkdownRepairWorkletTimeoutMs: 0,
                    syncPerformanceTelemetryEnabled: 'yes',
                    syncPerformanceTelemetrySlowThresholdMs: 0,
                    syncPerformanceTelemetryFlushIntervalMs: 5,
                    nativeCryptoWorkerMode: 'maybe',
                    nativeCryptoWorkerMaxBatchSize: 513,
                    nativeCryptoWorkerMinBatchSize: 0,
                    nativeCryptoWorkerMinPayloadBytes: 65_537,
                    nativeCryptoWorkerTimeoutMs: 99,
                    nativeCryptoWorkerLogFallbacks: 'yes',
                    nativeCryptoWorkerTelemetryEnabled: 'yes',
                    nativeCryptoWorkerStreamingSampleRate: 2,
                    nativeCryptoWorkerCapabilityStalenessMs: 10,
                    jsThreadLagTelemetrySampleIntervalMs: 0,
                    jsThreadLagTelemetryThresholdMs: 0,
                    jsThreadLagTelemetryMaxSamples: 0,
                }),
            },
        });

        expect(tuning.messageLargeGapSeq).toBeGreaterThan(0);
        expect(tuning.transcriptWebHotTailItemCount).toBeGreaterThan(0);
        expect(tuning.transcriptInitialFillBudgetMs).toBeGreaterThanOrEqual(250);
        expect(tuning.transcriptInitialFillMaxNoProgressLoads).toBeGreaterThan(0);
        expect(tuning.resumeConcurrencyLimit).toBeGreaterThan(0);
        expect(tuning.sessionListBackgroundHydrationConcurrencyLimit).toBeGreaterThan(0);
        expect(tuning.sessionListBackgroundHydrationYieldDelayMs).toBeGreaterThanOrEqual(0);
        expect(tuning.sessionListBackgroundHydrationApplyBatchSize).toBe(1);
        expect(tuning.sessionListBackgroundHydrationApplyFlushDelayMs).toBeGreaterThanOrEqual(0);
        expect(tuning.messageDecryptBatchSize).toBeGreaterThan(0);
        expect(tuning.messageDecryptYieldDelayMs).toBeGreaterThanOrEqual(0);
        expect(tuning.encryptionAesBatchConcurrencyLimit).toBeGreaterThan(0);
        expect(tuning.sessionSocketApplyCoalescingEnabled).toBe(true);
        expect(tuning.sessionSocketApplyCoalescingWindowMs).toBeGreaterThan(0);
        expect(tuning.sessionSocketApplyCoalescingMaxBatchSize).toBeGreaterThan(1);
        expect(tuning.changesMaxPagesPerResume).toBeGreaterThan(0);
        expect(tuning.webSyncInstanceLiveTtlMs).toBeGreaterThan(0);
        expect(tuning.webSyncInstanceHeartbeatMs).toBeGreaterThan(0);
        expect(tuning.webSyncInstanceCursorRetentionMs).toBeGreaterThan(0);
        expect(tuning.webLifecycleHeartbeatTickMs).toBe(30_000);
        expect(tuning.webLifecycleHeartbeatDriftMs).toBe(60_000);
        expect(tuning.nativeInactiveCheckpointDebounceMs).toBe(300);
        expect(tuning.safeCursorLagAlertMs).toBe(300_000);
        expect(tuning.streamingMarkdownRepairWorkletTimeoutMs).toBeGreaterThan(0);
        expect(tuning.syncPerformanceTelemetryEnabled).toBe(false);
        expect(tuning.syncPerformanceTelemetrySlowThresholdMs).toBeGreaterThan(0);
        expect(tuning.syncPerformanceTelemetryFlushIntervalMs).toBeGreaterThanOrEqual(1000);
        expect(tuning.nativeCryptoWorkerMode).toBe('auto');
        expect(tuning.nativeCryptoWorkerMaxBatchSize).toBe(64);
        expect(tuning.nativeCryptoWorkerMinBatchSize).toBe(1);
        expect(tuning.nativeCryptoWorkerMinPayloadBytes).toBe(512);
        expect(tuning.nativeCryptoWorkerTimeoutMs).toBe(5000);
        expect(tuning.nativeCryptoWorkerLogFallbacks).toBe(false);
        expect(tuning.nativeCryptoWorkerTelemetryEnabled).toBe(false);
        expect(tuning.nativeCryptoWorkerStreamingSampleRate).toBe(1);
        expect(tuning.nativeCryptoWorkerCapabilityStalenessMs).toBe(300_000);
        expect(tuning.jsThreadLagTelemetrySampleIntervalMs).toBe(50);
        expect(tuning.jsThreadLagTelemetryThresholdMs).toBe(50);
        expect(tuning.jsThreadLagTelemetryMaxSamples).toBe(512);
    });
});
