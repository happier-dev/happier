import type { TranscriptBottomFollowMode } from './transcriptBottomFollowMode';

export type TranscriptFlashListBottomMaintenanceResult =
    | undefined
    | {
        readonly startRenderingFromBottom: true;
        readonly autoscrollToBottomThreshold?: number;
        readonly animateAutoScrollToBottom?: false;
    };

export function resolveTranscriptFlashListBottomMaintenance(params: Readonly<{
    autoFollowWhenPinned: boolean;
    bottomFollowMode: TranscriptBottomFollowMode;
    /** Single-owner rule (plan B3): MVCP autoscroll only while following AND no transaction open. */
    hasOpenViewportTransaction: boolean;
    layoutHeight: number;
    nativeEntryShouldUseBottomMaintenance: boolean;
    pinEnabled: boolean;
    pinThresholdPx: number;
    platformIsWeb: boolean;
}>): TranscriptFlashListBottomMaintenanceResult {
    if (params.platformIsWeb) return undefined;
    if (!params.nativeEntryShouldUseBottomMaintenance) return undefined;
    if (params.bottomFollowMode !== 'following') {
        // Plan P1: prepends land while released/escaping — FlashList's key-based
        // applyOffsetCorrection (the MVCP half that preserves the reading position across
        // data changes) must stay armed. Omitting autoscrollToBottomThreshold (FlashList
        // default -1) keeps bottom autoscroll off, so growth can never pull the reader down.
        return { startRenderingFromBottom: true };
    }

    if (!params.pinEnabled || !params.autoFollowWhenPinned || params.hasOpenViewportTransaction) {
        return { startRenderingFromBottom: true };
    }

    const layoutHeight = normalizePositive(params.layoutHeight);
    if (layoutHeight == null) {
        return { startRenderingFromBottom: true };
    }

    return {
        startRenderingFromBottom: true,
        autoscrollToBottomThreshold: clamp01(normalizeNonNegative(params.pinThresholdPx) / layoutHeight),
        animateAutoScrollToBottom: false,
    };
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
