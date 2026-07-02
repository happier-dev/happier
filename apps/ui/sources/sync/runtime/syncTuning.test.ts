import { describe, expect, it } from 'vitest';
import { loadSyncTuning } from './syncTuning';

describe('loadSyncTuning', () => {
    it('keeps default message decrypt batches small enough for responsive page hydration', () => {
        const tuning = loadSyncTuning();

        expect(tuning.initialMessageDecryptBatchSize).toBeGreaterThanOrEqual(32);
        expect(tuning.initialMessageDecryptBatchSize).toBeLessThanOrEqual(64);
        expect(tuning.messageDecryptBatchSize).toBeGreaterThan(0);
        expect(tuning.messageDecryptBatchSize).toBeLessThanOrEqual(8);
        expect(tuning.messageDecryptYieldDelayMs).toBe(0);
        expect(tuning.encryptionAesBatchConcurrencyLimit).toBeGreaterThan(0);
        expect(tuning.encryptionAesBatchConcurrencyLimit).toBeLessThanOrEqual(8);
        expect(tuning.sessionSocketApplyCoalescingEnabled).toBe(true);
        expect(tuning.sessionSocketApplyCoalescingWindowMs).toBeGreaterThan(0);
        expect(tuning.sessionSocketApplyCoalescingWindowMs).toBeLessThanOrEqual(32);
        expect(tuning.sessionSocketApplyCoalescingMaxBatchSize).toBeGreaterThan(1);
        expect(tuning.sessionListEagerHydrationCount).toBeLessThanOrEqual(4);
        expect(tuning.sessionListAppendEagerHydrationCount).toBe(50);
        expect(tuning.sessionListBackgroundHydrationApplyBatchSize).toBeGreaterThan(1);
        expect(tuning.sessionListBackgroundHydrationApplyBatchSize).toBeLessThanOrEqual(4);
        expect(tuning.sessionListBackgroundHydrationApplyFlushDelayMs).toBeGreaterThanOrEqual(
            tuning.sessionListBackgroundHydrationYieldDelayMs * tuning.sessionListBackgroundHydrationApplyBatchSize,
        );
        expect(tuning.sessionListBackgroundHydrationApplyFlushDelayMs).toBeLessThanOrEqual(96);
        expect(tuning.sessionListBackgroundHydrationYieldEveryRows).toBeGreaterThan(1);
        expect(tuning.sessionListBackgroundHydrationYieldEveryRows).toBeLessThanOrEqual(
            tuning.sessionListBackgroundHydrationApplyBatchSize,
        );
        expect(tuning.sessionRealtimeProjectionMode).toBe('enabled');
        expect((tuning as Record<string, unknown>).sidechainDemandHydrationConcurrencyLimit).toBe(2);
        expect(tuning.activityUpdateDebounceMs).toBeGreaterThanOrEqual(1_000);
        expect(tuning.activityUpdateDebounceMs).toBeLessThanOrEqual(15_000);
        expect(tuning.enrichedMarkdownRuntimePreloadRetryDelayMs).toBeGreaterThanOrEqual(1_000);
        expect(tuning.enrichedMarkdownRuntimePreloadRetryDelayMs).toBeLessThanOrEqual(300_000);
        expect(tuning.nativeCryptoWorkerMode).toBe('auto');
    });

    it('uses bounded transcript scroll defaults', () => {
        const tuning = loadSyncTuning();

        expect(tuning.transcriptWebInitialPinStabilizeMs).toBe(1500);
        expect(tuning.transcriptWebInitialPinRetryMilestonesMs).toEqual([16, 50, 100, 200, 400, 800]);
        expect(tuning.transcriptMaxTurnEntriesPerListItem).toBe(8);
        expect(tuning.transcriptOlderLoadSpinnerDelayMs).toBe(300);
        expect(tuning.transcriptOlderLoadCooldownMs).toBe(2000);
        expect(tuning.transcriptViewportAnchorCaptureDebounceMs).toBe(200);
        expect(tuning.transcriptViewportAnchorOlderLookupMaxLoads).toBe(6);
        expect(tuning.transcriptDerivedItemsCacheMaxSessions).toBe(16);
        expect(tuning.transcriptItemHeightCacheMaxEntries).toBe(1024);
        expect(tuning.transcriptForkedSnapshotCacheMaxSessions).toBe(64);
        expect(tuning.transcriptFlashListDrawDistance).toBe(0);
        expect(tuning.transcriptMountSettleQuiescentWindowMs).toBe(120);
        expect(tuning.transcriptMountSettleDimensionNoiseFloorPx).toBe(1);
        expect(tuning.transcriptMountSettleBottomDistanceNoiseFloorPx).toBe(2);
        expect(tuning.transcriptViewportTelemetryEnabled).toBe(false);
        expect(tuning.transcriptViewportTelemetryConsoleLog).toBe(false);
        expect(tuning.transcriptViewportTelemetryMaxEvents).toBe(512);
        expect(tuning.transcriptNativeOlderMessagesPageSize).toBe(64);
    });

    it('applies env JSON overrides', () => {
        const tuning = loadSyncTuning({
            env: {
                EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: JSON.stringify({
                    messageLargeGapSeq: 12,
                    transcriptForwardPrefetchThresholdPx: 34,
                    transcriptFlashListEstimatedItemSize: 222,
                    transcriptWebHotTailItemCount: 9,
                    transcriptMaxTurnEntriesPerListItem: 6,
                    transcriptWebInitialPinRetryMilestonesMs: [33, 11, 11, 55.9],
                    transcriptOlderLoadSpinnerDelayMs: 123,
                    transcriptOlderLoadCooldownMs: 321,
                    transcriptViewportAnchorCaptureDebounceMs: 125,
                    transcriptViewportAnchorOlderLookupMaxLoads: 2,
                    transcriptDerivedItemsCacheMaxSessions: 3,
                    transcriptItemHeightCacheMaxEntries: 333,
                    transcriptForkedSnapshotCacheMaxSessions: 17,
                    transcriptFlashListDrawDistance: 1800,
                    transcriptMountSettleQuiescentWindowMs: 240,
                    transcriptMountSettleDimensionNoiseFloorPx: 4,
                    transcriptMountSettleBottomDistanceNoiseFloorPx: 5,
                    transcriptViewportTelemetryEnabled: true,
                    transcriptViewportTelemetryConsoleLog: true,
                    transcriptViewportTelemetryMaxEvents: 1024,
                    transcriptNativeOlderMessagesPageSize: 37,
                    transcriptInitialFillBudgetMs: 4321,
                    transcriptInitialFillMaxNoProgressLoads: 7,
                    resumeConcurrencyLimit: 5,
                    sessionListBackgroundHydrationConcurrencyLimit: 2,
                    sessionListAppendEagerHydrationCount: 2,
                    sessionListBackgroundHydrationMaxRows: 11,
                    sessionViewportHydrationPriorityMaxRows: 6,
                    sessionListBackgroundHydrationYieldDelayMs: 3,
                    sessionListBackgroundHydrationYieldEveryRows: 3,
                    sessionListBackgroundHydrationApplyBatchSize: 4,
                    sessionListBackgroundHydrationApplyFlushDelayMs: 17,
                    initialMessageDecryptBatchSize: 7,
                    messageDecryptBatchSize: 5,
                    messageDecryptYieldDelayMs: 6,
                    encryptionAesBatchConcurrencyLimit: 6,
                    sessionSocketApplyCoalescingEnabled: false,
                    sessionSocketApplyCoalescingWindowMs: 24,
                    sessionSocketApplyCoalescingMaxBatchSize: 9,
                    sessionRealtimeProjectionMode: 'shadow',
                    sidechainDemandHydrationConcurrencyLimit: 3,
                    changesMaxPagesPerResume: 8,
                    webSyncInstanceLiveTtlMs: 12_000,
                    webSyncInstanceHeartbeatMs: 4_000,
                    webSyncInstanceCursorRetentionMs: 123_000,
                    webLifecycleHeartbeatTickMs: 31_000,
                    webLifecycleHeartbeatDriftMs: 61_000,
                    nativeInactiveCheckpointDebounceMs: 350,
                    activityUpdateDebounceMs: 4321,
                    safeCursorLagAlertMs: 301_000,
                    streamingMarkdownRepairWorkletTimeoutMs: 321,
                    enrichedMarkdownRuntimePreloadRetryDelayMs: 12_345,
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
        expect(tuning.transcriptMaxTurnEntriesPerListItem).toBe(6);
        expect(tuning.transcriptWebInitialPinRetryMilestonesMs).toEqual([11, 33, 55]);
        expect(tuning.transcriptOlderLoadSpinnerDelayMs).toBe(123);
        expect(tuning.transcriptOlderLoadCooldownMs).toBe(321);
        expect(tuning.transcriptViewportAnchorCaptureDebounceMs).toBe(125);
        expect(tuning.transcriptViewportAnchorOlderLookupMaxLoads).toBe(2);
        expect(tuning.transcriptDerivedItemsCacheMaxSessions).toBe(3);
        expect(tuning.transcriptItemHeightCacheMaxEntries).toBe(333);
        expect(tuning.transcriptForkedSnapshotCacheMaxSessions).toBe(17);
        expect(tuning.transcriptFlashListDrawDistance).toBe(1800);
        expect(tuning.transcriptMountSettleQuiescentWindowMs).toBe(240);
        expect(tuning.transcriptMountSettleDimensionNoiseFloorPx).toBe(4);
        expect(tuning.transcriptMountSettleBottomDistanceNoiseFloorPx).toBe(5);
        expect(tuning.transcriptViewportTelemetryEnabled).toBe(true);
        expect(tuning.transcriptViewportTelemetryConsoleLog).toBe(true);
        expect(tuning.transcriptViewportTelemetryMaxEvents).toBe(1024);
        expect(tuning.transcriptNativeOlderMessagesPageSize).toBe(37);
        expect(tuning.transcriptInitialFillBudgetMs).toBe(4321);
        expect(tuning.transcriptInitialFillMaxNoProgressLoads).toBe(7);
        expect(tuning.resumeConcurrencyLimit).toBe(5);
        expect(tuning.sessionListBackgroundHydrationConcurrencyLimit).toBe(2);
        expect(tuning.sessionListAppendEagerHydrationCount).toBe(2);
        expect(tuning).toMatchObject({ sessionListBackgroundHydrationMaxRows: 11 });
        expect(tuning.sessionViewportHydrationPriorityMaxRows).toBe(6);
        expect(tuning.sessionListBackgroundHydrationYieldDelayMs).toBe(3);
        expect(tuning.sessionListBackgroundHydrationYieldEveryRows).toBe(3);
        expect(tuning.sessionListBackgroundHydrationApplyBatchSize).toBe(4);
        expect(tuning.sessionListBackgroundHydrationApplyFlushDelayMs).toBe(17);
        expect(tuning.initialMessageDecryptBatchSize).toBe(7);
        expect(tuning.messageDecryptBatchSize).toBe(5);
        expect(tuning.messageDecryptYieldDelayMs).toBe(6);
        expect(tuning.encryptionAesBatchConcurrencyLimit).toBe(6);
        expect(tuning.sessionSocketApplyCoalescingEnabled).toBe(false);
        expect(tuning.sessionSocketApplyCoalescingWindowMs).toBe(24);
        expect(tuning.sessionSocketApplyCoalescingMaxBatchSize).toBe(9);
        expect(tuning.sessionRealtimeProjectionMode).toBe('shadow');
        expect((tuning as Record<string, unknown>).sidechainDemandHydrationConcurrencyLimit).toBe(3);
        expect(tuning.changesMaxPagesPerResume).toBe(8);
        expect(tuning.webSyncInstanceLiveTtlMs).toBe(12_000);
        expect(tuning.webSyncInstanceHeartbeatMs).toBe(4_000);
        expect(tuning.webSyncInstanceCursorRetentionMs).toBe(123_000);
        expect(tuning.webLifecycleHeartbeatTickMs).toBe(31_000);
        expect(tuning.webLifecycleHeartbeatDriftMs).toBe(61_000);
        expect(tuning.nativeInactiveCheckpointDebounceMs).toBe(350);
        expect(tuning.activityUpdateDebounceMs).toBe(4321);
        expect(tuning.safeCursorLagAlertMs).toBe(301_000);
        expect(tuning.streamingMarkdownRepairWorkletTimeoutMs).toBe(321);
        expect(tuning.enrichedMarkdownRuntimePreloadRetryDelayMs).toBe(12_345);
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

    it('keeps the projection routing rollback switch configurable', () => {
        const tuning = loadSyncTuning({
            env: {
                EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: JSON.stringify({
                    sessionRealtimeProjectionMode: 'disabled',
                }),
            },
        });

        expect(tuning.sessionRealtimeProjectionMode).toBe('disabled');
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
                    transcriptMaxTurnEntriesPerListItem: -1,
                    transcriptWebInitialPinRetryMilestonesMs: [0, -1, 25_000, Number.NaN, '100'],
                    transcriptOlderLoadSpinnerDelayMs: -1,
                    transcriptOlderLoadCooldownMs: -1,
                    transcriptViewportAnchorCaptureDebounceMs: -1,
                    transcriptViewportAnchorOlderLookupMaxLoads: -1,
                    transcriptDerivedItemsCacheMaxSessions: 0,
                    transcriptItemHeightCacheMaxEntries: 0,
                    transcriptForkedSnapshotCacheMaxSessions: 0,
                    transcriptFlashListDrawDistance: -1,
                    transcriptMountSettleQuiescentWindowMs: 1,
                    transcriptMountSettleDimensionNoiseFloorPx: -1,
                    transcriptMountSettleBottomDistanceNoiseFloorPx: -1,
                    transcriptViewportTelemetryEnabled: 'yes',
                    transcriptViewportTelemetryMaxEvents: 0,
                    transcriptNativeOlderMessagesPageSize: 0,
                    transcriptInitialFillBudgetMs: 10,
                    transcriptInitialFillMaxNoProgressLoads: 0,
                    resumeConcurrencyLimit: 0,
                    sessionListBackgroundHydrationConcurrencyLimit: 0,
                    sessionListAppendEagerHydrationCount: -1,
                    sessionListBackgroundHydrationMaxRows: -1,
                    sessionViewportHydrationPriorityMaxRows: -1,
                    sessionListBackgroundHydrationYieldDelayMs: -1,
                    sessionListBackgroundHydrationYieldEveryRows: 0,
                    sessionListBackgroundHydrationApplyBatchSize: 0,
                    sessionListBackgroundHydrationApplyFlushDelayMs: -1,
                    initialMessageDecryptBatchSize: 0,
                    messageDecryptBatchSize: 0,
                    messageDecryptYieldDelayMs: -1,
                    encryptionAesBatchConcurrencyLimit: 0,
                    sessionSocketApplyCoalescingEnabled: 'yes',
                    sessionSocketApplyCoalescingWindowMs: -1,
                    sessionSocketApplyCoalescingMaxBatchSize: 0,
                    sessionRealtimeProjectionMode: 'fast',
                    sidechainDemandHydrationConcurrencyLimit: 0,
                    changesMaxPagesPerResume: 0,
                    webSyncInstanceLiveTtlMs: 0,
                    webSyncInstanceHeartbeatMs: 0,
                    webSyncInstanceCursorRetentionMs: -1,
                    webLifecycleHeartbeatTickMs: 0,
                    webLifecycleHeartbeatDriftMs: -1,
                    nativeInactiveCheckpointDebounceMs: -1,
                    activityUpdateDebounceMs: 0,
                    safeCursorLagAlertMs: 0,
                    streamingMarkdownRepairWorkletTimeoutMs: 0,
                    enrichedMarkdownRuntimePreloadRetryDelayMs: 0,
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
        expect(tuning.transcriptMaxTurnEntriesPerListItem).toBeGreaterThan(0);
        expect(tuning.transcriptWebInitialPinRetryMilestonesMs).toEqual([16, 50, 100, 200, 400, 800]);
        expect(tuning.transcriptOlderLoadSpinnerDelayMs).toBe(300);
        expect(tuning.transcriptOlderLoadCooldownMs).toBe(2000);
        expect(tuning.transcriptViewportAnchorCaptureDebounceMs).toBe(200);
        expect(tuning.transcriptViewportAnchorOlderLookupMaxLoads).toBe(6);
        expect(tuning.transcriptDerivedItemsCacheMaxSessions).toBe(16);
        expect(tuning.transcriptItemHeightCacheMaxEntries).toBe(1024);
        expect(tuning.transcriptForkedSnapshotCacheMaxSessions).toBe(64);
        expect(tuning.transcriptFlashListDrawDistance).toBe(0);
        expect(tuning.transcriptMountSettleQuiescentWindowMs).toBe(120);
        expect(tuning.transcriptMountSettleDimensionNoiseFloorPx).toBe(1);
        expect(tuning.transcriptMountSettleBottomDistanceNoiseFloorPx).toBe(2);
        expect(tuning.transcriptViewportTelemetryEnabled).toBe(false);
        expect(tuning.transcriptViewportTelemetryMaxEvents).toBe(512);
        expect(tuning.transcriptNativeOlderMessagesPageSize).toBe(64);
        expect(tuning.transcriptInitialFillBudgetMs).toBeGreaterThanOrEqual(250);
        expect(tuning.transcriptInitialFillMaxNoProgressLoads).toBeGreaterThan(0);
        expect(tuning.resumeConcurrencyLimit).toBeGreaterThan(0);
        expect(tuning.sessionListBackgroundHydrationConcurrencyLimit).toBeGreaterThan(0);
        expect(tuning.sessionListAppendEagerHydrationCount).toBe(50);
        expect(tuning).toMatchObject({ sessionListBackgroundHydrationMaxRows: 0 });
        expect(tuning.sessionViewportHydrationPriorityMaxRows).toBeGreaterThan(0);
        expect(tuning.sessionViewportHydrationPriorityMaxRows).toBeLessThanOrEqual(8);
        expect(tuning.sessionListBackgroundHydrationYieldDelayMs).toBeGreaterThanOrEqual(8);
        expect(tuning.sessionListBackgroundHydrationYieldEveryRows).toBeGreaterThan(1);
        expect(tuning.sessionListBackgroundHydrationApplyBatchSize).toBeGreaterThan(1);
        expect(tuning.sessionListBackgroundHydrationApplyBatchSize).toBeLessThanOrEqual(4);
        expect(tuning.sessionListBackgroundHydrationApplyFlushDelayMs).toBeGreaterThanOrEqual(
            tuning.sessionListBackgroundHydrationYieldDelayMs * tuning.sessionListBackgroundHydrationApplyBatchSize,
        );
        expect(tuning.initialMessageDecryptBatchSize).toBeGreaterThan(0);
        expect(tuning.messageDecryptBatchSize).toBeGreaterThan(0);
        expect(tuning.messageDecryptYieldDelayMs).toBeGreaterThanOrEqual(0);
        expect(tuning.encryptionAesBatchConcurrencyLimit).toBeGreaterThan(0);
        expect(tuning.sessionSocketApplyCoalescingEnabled).toBe(true);
        expect(tuning.sessionSocketApplyCoalescingWindowMs).toBeGreaterThan(0);
        expect(tuning.sessionSocketApplyCoalescingMaxBatchSize).toBeGreaterThan(1);
        expect(tuning.sessionRealtimeProjectionMode).toBe('enabled');
        expect((tuning as Record<string, unknown>).sidechainDemandHydrationConcurrencyLimit).toBe(2);
        expect(tuning.changesMaxPagesPerResume).toBeGreaterThan(0);
        expect(tuning.webSyncInstanceLiveTtlMs).toBeGreaterThan(0);
        expect(tuning.webSyncInstanceHeartbeatMs).toBeGreaterThan(0);
        expect(tuning.webSyncInstanceCursorRetentionMs).toBeGreaterThan(0);
        expect(tuning.webLifecycleHeartbeatTickMs).toBe(30_000);
        expect(tuning.webLifecycleHeartbeatDriftMs).toBe(60_000);
        expect(tuning.nativeInactiveCheckpointDebounceMs).toBe(300);
        expect(tuning.activityUpdateDebounceMs).toBe(5000);
        expect(tuning.safeCursorLagAlertMs).toBe(300_000);
        expect(tuning.streamingMarkdownRepairWorkletTimeoutMs).toBeGreaterThan(0);
        expect(tuning.enrichedMarkdownRuntimePreloadRetryDelayMs).toBeGreaterThanOrEqual(1_000);
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

    it('preserves explicit disabled drawDistance overrides', () => {
        const tuning = loadSyncTuning({
            env: {
                EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: JSON.stringify({
                    transcriptFlashListDrawDistance: 0,
                }),
            },
        });

        expect(tuning.transcriptFlashListDrawDistance).toBe(0);
    });
});
