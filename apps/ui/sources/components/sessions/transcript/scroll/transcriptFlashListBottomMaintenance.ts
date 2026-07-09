import type { TranscriptBottomFollowMode } from './transcriptBottomFollowMode';

export type TranscriptFlashListBottomMaintenanceResult =
    | undefined
    | {
        readonly startRenderingFromBottom: true;
        readonly autoscrollToBottomThreshold?: number;
        readonly animateAutoScrollToBottom?: false;
    };

export type TranscriptFlashListBottomMaintenanceDecision = Readonly<{
    maintainVisibleContentPosition: TranscriptFlashListBottomMaintenanceResult;
    pauseOffsetCorrection: boolean;
}>;

export type TranscriptFlashListBottomMaintenanceParams = Readonly<{
    autoFollowWhenPinned: boolean;
    bottomFollowMode: TranscriptBottomFollowMode;
    /** Single-owner rule (plan B3): MVCP autoscroll only while following AND no transaction open. */
    hasOpenViewportTransaction: boolean;
    layoutHeight: number;
    /**
     * Native edge-slot carve active (plan §12 #3). While following, the JS force-pin owns the
     * visual bottom and MVCP must not also autoscroll. While released, the live rows are moving
     * between recycler data and the edge slot, so FlashList's offset correction must be disabled
     * for that live-region window instead of correcting content below the reader. Omitted/false
     * keeps the normal prepend-preserving released branch unchanged.
     *
     * Scope (§3a): gated ONLY on the carve actively growing — NOT the whole active turn. A released
     * reader during an active turn whose carve is not growing keeps `applyOffsetCorrection` armed so
     * an older-page prepend preserves reading position (Invariant C). The remaining narrow conflict
     * (a prepend landing WHILE the carve grows) is resolved in the C3 native adapter by scoping the
     * suppression to below-anchor carve growth, validated on the runtime harness — never by disabling
     * all offset correction here.
     */
    liveRegionActive?: boolean;
    nativeEntryShouldUseBottomMaintenance: boolean;
    pinEnabled: boolean;
    pinThresholdPx: number;
    platformIsWeb: boolean;
    targetWindowActive?: boolean;
}>;

export function resolveTranscriptFlashListBottomMaintenanceDecision(
    params: TranscriptFlashListBottomMaintenanceParams,
): TranscriptFlashListBottomMaintenanceDecision {
    if (params.platformIsWeb) {
        return { maintainVisibleContentPosition: undefined, pauseOffsetCorrection: false };
    }
    if (!params.nativeEntryShouldUseBottomMaintenance) {
        return { maintainVisibleContentPosition: undefined, pauseOffsetCorrection: false };
    }
    if (params.targetWindowActive === true) {
        return {
            maintainVisibleContentPosition: { startRenderingFromBottom: true },
            pauseOffsetCorrection: false,
        };
    }
    if (
        params.liveRegionActive === true &&
        params.bottomFollowMode !== 'following'
    ) {
        // The native hot-tail carve is actively growing its live row at the visual bottom. For a
        // released reader, correcting that below-viewport growth is the near-bottom jiggle we must
        // avoid. NQA-F4 proved that disabling native MVCP unmounts FlashList's ScrollAnchor and
        // lets RN Fabric re-latch against stale 1e6 anchor state, so the native prop stays stable
        // and only FlashList's JS applyOffsetCorrection path is paused for this carve-active window.
        return {
            maintainVisibleContentPosition: { startRenderingFromBottom: true },
            pauseOffsetCorrection: true,
        };
    }

    if (params.bottomFollowMode !== 'following') {
        // Plan P1: prepends land while released/escaping — FlashList's key-based
        // applyOffsetCorrection (the MVCP half that preserves the reading position across
        // data changes) must stay armed. Omitting autoscrollToBottomThreshold (FlashList
        // default -1) keeps bottom autoscroll off, so growth can never pull the reader down.
        return {
            maintainVisibleContentPosition: { startRenderingFromBottom: true },
            pauseOffsetCorrection: false,
        };
    }

    if (!params.pinEnabled || !params.autoFollowWhenPinned || params.hasOpenViewportTransaction) {
        return {
            maintainVisibleContentPosition: { startRenderingFromBottom: true },
            pauseOffsetCorrection: false,
        };
    }

    if (params.liveRegionActive === true) {
        // Single pin owner (plan §12 #3): the JS force-pin owns the bottom while the carve is
        // active; keep MVCP prepend/top correction armed (startRenderingFromBottom) but withhold
        // the bottom autoscroll threshold so MVCP cannot fight the JS pin at the live tail.
        return {
            maintainVisibleContentPosition: { startRenderingFromBottom: true },
            pauseOffsetCorrection: false,
        };
    }

    const layoutHeight = normalizePositive(params.layoutHeight);
    if (layoutHeight == null) {
        return {
            maintainVisibleContentPosition: { startRenderingFromBottom: true },
            pauseOffsetCorrection: false,
        };
    }

    return {
        maintainVisibleContentPosition: {
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: clamp01(normalizeNonNegative(params.pinThresholdPx) / layoutHeight),
            animateAutoScrollToBottom: false,
        },
        pauseOffsetCorrection: false,
    };
}

export function resolveTranscriptFlashListBottomMaintenance(
    params: TranscriptFlashListBottomMaintenanceParams,
): TranscriptFlashListBottomMaintenanceResult {
    return resolveTranscriptFlashListBottomMaintenanceDecision(params).maintainVisibleContentPosition;
}

function normalizePositive(value: number): number | null {
    if (!Number.isFinite(value)) return null;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
}

function normalizeNonNegative(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.trunc(value));
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}
