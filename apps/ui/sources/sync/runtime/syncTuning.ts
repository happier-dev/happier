import Constants from 'expo-constants';

// The external key is retained for persisted compatibility. `off` is the Legend default;
// `flashList` is the explicit compatibility escape hatch.
export type TranscriptLegendListSpikeSurface = 'off' | 'flashList';

/**
 * Which engine the session list's virtualized surface runs on.
 *
 * The transcript already runs on Legend; this is the same engine reached through the shared compat
 * seam, so the app has one list engine rather than two.
 *
 * Defaults to `flashList`. `legendList` is reachable and works, but is NOT the default: see below.
 *
 * Legend measured better on cells re-mounting across a screen transition (22 rows/214ms on the first
 * session open and none on repeats, against 25-26 rows on every navigation under FlashList). It also
 * blanks the list in narrow cases that FlashList never showed, and after a full investigation the
 * cause is still not understood.
 *
 * WHAT IS KNOWN, so nobody re-walks it:
 * - The engine does NOT lose its state. Holding Legend's own scroll state across the transition
 *   (through its `renderScrollComponent` seam) kept `scroll 1044 / start 22 / end 38` intact and the
 *   peeked list was STILL blank — the viewport was showing content 0-715, where the engine had
 *   rendered nothing. So the native scroll view moved and the engine faithfully followed it.
 * - The list does NOT unmount. A mount/unmount probe fired zero times across navigation.
 * - Ruled out by experiment: `recycleItems` (blanks at both values), `maintainVisibleContentPosition`
 *   (enabling it changed nothing), a zero-height layout on deactivation (`scrollLength` never left
 *   716), and `detachPreviousScreen` (a JS-stack option that native-stack does not accept).
 *   `contentInsetAdjustmentBehavior: 'never'` helps but is not sufficient (0/5 -> 3/4, then 3/6).
 * - Legend issues NO scroll command of its own: instrumenting `doScrollTo` recorded zero calls
 *   across 18 consecutive clean cycles.
 *
 * FlashList never showed this because it always agrees with the native offset by construction, so it
 * cannot render into a band the viewport is not showing. That is the whole difference.
 *
 * The seam stays so this is a one-line flip in either direction. Evidence:
 * `.project/reviews/2026-08-19-legend-session-list-blank/sentinel-scroll-offset.md`.
 */
export type SessionListVirtualizedEngine = 'flashList' | 'legendList';

export type SyncTuning = Readonly<{
    messageLargeGapSeq: number;
    messageMaxIncrementalPagesOnResume: number;
    messageForceSnapshotOfflineMs: number;
    sessionMessagesPageSize: number;
    transcriptNativeOlderMessagesPageSize: number;
    transcriptForwardPrefetchThresholdPx: number;
    transcriptBackwardPrefetchThresholdPx: number;
    /**
     * Item-space arm threshold for older-page prefetch on native lists (count of loaded
     * rows between the viewport and the older edge). Estimate-immune companion to the px
     * threshold: native canonical px offsets are derived from estimated content height,
     * whose error routinely swallows the px margin.
     */
    transcriptBackwardPrefetchThresholdItems: number;
    transcriptFlashListEstimatedItemSize: number;
    transcriptWebHotTailItemCount: number;
    transcriptNativeHotTailItemCount: number;
    transcriptLegendListSpikeSurface: TranscriptLegendListSpikeSurface;
    sessionListVirtualizedEngine: SessionListVirtualizedEngine;
    transcriptMaxTurnEntriesPerListItem: number;
    transcriptWebInitialPinStabilizeMs: number;
    transcriptWebInitialPinRetryIntervalMs: number;
    transcriptWebInitialPinRetryMilestonesMs: readonly number[];
    transcriptOlderLoadSpinnerDelayMs: number;
    transcriptOlderLoadCooldownMs: number;
    transcriptViewportAnchorCaptureDebounceMs: number;
    transcriptViewportAnchorOlderLookupMaxLoads: number;
    transcriptDerivedItemsCacheMaxSessions: number;
    transcriptItemHeightCacheMaxEntries: number;
    transcriptForkedSnapshotCacheMaxSessions: number;
    transcriptFlashListDrawDistance: number;
    transcriptMountSettleQuiescentWindowMs: number;
    transcriptMountSettleDimensionNoiseFloorPx: number;
    transcriptMountSettleBottomDistanceNoiseFloorPx: number;
    transcriptViewportTelemetryEnabled: boolean;
    transcriptViewportTelemetryConsoleLog: boolean;
    transcriptViewportTelemetryMaxEvents: number;
    transcriptInitialFillBudgetMs: number;
    transcriptInitialFillMaxNoProgressLoads: number;
    invalidateSyncAwaitTimeoutMs: number;
    resumeQuickInvalidateTimeoutMs: number;
    resumeConcurrencyLimit: number;
    bootstrapConcurrencyLimit: number;
    messageCatchUpConcurrencyLimit: number;
    sessionListHydrationConcurrencyLimit: number;
    machineDisplayHydrationConcurrencyLimit: number;
    machineDisplayEagerHydrationCount: number;
    machineDisplayBackgroundHydrationMaxRows: number;
    machineDisplayBackgroundHydrationApplyBatchSize: number;
    feedItemsRetentionMaxCount: number;
    artifactHeadsRetentionMaxCount: number;
    automationRunsRetentionMaxPerAutomation: number;
    sessionListEagerHydrationCount: number;
    sessionListAppendEagerHydrationCount: number;
    sessionListBackgroundHydrationConcurrencyLimit: number;
    sessionListBackgroundHydrationMaxRows: number;
    sessionViewportHydrationPriorityMaxRows: number;
    sessionListBackgroundHydrationYieldDelayMs: number;
    sessionListBackgroundHydrationYieldEveryRows: number;
    sessionListBackgroundHydrationApplyBatchSize: number;
    sessionListBackgroundHydrationApplyFlushDelayMs: number;
    initialMessageDecryptBatchSize: number;
    messageDecryptBatchSize: number;
    messageDecryptYieldDelayMs: number;
    encryptionAesBatchConcurrencyLimit: number;
    sessionSocketApplyCoalescingEnabled: boolean;
    sessionSocketApplyCoalescingWindowMs: number;
    sessionSocketApplyCoalescingMaxBatchSize: number;
    sessionRealtimeProjectionMode: 'disabled' | 'shadow' | 'enabled';
    /**
     * Bounded transcript retention: how many recently-viewed hydrated transcripts to keep
     * resident BEYOND mounted/live-consumer sessions. Older unprotected transcripts are
     * evicted and rehydrate through the normal first-open load pipeline on re-open.
     */
    sessionTranscriptRetentionRecentKeepCount: number;
    /** Minimum idle time since last view/mount release before a transcript may be evicted. */
    sessionTranscriptRetentionGraceMs: number;
    /** Debounce for the eviction sweep so rapid navigation does not thrash. */
    sessionTranscriptRetentionSweepDebounceMs: number;
    sidechainDemandHydrationConcurrencyLimit: number;
    changesPageLimit: number;
    changesMaxPagesPerResume: number;
    webSyncInstanceLiveTtlMs: number;
    webSyncInstanceHeartbeatMs: number;
    webSyncInstanceCursorRetentionMs: number;
    webLifecycleHeartbeatTickMs: number;
    webLifecycleHeartbeatDriftMs: number;
    nativeInactiveCheckpointDebounceMs: number;
    activityUpdateDebounceMs: number;
    safeCursorLagAlertMs: number;
    streamingMarkdownRepairWorkletTimeoutMs: number;
    enrichedMarkdownRuntimePreloadRetryDelayMs: number;
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

function readNumberArray(
    obj: Record<string, unknown>,
    key: keyof SyncTuning,
    opts: { min: number; max: number; maxLength: number },
): readonly number[] | null {
    const value = obj[key as string];
    if (!Array.isArray(value)) return null;
    if (value.length === 0 || value.length > opts.maxLength) return null;
    const numbers: number[] = [];
    for (const entry of value) {
        if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
        const n = Math.trunc(entry);
        if (n < opts.min || n > opts.max) return null;
        numbers.push(n);
    }
    return Array.from(new Set(numbers)).sort((left, right) => left - right);
}

function readBoolean(obj: Record<string, unknown>, key: keyof SyncTuning): boolean | null {
    const v = obj[key as string];
    return typeof v === 'boolean' ? v : null;
}

function readNativeCryptoWorkerMode(obj: Record<string, unknown>): SyncTuning['nativeCryptoWorkerMode'] | null {
    const value = obj.nativeCryptoWorkerMode;
    return value === 'off' || value === 'auto' || value === 'require' ? value : null;
}

function readSessionRealtimeProjectionMode(obj: Record<string, unknown>): SyncTuning['sessionRealtimeProjectionMode'] | null {
    const value = obj.sessionRealtimeProjectionMode;
    return value === 'disabled' || value === 'shadow' || value === 'enabled' ? value : null;
}

function readSessionListVirtualizedEngine(obj: Record<string, unknown>): SessionListVirtualizedEngine | null {
    const value = obj.sessionListVirtualizedEngine;
    if (value === 'legendList') return 'legendList';
    if (value === 'flashList') return 'flashList';
    return null;
}

function readTranscriptLegendListSpikeSurface(obj: Record<string, unknown>): TranscriptLegendListSpikeSurface | null {
    const value = obj.transcriptLegendListSpikeSurface;
    if (value === 'flashList') return 'flashList';
    if (value === 'off' || value === 'readOnly' || value === 'sidechain' || value === 'main') return 'off';
    return null;
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
        sessionMessagesPageSize: 150,
        transcriptNativeOlderMessagesPageSize: 64,
        transcriptForwardPrefetchThresholdPx: 800,
        transcriptBackwardPrefetchThresholdPx: 800,
        transcriptBackwardPrefetchThresholdItems: 12,
        transcriptFlashListEstimatedItemSize: 120,
        transcriptWebHotTailItemCount: 24,
        // Native hot/cold streaming carve-out (live-tail rows rendered in the inverted edge slot,
        // outside the recycler). The number is a hard ceiling on hot-tail items (see
        // buildTranscriptHotColdSegments#maxHotTailItems). 0 = OFF (all-in-FlashList); >0 = ON.
        //
        // INERT ON THE SHIPPED DEFAULT PATH — this 4 currently changes nothing. The carve is
        // FlashList-only: resolveTranscriptRenderWindowProjection gates it on
        // `rendererKind === 'flashList'`, and resolveTranscriptListRendererSelection returns the
        // Legend renderer unless `transcriptLegendListSpikeSurface === 'flashList'` (default 'off',
        // see below). Under Legend there is one chronological recycler projection and no edge slot,
        // so buildTranscriptHotColdSegments yields zero hot items and TranscriptHotTail renders
        // nothing. The value only takes effect when the FlashList transcript surface is selected
        // explicitly. Do not read it as a live streaming-path setting.
        //
        // WHAT IT DID ON THE FLASHLIST SURFACE (historical, pre-Legend): it eliminated
        // streaming-overlap (the growing row renders in real layout), fixed the composer-inset gap,
        // bounded the hot tail (no blank), and — critically — AUTO-FOLLOW: the inverted bottom pin
        // fires authoritatively on a pre-change following decision (mirrors web's
        // capture-before/write-after), beating FlashList MVCP's index-0 re-anchor.
        //
        // VALIDATION STATUS (FlashList surface only; never re-measured under Legend):
        // - iOS: DEVICE-VALIDATED (2026-06-15) — measured proof for overlap (dist≈0, was 2055px),
        //   multi-row hot-tail ordering on a complex turn, the deterministic synced pin, idle/finalize
        //   (no orphan), and scrolled-up readers not yanked; jump-to-bottom + entry-restore land flush.
        // - Android: DEVICE-VALIDATED (2026-06-16) — measured on a real Android device under the
        //   `rotate(180deg)` inverted transform (PlatformHelper.android, vs iOS/web `scaleY(-1)`): a
        //   genuine multi-row hot tail (hotCount=5) rendered oldest-top/newest-bottom (telemetry +
        //   component-tree + screenshots), the synced pin held the bottom (distanceFromBottom 0), and
        //   MVCP never re-anchored the carve insert (offsetCorrection-while-live = 0). Confirms the
        //   transform-agnostic involution argument: both `scaleY(-1)` and `rotate(180deg)` apply-twice
        //   to identity, so the nested-transform order-preservation holds identically on Android.
        // All fix logic is carve-gated (nativeHotTailHeightRef>0), so 0 remains a byte-for-byte fallback.
        //
        // NOTE for tests: the carve replaces the flag=0 inverted "zero-writes" design with the
        // authoritative force-pin design. `dev/testkit/harness/chatListHarness.ts` pins this to 0 in
        // its BASE so the flag=0-invariant inverted tests stay deterministic; the carve is covered by
        // explicit flag>0 tests + segments/webHotColdSplit/TranscriptHotTail. Detail:
        // .project/plans/native-streaming-hot-cold-split-scoping.md (§ON-path device findings).
        transcriptNativeHotTailItemCount: 4,
        transcriptLegendListSpikeSurface: 'off',
        sessionListVirtualizedEngine: 'flashList',
        transcriptMaxTurnEntriesPerListItem: 8,
        transcriptWebInitialPinStabilizeMs: 1500,
        transcriptWebInitialPinRetryIntervalMs: 250,
        transcriptWebInitialPinRetryMilestonesMs: [16, 50, 100, 200, 400, 800],
        transcriptOlderLoadSpinnerDelayMs: 300,
        transcriptOlderLoadCooldownMs: 2000,
        transcriptViewportAnchorCaptureDebounceMs: 200,
        transcriptViewportAnchorOlderLookupMaxLoads: 6,
        transcriptDerivedItemsCacheMaxSessions: 16,
        transcriptItemHeightCacheMaxEntries: 1024,
        transcriptForkedSnapshotCacheMaxSessions: 64,
        transcriptFlashListDrawDistance: 0,
        transcriptMountSettleQuiescentWindowMs: 120,
        transcriptMountSettleDimensionNoiseFloorPx: 1,
        transcriptMountSettleBottomDistanceNoiseFloorPx: 2,
        transcriptViewportTelemetryEnabled: false,
        transcriptViewportTelemetryConsoleLog: false,
        transcriptViewportTelemetryMaxEvents: 512,
        transcriptInitialFillBudgetMs: 2000,
        transcriptInitialFillMaxNoProgressLoads: 3,
        invalidateSyncAwaitTimeoutMs: 10_000,
        resumeQuickInvalidateTimeoutMs: 2500,
        resumeConcurrencyLimit: 2,
        bootstrapConcurrencyLimit: 3,
        messageCatchUpConcurrencyLimit: 1,
        sessionListHydrationConcurrencyLimit: 4,
        machineDisplayHydrationConcurrencyLimit: 4,
        machineDisplayEagerHydrationCount: 4,
        machineDisplayBackgroundHydrationMaxRows: 0,
        machineDisplayBackgroundHydrationApplyBatchSize: 4,
        feedItemsRetentionMaxCount: 500,
        artifactHeadsRetentionMaxCount: 1000,
        automationRunsRetentionMaxPerAutomation: 200,
        sessionListEagerHydrationCount: 4,
        sessionListAppendEagerHydrationCount: 50,
        sessionListBackgroundHydrationConcurrencyLimit: 1,
        sessionListBackgroundHydrationMaxRows: 0,
        sessionViewportHydrationPriorityMaxRows: 4,
        sessionListBackgroundHydrationYieldDelayMs: 16,
        sessionListBackgroundHydrationYieldEveryRows: 4,
        sessionListBackgroundHydrationApplyBatchSize: 4,
        sessionListBackgroundHydrationApplyFlushDelayMs: 64,
        initialMessageDecryptBatchSize: 64,
        messageDecryptBatchSize: 8,
        messageDecryptYieldDelayMs: 0,
        encryptionAesBatchConcurrencyLimit: 4,
        sessionSocketApplyCoalescingEnabled: true,
        sessionSocketApplyCoalescingWindowMs: 16,
        sessionSocketApplyCoalescingMaxBatchSize: 64,
        sessionRealtimeProjectionMode: 'enabled',
        sessionTranscriptRetentionRecentKeepCount: 3,
        sessionTranscriptRetentionGraceMs: 3 * 60 * 1000,
        sessionTranscriptRetentionSweepDebounceMs: 1_000,
        sidechainDemandHydrationConcurrencyLimit: 2,
        changesPageLimit: 200,
        changesMaxPagesPerResume: 5,
        webSyncInstanceLiveTtlMs: 45_000,
        webSyncInstanceHeartbeatMs: 15_000,
        webSyncInstanceCursorRetentionMs: 7 * 24 * 60 * 60 * 1000,
        webLifecycleHeartbeatTickMs: 30_000,
        webLifecycleHeartbeatDriftMs: 60_000,
        nativeInactiveCheckpointDebounceMs: 300,
        activityUpdateDebounceMs: 5_000,
        safeCursorLagAlertMs: 300_000,
        streamingMarkdownRepairWorkletTimeoutMs: 250,
        enrichedMarkdownRuntimePreloadRetryDelayMs: 30_000,
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
        sessionMessagesPageSize: readNumber(merged, 'sessionMessagesPageSize', { min: 1, max: 1000 }) ?? defaults.sessionMessagesPageSize,
        transcriptNativeOlderMessagesPageSize: readNumber(merged, 'transcriptNativeOlderMessagesPageSize', { min: 1, max: 1000 }) ?? defaults.transcriptNativeOlderMessagesPageSize,
        transcriptForwardPrefetchThresholdPx: readNumber(merged, 'transcriptForwardPrefetchThresholdPx', { min: 0, max: 50_000 }) ?? defaults.transcriptForwardPrefetchThresholdPx,
        transcriptBackwardPrefetchThresholdPx: readNumber(merged, 'transcriptBackwardPrefetchThresholdPx', { min: 0, max: 50_000 }) ?? defaults.transcriptBackwardPrefetchThresholdPx,
        transcriptBackwardPrefetchThresholdItems: readNumber(merged, 'transcriptBackwardPrefetchThresholdItems', { min: 1, max: 500 }) ?? defaults.transcriptBackwardPrefetchThresholdItems,
        transcriptFlashListEstimatedItemSize: readNumber(merged, 'transcriptFlashListEstimatedItemSize', { min: 20, max: 2000 }) ?? defaults.transcriptFlashListEstimatedItemSize,
        transcriptWebHotTailItemCount: readNumber(merged, 'transcriptWebHotTailItemCount', { min: 1, max: 200 }) ?? defaults.transcriptWebHotTailItemCount,
        transcriptNativeHotTailItemCount: readNumber(merged, 'transcriptNativeHotTailItemCount', { min: 0, max: 200 }) ?? defaults.transcriptNativeHotTailItemCount,
        transcriptLegendListSpikeSurface: readTranscriptLegendListSpikeSurface(merged) ?? defaults.transcriptLegendListSpikeSurface,
        sessionListVirtualizedEngine: readSessionListVirtualizedEngine(merged) ?? defaults.sessionListVirtualizedEngine,
        transcriptMaxTurnEntriesPerListItem: readNumber(merged, 'transcriptMaxTurnEntriesPerListItem', { min: 0, max: 200 }) ?? defaults.transcriptMaxTurnEntriesPerListItem,
        transcriptWebInitialPinStabilizeMs: readNumber(merged, 'transcriptWebInitialPinStabilizeMs', { min: 0, max: 20_000 }) ?? defaults.transcriptWebInitialPinStabilizeMs,
        transcriptWebInitialPinRetryIntervalMs: readNumber(merged, 'transcriptWebInitialPinRetryIntervalMs', { min: 16, max: 2000 }) ?? defaults.transcriptWebInitialPinRetryIntervalMs,
        transcriptWebInitialPinRetryMilestonesMs:
            readNumberArray(merged, 'transcriptWebInitialPinRetryMilestonesMs', { min: 0, max: 20_000, maxLength: 32 })
            ?? defaults.transcriptWebInitialPinRetryMilestonesMs,
        transcriptOlderLoadSpinnerDelayMs: readNumber(merged, 'transcriptOlderLoadSpinnerDelayMs', { min: 0, max: 20_000 }) ?? defaults.transcriptOlderLoadSpinnerDelayMs,
        transcriptOlderLoadCooldownMs: readNumber(merged, 'transcriptOlderLoadCooldownMs', { min: 0, max: 20_000 }) ?? defaults.transcriptOlderLoadCooldownMs,
        transcriptViewportAnchorCaptureDebounceMs: readNumber(merged, 'transcriptViewportAnchorCaptureDebounceMs', { min: 0, max: 20_000 }) ?? defaults.transcriptViewportAnchorCaptureDebounceMs,
        transcriptViewportAnchorOlderLookupMaxLoads: readNumber(merged, 'transcriptViewportAnchorOlderLookupMaxLoads', { min: 0, max: 10 }) ?? defaults.transcriptViewportAnchorOlderLookupMaxLoads,
        transcriptDerivedItemsCacheMaxSessions: readNumber(merged, 'transcriptDerivedItemsCacheMaxSessions', { min: 1, max: 64 }) ?? defaults.transcriptDerivedItemsCacheMaxSessions,
        transcriptItemHeightCacheMaxEntries: readNumber(merged, 'transcriptItemHeightCacheMaxEntries', { min: 1, max: 10_000 }) ?? defaults.transcriptItemHeightCacheMaxEntries,
        transcriptForkedSnapshotCacheMaxSessions: readNumber(merged, 'transcriptForkedSnapshotCacheMaxSessions', { min: 1, max: 256 }) ?? defaults.transcriptForkedSnapshotCacheMaxSessions,
        transcriptFlashListDrawDistance: readNumber(merged, 'transcriptFlashListDrawDistance', { min: 0, max: 50_000 }) ?? defaults.transcriptFlashListDrawDistance,
        transcriptMountSettleQuiescentWindowMs: readNumber(merged, 'transcriptMountSettleQuiescentWindowMs', { min: 16, max: 1000 }) ?? defaults.transcriptMountSettleQuiescentWindowMs,
        transcriptMountSettleDimensionNoiseFloorPx: readNumber(merged, 'transcriptMountSettleDimensionNoiseFloorPx', { min: 0, max: 64 }) ?? defaults.transcriptMountSettleDimensionNoiseFloorPx,
        transcriptMountSettleBottomDistanceNoiseFloorPx: readNumber(merged, 'transcriptMountSettleBottomDistanceNoiseFloorPx', { min: 0, max: 64 }) ?? defaults.transcriptMountSettleBottomDistanceNoiseFloorPx,
        transcriptViewportTelemetryEnabled: readBoolean(merged, 'transcriptViewportTelemetryEnabled') ?? defaults.transcriptViewportTelemetryEnabled,
        transcriptViewportTelemetryConsoleLog: readBoolean(merged, 'transcriptViewportTelemetryConsoleLog') ?? defaults.transcriptViewportTelemetryConsoleLog,
        transcriptViewportTelemetryMaxEvents: readNumber(merged, 'transcriptViewportTelemetryMaxEvents', { min: 1, max: 100_000 }) ?? defaults.transcriptViewportTelemetryMaxEvents,
        transcriptInitialFillBudgetMs: readNumber(merged, 'transcriptInitialFillBudgetMs', { min: 250, max: 20_000 }) ?? defaults.transcriptInitialFillBudgetMs,
        transcriptInitialFillMaxNoProgressLoads: readNumber(merged, 'transcriptInitialFillMaxNoProgressLoads', { min: 1, max: 50 }) ?? defaults.transcriptInitialFillMaxNoProgressLoads,
        invalidateSyncAwaitTimeoutMs: readNumber(merged, 'invalidateSyncAwaitTimeoutMs', { min: 250, max: 10 * 60_000 }) ?? defaults.invalidateSyncAwaitTimeoutMs,
        resumeQuickInvalidateTimeoutMs: readNumber(merged, 'resumeQuickInvalidateTimeoutMs', { min: 250, max: 10 * 60_000 }) ?? defaults.resumeQuickInvalidateTimeoutMs,
        resumeConcurrencyLimit: readNumber(merged, 'resumeConcurrencyLimit', { min: 1, max: 20 }) ?? defaults.resumeConcurrencyLimit,
        bootstrapConcurrencyLimit: readNumber(merged, 'bootstrapConcurrencyLimit', { min: 1, max: 20 }) ?? defaults.bootstrapConcurrencyLimit,
        messageCatchUpConcurrencyLimit: readNumber(merged, 'messageCatchUpConcurrencyLimit', { min: 1, max: 10 }) ?? defaults.messageCatchUpConcurrencyLimit,
        sessionListHydrationConcurrencyLimit: readNumber(merged, 'sessionListHydrationConcurrencyLimit', { min: 1, max: 20 }) ?? defaults.sessionListHydrationConcurrencyLimit,
        machineDisplayHydrationConcurrencyLimit: readNumber(merged, 'machineDisplayHydrationConcurrencyLimit', { min: 1, max: 20 }) ?? defaults.machineDisplayHydrationConcurrencyLimit,
        machineDisplayEagerHydrationCount: readNumber(merged, 'machineDisplayEagerHydrationCount', { min: 0, max: 200 }) ?? defaults.machineDisplayEagerHydrationCount,
        machineDisplayBackgroundHydrationMaxRows: readNumber(merged, 'machineDisplayBackgroundHydrationMaxRows', { min: 0, max: 200 }) ?? defaults.machineDisplayBackgroundHydrationMaxRows,
        machineDisplayBackgroundHydrationApplyBatchSize: readNumber(merged, 'machineDisplayBackgroundHydrationApplyBatchSize', { min: 1, max: 20 }) ?? defaults.machineDisplayBackgroundHydrationApplyBatchSize,
        feedItemsRetentionMaxCount: readNumber(merged, 'feedItemsRetentionMaxCount', { min: 1, max: 10_000 }) ?? defaults.feedItemsRetentionMaxCount,
        artifactHeadsRetentionMaxCount: readNumber(merged, 'artifactHeadsRetentionMaxCount', { min: 1, max: 10_000 }) ?? defaults.artifactHeadsRetentionMaxCount,
        automationRunsRetentionMaxPerAutomation: readNumber(merged, 'automationRunsRetentionMaxPerAutomation', { min: 1, max: 10_000 }) ?? defaults.automationRunsRetentionMaxPerAutomation,
        sessionListEagerHydrationCount: readNumber(merged, 'sessionListEagerHydrationCount', { min: 0, max: 200 }) ?? defaults.sessionListEagerHydrationCount,
        sessionListAppendEagerHydrationCount: readNumber(merged, 'sessionListAppendEagerHydrationCount', { min: 0, max: 200 }) ?? defaults.sessionListAppendEagerHydrationCount,
        sessionListBackgroundHydrationConcurrencyLimit: readNumber(merged, 'sessionListBackgroundHydrationConcurrencyLimit', { min: 1, max: 20 }) ?? defaults.sessionListBackgroundHydrationConcurrencyLimit,
        sessionListBackgroundHydrationMaxRows: readNumber(merged, 'sessionListBackgroundHydrationMaxRows', { min: 0, max: 200 }) ?? defaults.sessionListBackgroundHydrationMaxRows,
        sessionViewportHydrationPriorityMaxRows: readNumber(merged, 'sessionViewportHydrationPriorityMaxRows', { min: 0, max: 100 }) ?? defaults.sessionViewportHydrationPriorityMaxRows,
        sessionListBackgroundHydrationYieldDelayMs: readNumber(merged, 'sessionListBackgroundHydrationYieldDelayMs', { min: 0, max: 1_000 }) ?? defaults.sessionListBackgroundHydrationYieldDelayMs,
        sessionListBackgroundHydrationYieldEveryRows: readNumber(merged, 'sessionListBackgroundHydrationYieldEveryRows', { min: 1, max: 20 }) ?? defaults.sessionListBackgroundHydrationYieldEveryRows,
        sessionListBackgroundHydrationApplyBatchSize: readNumber(merged, 'sessionListBackgroundHydrationApplyBatchSize', { min: 1, max: 20 }) ?? defaults.sessionListBackgroundHydrationApplyBatchSize,
        sessionListBackgroundHydrationApplyFlushDelayMs: readNumber(merged, 'sessionListBackgroundHydrationApplyFlushDelayMs', { min: 0, max: 1_000 }) ?? defaults.sessionListBackgroundHydrationApplyFlushDelayMs,
        initialMessageDecryptBatchSize: readNumber(merged, 'initialMessageDecryptBatchSize', { min: 1, max: 1_000 }) ?? defaults.initialMessageDecryptBatchSize,
        messageDecryptBatchSize: readNumber(merged, 'messageDecryptBatchSize', { min: 1, max: 1_000 }) ?? defaults.messageDecryptBatchSize,
        messageDecryptYieldDelayMs: readNumber(merged, 'messageDecryptYieldDelayMs', { min: 0, max: 1_000 }) ?? defaults.messageDecryptYieldDelayMs,
        encryptionAesBatchConcurrencyLimit: readNumber(merged, 'encryptionAesBatchConcurrencyLimit', { min: 1, max: 16 }) ?? defaults.encryptionAesBatchConcurrencyLimit,
        sessionSocketApplyCoalescingEnabled: readBoolean(merged, 'sessionSocketApplyCoalescingEnabled') ?? defaults.sessionSocketApplyCoalescingEnabled,
        sessionSocketApplyCoalescingWindowMs: readNumber(merged, 'sessionSocketApplyCoalescingWindowMs', { min: 0, max: 200 }) ?? defaults.sessionSocketApplyCoalescingWindowMs,
        sessionSocketApplyCoalescingMaxBatchSize: readNumber(merged, 'sessionSocketApplyCoalescingMaxBatchSize', { min: 2, max: 1000 }) ?? defaults.sessionSocketApplyCoalescingMaxBatchSize,
        sessionRealtimeProjectionMode: readSessionRealtimeProjectionMode(merged) ?? defaults.sessionRealtimeProjectionMode,
        sessionTranscriptRetentionRecentKeepCount: readNumber(merged, 'sessionTranscriptRetentionRecentKeepCount', { min: 0, max: 200 }) ?? defaults.sessionTranscriptRetentionRecentKeepCount,
        sessionTranscriptRetentionGraceMs: readNumber(merged, 'sessionTranscriptRetentionGraceMs', { min: 0, max: 24 * 60 * 60 * 1000 }) ?? defaults.sessionTranscriptRetentionGraceMs,
        sessionTranscriptRetentionSweepDebounceMs: readNumber(merged, 'sessionTranscriptRetentionSweepDebounceMs', { min: 0, max: 60_000 }) ?? defaults.sessionTranscriptRetentionSweepDebounceMs,
        sidechainDemandHydrationConcurrencyLimit: readNumber(merged, 'sidechainDemandHydrationConcurrencyLimit', { min: 1, max: 8 }) ?? defaults.sidechainDemandHydrationConcurrencyLimit,
        changesPageLimit: readNumber(merged, 'changesPageLimit', { min: 1, max: 10_000 }) ?? defaults.changesPageLimit,
        changesMaxPagesPerResume: readNumber(merged, 'changesMaxPagesPerResume', { min: 1, max: 100 }) ?? defaults.changesMaxPagesPerResume,
        webSyncInstanceLiveTtlMs: readNumber(merged, 'webSyncInstanceLiveTtlMs', { min: 1_000, max: 24 * 60 * 60 * 1000 }) ?? defaults.webSyncInstanceLiveTtlMs,
        webSyncInstanceHeartbeatMs: readNumber(merged, 'webSyncInstanceHeartbeatMs', { min: 1_000, max: 60 * 60 * 1000 }) ?? defaults.webSyncInstanceHeartbeatMs,
        webSyncInstanceCursorRetentionMs: readNumber(merged, 'webSyncInstanceCursorRetentionMs', { min: 60_000, max: 365 * 24 * 60 * 60 * 1000 }) ?? defaults.webSyncInstanceCursorRetentionMs,
        webLifecycleHeartbeatTickMs: readNumber(merged, 'webLifecycleHeartbeatTickMs', { min: 1_000, max: 60 * 60 * 1000 }) ?? defaults.webLifecycleHeartbeatTickMs,
        webLifecycleHeartbeatDriftMs: readNumber(merged, 'webLifecycleHeartbeatDriftMs', { min: 1_000, max: 24 * 60 * 60 * 1000 }) ?? defaults.webLifecycleHeartbeatDriftMs,
        nativeInactiveCheckpointDebounceMs: readNumber(merged, 'nativeInactiveCheckpointDebounceMs', { min: 0, max: 10_000 }) ?? defaults.nativeInactiveCheckpointDebounceMs,
        activityUpdateDebounceMs: readNumber(merged, 'activityUpdateDebounceMs', { min: 1_000, max: 60_000 }) ?? defaults.activityUpdateDebounceMs,
        safeCursorLagAlertMs: readNumber(merged, 'safeCursorLagAlertMs', { min: 1_000, max: 24 * 60 * 60 * 1000 }) ?? defaults.safeCursorLagAlertMs,
        streamingMarkdownRepairWorkletTimeoutMs: readNumber(merged, 'streamingMarkdownRepairWorkletTimeoutMs', { min: 1, max: 10_000 }) ?? defaults.streamingMarkdownRepairWorkletTimeoutMs,
        enrichedMarkdownRuntimePreloadRetryDelayMs: readNumber(merged, 'enrichedMarkdownRuntimePreloadRetryDelayMs', { min: 1_000, max: 300_000 }) ?? defaults.enrichedMarkdownRuntimePreloadRetryDelayMs,
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
