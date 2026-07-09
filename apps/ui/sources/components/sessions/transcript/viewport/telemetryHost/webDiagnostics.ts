import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { isWebTranscriptScrollable } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { TranscriptOlderPaginationSnapshot } from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import type {
    WebPrependTelemetryFacts,
    WebPrependTelemetryFactsInput,
} from '@/components/sessions/transcript/viewport/prepend/webPrependOwner';
import { resolveFirstVisibleWebAnchorTestId } from '@/components/sessions/transcript/viewport/visibility/webTranscriptNavigationVisibilityObserver';
import type { TranscriptNavigationRuntimeAnchor } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationRuntimeAnchors';

export function resolveWebViewportTelemetryDiagnostics(params: Readonly<{
    enabled: boolean;
    flashListContentHeight?: number;
    flashListLayoutHeight?: number;
    hotColdCounts: Readonly<{ coldCount: number; hotCount: number }>;
    items: WebPrependTelemetryFactsInput['items'];
    listContentHeight: number;
    listLayoutHeight: number;
    metrics?: WebTranscriptScrollMetrics | null;
    paginationSnapshot: TranscriptOlderPaginationSnapshot;
    paginationPhase?: TranscriptOlderPaginationSnapshot['phase'];
    paginationSuspendedReasons?: TranscriptOlderPaginationSnapshot['suspendedReasons'];
    programmaticWebWrite: boolean;
    runtimeAnchors: readonly TranscriptNavigationRuntimeAnchor[];
    scrollable?: boolean;
    trigger: 'scroll' | 'edge-reached' | 'restore' | 'prepend-restore' | 'jump';
    resolveWebPrependTelemetryFacts: (params: WebPrependTelemetryFactsInput) => WebPrependTelemetryFacts;
}>): Record<string, unknown> {
    if (!params.enabled) return {};
    const metrics = params.metrics ?? null;
    const webPrependFacts = params.resolveWebPrependTelemetryFacts({ items: params.items });
    return {
        trigger: params.trigger,
        ...(metrics ? {
            domScrollTop: metrics.scrollTop,
            domScrollHeight: metrics.scrollHeight,
            domClientHeight: metrics.clientHeight,
            firstVisibleAnchorTestId: resolveFirstVisibleWebAnchorTestId({
                anchors: params.runtimeAnchors,
                metrics,
            }) ?? 'none',
        } : {
            firstVisibleAnchorTestId: 'none',
        }),
        flashListContentHeight: params.flashListContentHeight ?? params.listContentHeight,
        flashListLayoutHeight: params.flashListLayoutHeight ?? params.listLayoutHeight,
        scrollable: params.scrollable ?? (metrics ? isWebTranscriptScrollable(metrics, 1) : false),
        paginationPhase: params.paginationPhase ?? params.paginationSnapshot.phase,
        paginationSuspendedReasons: params.paginationSuspendedReasons ?? params.paginationSnapshot.suspendedReasons,
        coldCount: params.hotColdCounts.coldCount,
        hotCount: params.hotColdCounts.hotCount,
        ...webPrependFacts,
        programmaticWebWrite: params.programmaticWebWrite,
    };
}
