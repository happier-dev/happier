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
    changesPageLimit: number;
    invalidateSyncBackoffMinDelayMs: number;
    invalidateSyncBackoffMaxDelayMs: number;
}>;

const WEB_STORAGE_KEY = 'HAPPIER_SYNC_TUNING_JSON';
const ENV_KEY = 'EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON';
// IMPORTANT: Expo only inlines EXPO_PUBLIC_* variables when accessed via dot notation.
// Avoid dynamic `process.env[key]` reads in production code paths.
const STATIC_EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON = process.env.EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON;

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

function readNumber(obj: Record<string, unknown>, key: keyof SyncTuning, opts: { min: number; max: number }): number | null {
    const v = obj[key as string];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const n = Math.trunc(v);
    if (n < opts.min || n > opts.max) return null;
    return n;
}

export function loadSyncTuning(opts?: {
    env?: Record<string, string | undefined>;
    readWebStorage?: (key: string) => string | null;
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
        changesPageLimit: 200,
        invalidateSyncBackoffMinDelayMs: 500,
        invalidateSyncBackoffMaxDelayMs: 30_000,
    };

    const webObj = parseJsonObject(readWebStorageValue(opts?.readWebStorage));
    const envObj = parseJsonObject(opts?.env ? opts.env[ENV_KEY] : STATIC_EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON);

    const merged: Record<string, unknown> = {
        ...defaults,
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
        changesPageLimit: readNumber(merged, 'changesPageLimit', { min: 1, max: 10_000 }) ?? defaults.changesPageLimit,
        invalidateSyncBackoffMinDelayMs: readNumber(merged, 'invalidateSyncBackoffMinDelayMs', { min: 50, max: 60_000 }) ?? defaults.invalidateSyncBackoffMinDelayMs,
        invalidateSyncBackoffMaxDelayMs: readNumber(merged, 'invalidateSyncBackoffMaxDelayMs', { min: 50, max: 10 * 60_000 }) ?? defaults.invalidateSyncBackoffMaxDelayMs,
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
