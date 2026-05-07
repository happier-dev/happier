import Constants from 'expo-constants';

export type SyncTuning = Readonly<{
    messageLargeGapSeq: number;
    messageMaxIncrementalPagesOnResume: number;
    messageForceSnapshotOfflineMs: number;
    transcriptForwardPrefetchThresholdPx: number;
    transcriptBackwardPrefetchThresholdPx: number;
    transcriptFlashListEstimatedItemSize: number;
    transcriptWebHotTailItemCount: number;
    transcriptWebInitialPinStabilizeMs: number;
    transcriptWebInitialPinRetryIntervalMs: number;
    transcriptInitialFillBudgetMs: number;
    transcriptInitialFillMaxNoProgressLoads: number;
    invalidateSyncAwaitTimeoutMs: number;
    resumeQuickInvalidateTimeoutMs: number;
    resumeConcurrencyLimit: number;
    bootstrapConcurrencyLimit: number;
    messageCatchUpConcurrencyLimit: number;
    sessionListHydrationConcurrencyLimit: number;
    machineDisplayHydrationConcurrencyLimit: number;
    sessionListEagerHydrationCount: number;
    sessionListBackgroundHydrationConcurrencyLimit: number;
    sessionListBackgroundHydrationYieldDelayMs: number;
    sessionListBackgroundHydrationApplyBatchSize: number;
    sessionListBackgroundHydrationApplyFlushDelayMs: number;
    messageDecryptBatchSize: number;
    messageDecryptYieldDelayMs: number;
    encryptionAesBatchConcurrencyLimit: number;
    sessionSocketApplyCoalescingEnabled: boolean;
    sessionSocketApplyCoalescingWindowMs: number;
    sessionSocketApplyCoalescingMaxBatchSize: number;
    changesPageLimit: number;
    changesMaxPagesPerResume: number;
    webSyncInstanceLiveTtlMs: number;
    webSyncInstanceHeartbeatMs: number;
    webSyncInstanceCursorRetentionMs: number;
    webLifecycleHeartbeatTickMs: number;
    webLifecycleHeartbeatDriftMs: number;
    nativeInactiveCheckpointDebounceMs: number;
    safeCursorLagAlertMs: number;
    streamingMarkdownRepairWorkletTimeoutMs: number;
    invalidateSyncBackoffMinDelayMs: number;
    invalidateSyncBackoffMaxDelayMs: number;
    /**
     * Timeout for session-scoped RPC calls that the UI uses for active sessions
     * (e.g. steering-capable send paths).
     */
    sessionRpcTimeoutMs: number;
    /**
     * Timeout for socket emit-with-ack operations (message commits, etc.).
     */
    socketAckTimeoutMs: number;
    syncPerformanceTelemetryEnabled: boolean;
    syncPerformanceTelemetrySlowThresholdMs: number;
    syncPerformanceTelemetryFlushIntervalMs: number;
    nativeCryptoWorkerMode: 'off' | 'auto' | 'require';
    nativeCryptoWorkerMaxBatchSize: number;
    nativeCryptoWorkerMinBatchSize: number;
    nativeCryptoWorkerMinPayloadBytes: number;
    nativeCryptoWorkerTimeoutMs: number;
    nativeCryptoWorkerLogFallbacks: boolean;
    nativeCryptoWorkerTelemetryEnabled: boolean;
    nativeCryptoWorkerStreamingSampleRate: number;
    nativeCryptoWorkerCapabilityStalenessMs: number;
    jsThreadLagTelemetrySampleIntervalMs: number;
    jsThreadLagTelemetryThresholdMs: number;
    jsThreadLagTelemetryMaxSamples: number;
}>;

const WEB_STORAGE_KEY = 'HAPPIER_SYNC_TUNING_JSON';
const ENV_KEY = 'EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON';
// IMPORTANT: Expo only inlines EXPO_PUBLIC_* variables when accessed via dot notation.
// Avoid dynamic `process.env[key]` reads in production code paths.
const STATIC_EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON = process.env.EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON;

type ExpoConfigLike = Readonly<{
    extra?: Readonly<{
        app?: Readonly<{
            syncTuningJson?: unknown;
        }>;
        syncTuningJson?: unknown;
    }>;
}>;

function readWebStorageValue(readWebStorage?: (key: string) => string | null): string | null {
    if (readWebStorage) {
        return readWebStorage(WEB_STORAGE_KEY);
    }
    try {
        if (typeof window === 'undefined') return null;
        return window.localStorage?.getItem(WEB_STORAGE_KEY) ?? null;
    } catch {
        return null;
    }
}

function parseJsonObject(input: string | null | undefined): Record<string, unknown> | null {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

function readExpoConfigValue(readExpoConfig?: () => unknown): string | null {
    const config = (readExpoConfig ? readExpoConfig() : Constants.expoConfig) as ExpoConfigLike | null | undefined;
    const appValue = config?.extra?.app?.syncTuningJson;
    if (typeof appValue === 'string') return appValue;
    const rootValue = config?.extra?.syncTuningJson;
    return typeof rootValue === 'string' ? rootValue : null;
}

function readNumber(obj: Record<string, unknown>, key: keyof SyncTuning, opts: { min: number; max: number }): number | null {
    const v = obj[key as string];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const n = Math.trunc(v);
    if (n < opts.min || n > opts.max) return null;
    return n;
}

function readBoolean(obj: Record<string, unknown>, key: keyof SyncTuning): boolean | null {
    const v = obj[key as string];
    return typeof v === 'boolean' ? v : null;
}

function readNativeCryptoWorkerMode(obj: Record<string, unknown>): SyncTuning['nativeCryptoWorkerMode'] | null {
    const value = obj.nativeCryptoWorkerMode;
    return value === 'off' || value === 'auto' || value === 'require' ? value : null;
}

function readRatio(obj: Record<string, unknown>, key: keyof SyncTuning): number | null {
    const value = obj[key as string];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (value < 0 || value > 1) return null;
    return value;
}

export function loadSyncTuning(opts?: {
    env?: Record<string, string | undefined>;
    readWebStorage?: (key: string) => string | null;
    readExpoConfig?: () => unknown;
}): SyncTuning {
    const defaults: SyncTuning = {
        messageLargeGapSeq: 500,
        messageMaxIncrementalPagesOnResume: 3,
        messageForceSnapshotOfflineMs: 30 * 60 * 1000,
        transcriptForwardPrefetchThresholdPx: 800,
        transcriptBackwardPrefetchThresholdPx: 800,
        transcriptFlashListEstimatedItemSize: 120,
        transcriptWebHotTailItemCount: 24,
        transcriptWebInitialPinStabilizeMs: 8000,
        transcriptWebInitialPinRetryIntervalMs: 250,
        transcriptInitialFillBudgetMs: 2000,
        transcriptInitialFillMaxNoProgressLoads: 3,
        invalidateSyncAwaitTimeoutMs: 10_000,
        resumeQuickInvalidateTimeoutMs: 2500,
        resumeConcurrencyLimit: 2,
        bootstrapConcurrencyLimit: 3,
        messageCatchUpConcurrencyLimit: 1,
        sessionListHydrationConcurrencyLimit: 4,
        machineDisplayHydrationConcurrencyLimit: 4,
        sessionListEagerHydrationCount: 8,
        sessionListBackgroundHydrationConcurrencyLimit: 1,
        sessionListBackgroundHydrationYieldDelayMs: 0,
        sessionListBackgroundHydrationApplyBatchSize: 1,
        sessionListBackgroundHydrationApplyFlushDelayMs: 16,
        messageDecryptBatchSize: 8,
        messageDecryptYieldDelayMs: 0,
        encryptionAesBatchConcurrencyLimit: 4,
        sessionSocketApplyCoalescingEnabled: true,
        sessionSocketApplyCoalescingWindowMs: 16,
        sessionSocketApplyCoalescingMaxBatchSize: 64,
        changesPageLimit: 200,
        changesMaxPagesPerResume: 5,
        webSyncInstanceLiveTtlMs: 45_000,
        webSyncInstanceHeartbeatMs: 15_000,
        webSyncInstanceCursorRetentionMs: 7 * 24 * 60 * 60 * 1000,
        webLifecycleHeartbeatTickMs: 30_000,
        webLifecycleHeartbeatDriftMs: 60_000,
        nativeInactiveCheckpointDebounceMs: 300,
        safeCursorLagAlertMs: 300_000,
        streamingMarkdownRepairWorkletTimeoutMs: 250,
        invalidateSyncBackoffMinDelayMs: 500,
        invalidateSyncBackoffMaxDelayMs: 30_000,
        sessionRpcTimeoutMs: 7_500,
        socketAckTimeoutMs: 7_500,
        syncPerformanceTelemetryEnabled: false,
        syncPerformanceTelemetrySlowThresholdMs: 50,
        syncPerformanceTelemetryFlushIntervalMs: 30_000,
        nativeCryptoWorkerMode: 'auto',
        nativeCryptoWorkerMaxBatchSize: 64,
        nativeCryptoWorkerMinBatchSize: 1,
        nativeCryptoWorkerMinPayloadBytes: 512,
        nativeCryptoWorkerTimeoutMs: 5000,
        nativeCryptoWorkerLogFallbacks: false,
        nativeCryptoWorkerTelemetryEnabled: false,
        nativeCryptoWorkerStreamingSampleRate: 1,
        nativeCryptoWorkerCapabilityStalenessMs: 300_000,
        jsThreadLagTelemetrySampleIntervalMs: 50,
        jsThreadLagTelemetryThresholdMs: 50,
        jsThreadLagTelemetryMaxSamples: 512,
    };

    const webObj = parseJsonObject(readWebStorageValue(opts?.readWebStorage));
    const expoConfigObj = parseJsonObject(readExpoConfigValue(opts?.readExpoConfig));
    const envObj = parseJsonObject(opts?.env ? opts.env[ENV_KEY] : STATIC_EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON);

    const merged: Record<string, unknown> = {
        ...defaults,
        ...(expoConfigObj ?? {}),
        ...(webObj ?? {}),
        ...(envObj ?? {}),
    };

    const validated: SyncTuning = {
        messageLargeGapSeq: readNumber(merged, 'messageLargeGapSeq', { min: 1, max: 1_000_000 }) ?? defaults.messageLargeGapSeq,
        messageMaxIncrementalPagesOnResume: readNumber(merged, 'messageMaxIncrementalPagesOnResume', { min: 1, max: 100 }) ?? defaults.messageMaxIncrementalPagesOnResume,
        messageForceSnapshotOfflineMs: readNumber(merged, 'messageForceSnapshotOfflineMs', { min: 0, max: 365 * 24 * 60 * 60 * 1000 }) ?? defaults.messageForceSnapshotOfflineMs,
        transcriptForwardPrefetchThresholdPx: readNumber(merged, 'transcriptForwardPrefetchThresholdPx', { min: 0, max: 50_000 }) ?? defaults.transcriptForwardPrefetchThresholdPx,
        transcriptBackwardPrefetchThresholdPx: readNumber(merged, 'transcriptBackwardPrefetchThresholdPx', { min: 0, max: 50_000 }) ?? defaults.transcriptBackwardPrefetchThresholdPx,
        transcriptFlashListEstimatedItemSize: readNumber(merged, 'transcriptFlashListEstimatedItemSize', { min: 20, max: 2000 }) ?? defaults.transcriptFlashListEstimatedItemSize,
        transcriptWebHotTailItemCount: readNumber(merged, 'transcriptWebHotTailItemCount', { min: 1, max: 200 }) ?? defaults.transcriptWebHotTailItemCount,
        transcriptWebInitialPinStabilizeMs: readNumber(merged, 'transcriptWebInitialPinStabilizeMs', { min: 0, max: 20_000 }) ?? defaults.transcriptWebInitialPinStabilizeMs,
        transcriptWebInitialPinRetryIntervalMs: readNumber(merged, 'transcriptWebInitialPinRetryIntervalMs', { min: 16, max: 2000 }) ?? defaults.transcriptWebInitialPinRetryIntervalMs,
        transcriptInitialFillBudgetMs: readNumber(merged, 'transcriptInitialFillBudgetMs', { min: 250, max: 20_000 }) ?? defaults.transcriptInitialFillBudgetMs,
        transcriptInitialFillMaxNoProgressLoads: readNumber(merged, 'transcriptInitialFillMaxNoProgressLoads', { min: 1, max: 50 }) ?? defaults.transcriptInitialFillMaxNoProgressLoads,
        invalidateSyncAwaitTimeoutMs: readNumber(merged, 'invalidateSyncAwaitTimeoutMs', { min: 250, max: 10 * 60_000 }) ?? defaults.invalidateSyncAwaitTimeoutMs,
        resumeQuickInvalidateTimeoutMs: readNumber(merged, 'resumeQuickInvalidateTimeoutMs', { min: 250, max: 10 * 60_000 }) ?? defaults.resumeQuickInvalidateTimeoutMs,
        resumeConcurrencyLimit: readNumber(merged, 'resumeConcurrencyLimit', { min: 1, max: 20 }) ?? defaults.resumeConcurrencyLimit,
        bootstrapConcurrencyLimit: readNumber(merged, 'bootstrapConcurrencyLimit', { min: 1, max: 20 }) ?? defaults.bootstrapConcurrencyLimit,
        messageCatchUpConcurrencyLimit: readNumber(merged, 'messageCatchUpConcurrencyLimit', { min: 1, max: 10 }) ?? defaults.messageCatchUpConcurrencyLimit,
        sessionListHydrationConcurrencyLimit: readNumber(merged, 'sessionListHydrationConcurrencyLimit', { min: 1, max: 20 }) ?? defaults.sessionListHydrationConcurrencyLimit,
        machineDisplayHydrationConcurrencyLimit: readNumber(merged, 'machineDisplayHydrationConcurrencyLimit', { min: 1, max: 20 }) ?? defaults.machineDisplayHydrationConcurrencyLimit,
        sessionListEagerHydrationCount: readNumber(merged, 'sessionListEagerHydrationCount', { min: 0, max: 200 }) ?? defaults.sessionListEagerHydrationCount,
        sessionListBackgroundHydrationConcurrencyLimit: readNumber(merged, 'sessionListBackgroundHydrationConcurrencyLimit', { min: 1, max: 20 }) ?? defaults.sessionListBackgroundHydrationConcurrencyLimit,
        sessionListBackgroundHydrationYieldDelayMs: readNumber(merged, 'sessionListBackgroundHydrationYieldDelayMs', { min: 0, max: 1_000 }) ?? defaults.sessionListBackgroundHydrationYieldDelayMs,
        sessionListBackgroundHydrationApplyBatchSize: readNumber(merged, 'sessionListBackgroundHydrationApplyBatchSize', { min: 1, max: 20 }) ?? defaults.sessionListBackgroundHydrationApplyBatchSize,
        sessionListBackgroundHydrationApplyFlushDelayMs: readNumber(merged, 'sessionListBackgroundHydrationApplyFlushDelayMs', { min: 0, max: 1_000 }) ?? defaults.sessionListBackgroundHydrationApplyFlushDelayMs,
        messageDecryptBatchSize: readNumber(merged, 'messageDecryptBatchSize', { min: 1, max: 1_000 }) ?? defaults.messageDecryptBatchSize,
        messageDecryptYieldDelayMs: readNumber(merged, 'messageDecryptYieldDelayMs', { min: 0, max: 1_000 }) ?? defaults.messageDecryptYieldDelayMs,
        encryptionAesBatchConcurrencyLimit: readNumber(merged, 'encryptionAesBatchConcurrencyLimit', { min: 1, max: 16 }) ?? defaults.encryptionAesBatchConcurrencyLimit,
        sessionSocketApplyCoalescingEnabled: readBoolean(merged, 'sessionSocketApplyCoalescingEnabled') ?? defaults.sessionSocketApplyCoalescingEnabled,
        sessionSocketApplyCoalescingWindowMs: readNumber(merged, 'sessionSocketApplyCoalescingWindowMs', { min: 0, max: 200 }) ?? defaults.sessionSocketApplyCoalescingWindowMs,
        sessionSocketApplyCoalescingMaxBatchSize: readNumber(merged, 'sessionSocketApplyCoalescingMaxBatchSize', { min: 2, max: 1000 }) ?? defaults.sessionSocketApplyCoalescingMaxBatchSize,
        changesPageLimit: readNumber(merged, 'changesPageLimit', { min: 1, max: 10_000 }) ?? defaults.changesPageLimit,
        changesMaxPagesPerResume: readNumber(merged, 'changesMaxPagesPerResume', { min: 1, max: 100 }) ?? defaults.changesMaxPagesPerResume,
        webSyncInstanceLiveTtlMs: readNumber(merged, 'webSyncInstanceLiveTtlMs', { min: 1_000, max: 24 * 60 * 60 * 1000 }) ?? defaults.webSyncInstanceLiveTtlMs,
        webSyncInstanceHeartbeatMs: readNumber(merged, 'webSyncInstanceHeartbeatMs', { min: 1_000, max: 60 * 60 * 1000 }) ?? defaults.webSyncInstanceHeartbeatMs,
        webSyncInstanceCursorRetentionMs: readNumber(merged, 'webSyncInstanceCursorRetentionMs', { min: 60_000, max: 365 * 24 * 60 * 60 * 1000 }) ?? defaults.webSyncInstanceCursorRetentionMs,
        webLifecycleHeartbeatTickMs: readNumber(merged, 'webLifecycleHeartbeatTickMs', { min: 1_000, max: 60 * 60 * 1000 }) ?? defaults.webLifecycleHeartbeatTickMs,
        webLifecycleHeartbeatDriftMs: readNumber(merged, 'webLifecycleHeartbeatDriftMs', { min: 1_000, max: 24 * 60 * 60 * 1000 }) ?? defaults.webLifecycleHeartbeatDriftMs,
        nativeInactiveCheckpointDebounceMs: readNumber(merged, 'nativeInactiveCheckpointDebounceMs', { min: 0, max: 10_000 }) ?? defaults.nativeInactiveCheckpointDebounceMs,
        safeCursorLagAlertMs: readNumber(merged, 'safeCursorLagAlertMs', { min: 1_000, max: 24 * 60 * 60 * 1000 }) ?? defaults.safeCursorLagAlertMs,
        streamingMarkdownRepairWorkletTimeoutMs: readNumber(merged, 'streamingMarkdownRepairWorkletTimeoutMs', { min: 1, max: 10_000 }) ?? defaults.streamingMarkdownRepairWorkletTimeoutMs,
        invalidateSyncBackoffMinDelayMs: readNumber(merged, 'invalidateSyncBackoffMinDelayMs', { min: 50, max: 60_000 }) ?? defaults.invalidateSyncBackoffMinDelayMs,
        invalidateSyncBackoffMaxDelayMs: readNumber(merged, 'invalidateSyncBackoffMaxDelayMs', { min: 50, max: 10 * 60_000 }) ?? defaults.invalidateSyncBackoffMaxDelayMs,
        sessionRpcTimeoutMs: readNumber(merged, 'sessionRpcTimeoutMs', { min: 250, max: 10 * 60_000 }) ?? defaults.sessionRpcTimeoutMs,
        socketAckTimeoutMs: readNumber(merged, 'socketAckTimeoutMs', { min: 250, max: 10 * 60_000 }) ?? defaults.socketAckTimeoutMs,
        syncPerformanceTelemetryEnabled: readBoolean(merged, 'syncPerformanceTelemetryEnabled') ?? defaults.syncPerformanceTelemetryEnabled,
        syncPerformanceTelemetrySlowThresholdMs: readNumber(merged, 'syncPerformanceTelemetrySlowThresholdMs', { min: 1, max: 60_000 }) ?? defaults.syncPerformanceTelemetrySlowThresholdMs,
        syncPerformanceTelemetryFlushIntervalMs: readNumber(merged, 'syncPerformanceTelemetryFlushIntervalMs', { min: 1_000, max: 10 * 60_000 }) ?? defaults.syncPerformanceTelemetryFlushIntervalMs,
        nativeCryptoWorkerMode: readNativeCryptoWorkerMode(merged) ?? defaults.nativeCryptoWorkerMode,
        nativeCryptoWorkerMaxBatchSize: readNumber(merged, 'nativeCryptoWorkerMaxBatchSize', { min: 1, max: 512 }) ?? defaults.nativeCryptoWorkerMaxBatchSize,
        nativeCryptoWorkerMinBatchSize: readNumber(merged, 'nativeCryptoWorkerMinBatchSize', { min: 1, max: 512 }) ?? defaults.nativeCryptoWorkerMinBatchSize,
        nativeCryptoWorkerMinPayloadBytes: readNumber(merged, 'nativeCryptoWorkerMinPayloadBytes', { min: 0, max: 65_536 }) ?? defaults.nativeCryptoWorkerMinPayloadBytes,
        nativeCryptoWorkerTimeoutMs: readNumber(merged, 'nativeCryptoWorkerTimeoutMs', { min: 100, max: 60_000 }) ?? defaults.nativeCryptoWorkerTimeoutMs,
        nativeCryptoWorkerLogFallbacks: readBoolean(merged, 'nativeCryptoWorkerLogFallbacks') ?? defaults.nativeCryptoWorkerLogFallbacks,
        nativeCryptoWorkerTelemetryEnabled: readBoolean(merged, 'nativeCryptoWorkerTelemetryEnabled') ?? defaults.nativeCryptoWorkerTelemetryEnabled,
        nativeCryptoWorkerStreamingSampleRate: readRatio(merged, 'nativeCryptoWorkerStreamingSampleRate') ?? defaults.nativeCryptoWorkerStreamingSampleRate,
        nativeCryptoWorkerCapabilityStalenessMs: readNumber(merged, 'nativeCryptoWorkerCapabilityStalenessMs', { min: 1_000, max: 60 * 60_000 }) ?? defaults.nativeCryptoWorkerCapabilityStalenessMs,
        jsThreadLagTelemetrySampleIntervalMs: readNumber(merged, 'jsThreadLagTelemetrySampleIntervalMs', { min: 1, max: 60_000 }) ?? defaults.jsThreadLagTelemetrySampleIntervalMs,
        jsThreadLagTelemetryThresholdMs: readNumber(merged, 'jsThreadLagTelemetryThresholdMs', { min: 1, max: 60_000 }) ?? defaults.jsThreadLagTelemetryThresholdMs,
        jsThreadLagTelemetryMaxSamples: readNumber(merged, 'jsThreadLagTelemetryMaxSamples', { min: 1, max: 100_000 }) ?? defaults.jsThreadLagTelemetryMaxSamples,
    };

    // Normalize: max delay must be >= min delay.
    if (validated.invalidateSyncBackoffMaxDelayMs < validated.invalidateSyncBackoffMinDelayMs) {
        return {
            ...validated,
            invalidateSyncBackoffMaxDelayMs: validated.invalidateSyncBackoffMinDelayMs,
        };
    }

    return validated;
}
