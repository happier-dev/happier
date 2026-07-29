import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { isWebTranscriptScrollable } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { TranscriptViewportTelemetryWebTrigger } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { TranscriptOlderPaginationSnapshot } from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import type { TranscriptNavigationRuntimeAnchor } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationRuntimeAnchors';

export function resolveWebViewportTelemetryDiagnostics(params: Readonly<{
    currentListContentHeight: number;
    currentListLayoutHeight: number;
    enabled: boolean;
    listContentHeight?: number;
    listLayoutHeight?: number;
    metrics?: WebTranscriptScrollMetrics | null;
    paginationSnapshot: TranscriptOlderPaginationSnapshot;
    paginationPhase?: TranscriptOlderPaginationSnapshot['phase'];
    paginationSuspendedReasons?: TranscriptOlderPaginationSnapshot['suspendedReasons'];
    programmaticWebWrite: boolean;
    runtimeAnchors: readonly TranscriptNavigationRuntimeAnchor[];
    scrollable?: boolean;
    trigger: TranscriptViewportTelemetryWebTrigger;
}>): Record<string, unknown> {
    if (!params.enabled) return {};
    const metrics = params.metrics ?? null;
    return {
        trigger: params.trigger,
        // Navigation anchors are reported as a COUNT, not by sweeping the DOM for
        // the first visible anchor row: that sweep measured every mounted anchor
        // with getBoundingClientRect on every diagnostics write. Anchor visibility
        // now lives in the navigation visibility store, derived in renderer index
        // space.
        navigationAnchorCount: params.runtimeAnchors.length,
        ...(metrics ? {
            domScrollTop: metrics.scrollTop,
            domScrollHeight: metrics.scrollHeight,
            domClientHeight: metrics.clientHeight,
        } : {}),
        listContentHeight: params.listContentHeight ?? params.currentListContentHeight,
        listLayoutHeight: params.listLayoutHeight ?? params.currentListLayoutHeight,
        scrollable: params.scrollable ?? (metrics ? isWebTranscriptScrollable(metrics, 1) : false),
        paginationPhase: params.paginationPhase ?? params.paginationSnapshot.phase,
        paginationSuspendedReasons: params.paginationSuspendedReasons ?? params.paginationSnapshot.suspendedReasons,
        programmaticWebWrite: params.programmaticWebWrite,
    };
}
