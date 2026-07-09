import {
    resolveTranscriptFlashListBottomMaintenanceDecision,
    type TranscriptFlashListBottomMaintenanceResult,
} from '@/components/sessions/transcript/scroll/transcriptFlashListBottomMaintenance';
import type { TranscriptBottomFollowMode } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type { TranscriptViewportTelemetryMvcpPolicy } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    resolveMainTranscriptListShellFrame,
    type TranscriptListShellFrame,
} from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';

export type MainTranscriptRendererFrameHost = Readonly<{
    frame: TranscriptListShellFrame;
    maintainVisibleContentPosition: TranscriptFlashListBottomMaintenanceResult;
    pauseOffsetCorrection: boolean;
    telemetryMvcpPolicy: TranscriptViewportTelemetryMvcpPolicy;
}>;

const TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT = 0.1;

function resolveLegendMaintainScrollAtEndThreshold(params: Readonly<{
    layoutHeight: number;
    pinThresholdPx: number;
}>): number {
    if (
        Number.isFinite(params.layoutHeight) &&
        params.layoutHeight > 0 &&
        Number.isFinite(params.pinThresholdPx) &&
        params.pinThresholdPx >= 0
    ) {
        return params.pinThresholdPx / params.layoutHeight;
    }
    return TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT;
}

export function resolveMainTranscriptRendererFrameHost(params: Readonly<{
    autoFollowWhenPinned: boolean;
    bottomFollowMode: TranscriptBottomFollowMode;
    configuredDrawDistance?: unknown;
    hasOpenViewportTransaction: boolean;
    layoutHeight: number;
    liveRegionActive: boolean;
    nativeEntryShouldUseBottomMaintenance: boolean;
    nativeID?: string;
    pinEnabled: boolean;
    pinThresholdPx: number;
    platformOS: string;
    targetWindowActive?: boolean;
}>): MainTranscriptRendererFrameHost {
    const bottomMaintenance = resolveTranscriptFlashListBottomMaintenanceDecision({
        autoFollowWhenPinned: params.autoFollowWhenPinned,
        bottomFollowMode: params.bottomFollowMode,
        hasOpenViewportTransaction: params.hasOpenViewportTransaction,
        layoutHeight: params.layoutHeight,
        liveRegionActive: params.liveRegionActive,
        nativeEntryShouldUseBottomMaintenance: params.nativeEntryShouldUseBottomMaintenance,
        pinEnabled: params.pinEnabled,
        pinThresholdPx: params.pinThresholdPx,
        platformIsWeb: params.platformOS === 'web',
        targetWindowActive: params.targetWindowActive,
    });
    const maintainVisibleContentPosition = bottomMaintenance.maintainVisibleContentPosition;

    return {
        frame: resolveMainTranscriptListShellFrame({
            configuredDrawDistance: params.configuredDrawDistance,
            listLayoutHeight: params.layoutHeight,
            maintainScrollAtEndThreshold: resolveLegendMaintainScrollAtEndThreshold({
                layoutHeight: params.layoutHeight,
                pinThresholdPx: params.pinThresholdPx,
            }),
            maintainVisibleContentPosition,
            nativeID: params.nativeID,
            pauseOffsetCorrection: bottomMaintenance.pauseOffsetCorrection,
            platformOS: params.platformOS,
        }),
        maintainVisibleContentPosition,
        pauseOffsetCorrection: bottomMaintenance.pauseOffsetCorrection,
        telemetryMvcpPolicy:
            params.platformOS === 'web'
                ? 'none'
                : resolveNativeTelemetryMvcpPolicy(maintainVisibleContentPosition),
    };
}

export function resolveNativeTelemetryMvcpPolicy(
    maintenance: TranscriptFlashListBottomMaintenanceResult,
): TranscriptViewportTelemetryMvcpPolicy {
    if (!maintenance) return 'default';
    if (
        'startRenderingFromBottom' in maintenance &&
        maintenance.startRenderingFromBottom === true
    ) {
        if (typeof maintenance.autoscrollToBottomThreshold === 'number') return 'autoscroll-threshold';
        return 'start-rendering-from-bottom';
    }
    return 'default';
}
