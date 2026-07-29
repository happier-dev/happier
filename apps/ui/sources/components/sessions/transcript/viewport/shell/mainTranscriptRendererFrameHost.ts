import {
    resolveMainTranscriptListShellFrame,
    type TranscriptListShellFrame,
} from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';

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
    layoutHeight: number;
    nativeID?: string;
    pinThresholdPx: number;
    platformOS: string;
    /**
     * Render-time session-entry snapshot intent. Legend's initial tail placement (and the
     * adapter's held-'end' seed) must consume THIS basis, not the live bottom-follow mode:
     * on a warm-instance session switch the mode ref still carries the previous session's
     * 'following' during the next session's first render, which mounted detached-anchored
     * entries at the tail and started a scroll war against the entry restore.
     */
    sessionEntryShouldFollowBottom: boolean;
}>): TranscriptListShellFrame {
    return resolveMainTranscriptListShellFrame({
        legendInitialScrollAtEnd: params.sessionEntryShouldFollowBottom,
        maintainScrollAtEndThreshold: resolveLegendMaintainScrollAtEndThreshold({
            layoutHeight: params.layoutHeight,
            pinThresholdPx: params.pinThresholdPx,
        }),
        nativeID: params.nativeID,
        platformOS: params.platformOS,
    });
}
