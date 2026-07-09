import * as React from 'react';
import {
    configureTranscriptViewportTelemetryFromTuning,
    transcriptViewportTelemetry,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import { sync } from '@/sync/sync';
import {
    resolveWebViewportTelemetryDiagnostics as resolveWebViewportTelemetryDiagnosticsRecord,
} from '@/components/sessions/transcript/viewport/telemetryHost/webDiagnostics';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    resolveWebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { TranscriptOlderPaginationSnapshot } from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import type {
    WebPrependTelemetryFacts,
    WebPrependTelemetryFactsInput,
} from '@/components/sessions/transcript/viewport/prepend/webPrependOwner';
import type { TranscriptNavigationRuntimeAnchor } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationRuntimeAnchors';

type MutableRef<T> = { current: T };

export function useTranscriptWebViewportTelemetryDiagnostics(params: Readonly<{
    chatListNativeId: string;
    itemsRef: MutableRef<readonly ChatTranscriptListItem[]>;
    listContentHeightRef: MutableRef<number>;
    listLayoutHeightRef: MutableRef<number>;
    olderPaginationSnapshotRef: MutableRef<TranscriptOlderPaginationSnapshot>;
    resolveWebPrependTelemetryFactsRef: MutableRef<(params: WebPrependTelemetryFactsInput) => WebPrependTelemetryFacts>;
    transcriptNavigationRuntimeAnchorsRef: MutableRef<readonly TranscriptNavigationRuntimeAnchor[]>;
    webHotColdCountsRef: MutableRef<{ coldCount: number; hotCount: number }>;
    webScrollContainerRef: MutableRef<HTMLElement | null>;
}>) {
    const {
        chatListNativeId,
        itemsRef,
        listContentHeightRef,
        listLayoutHeightRef,
        olderPaginationSnapshotRef,
        resolveWebPrependTelemetryFactsRef,
        transcriptNavigationRuntimeAnchorsRef,
        webHotColdCountsRef,
        webScrollContainerRef,
    } = params;

    const resolveWebScrollMetrics = React.useCallback(() => {
        if (typeof document === 'undefined') return null;
        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;
        const root = document.getElementById(chatListNativeId);
        const metrics = resolveWebTranscriptScrollMetrics({
            root,
            cachedElement: webScrollContainerRef.current,
            win: window,
            minOverflowPx: 50,
            maxDescendants: 1800,
            maxAncestors: 30,
            pick: 'best',
            allowRootFallback: true,
            score: (el) => el.scrollHeight,
        });
        if (metrics) {
            webScrollContainerRef.current = metrics.element;
        }
        return metrics;
    }, [chatListNativeId, webScrollContainerRef]);

    const resolveEnabledViewportTelemetryTuning = React.useCallback(() => {
        const tuning = sync.getSyncTuning();
        configureTranscriptViewportTelemetryFromTuning(tuning);
        return transcriptViewportTelemetry.isEnabled() ? tuning : null;
    }, []);

    const resolveWebViewportTelemetryDiagnostics = React.useCallback((diagnosticParams: Readonly<{
        flashListContentHeight?: number;
        flashListLayoutHeight?: number;
        metrics?: WebTranscriptScrollMetrics | null;
        paginationPhase?: TranscriptOlderPaginationSnapshot['phase'];
        paginationSuspendedReasons?: TranscriptOlderPaginationSnapshot['suspendedReasons'];
        programmaticWebWrite: boolean;
        scrollable?: boolean;
        trigger: 'scroll' | 'edge-reached' | 'restore' | 'prepend-restore' | 'jump';
    }>) => {
        return resolveWebViewportTelemetryDiagnosticsRecord({
            enabled: Boolean(resolveEnabledViewportTelemetryTuning()),
            flashListContentHeight: diagnosticParams.flashListContentHeight,
            flashListLayoutHeight: diagnosticParams.flashListLayoutHeight,
            hotColdCounts: webHotColdCountsRef.current,
            items: itemsRef.current,
            listContentHeight: listContentHeightRef.current,
            listLayoutHeight: listLayoutHeightRef.current,
            metrics: diagnosticParams.metrics,
            paginationPhase: diagnosticParams.paginationPhase,
            paginationSnapshot: olderPaginationSnapshotRef.current,
            paginationSuspendedReasons: diagnosticParams.paginationSuspendedReasons,
            programmaticWebWrite: diagnosticParams.programmaticWebWrite,
            runtimeAnchors: transcriptNavigationRuntimeAnchorsRef.current,
            scrollable: diagnosticParams.scrollable,
            trigger: diagnosticParams.trigger,
            resolveWebPrependTelemetryFacts: (input) => resolveWebPrependTelemetryFactsRef.current(input),
        });
    }, [
        itemsRef,
        listContentHeightRef,
        listLayoutHeightRef,
        olderPaginationSnapshotRef,
        resolveEnabledViewportTelemetryTuning,
        resolveWebPrependTelemetryFactsRef,
        transcriptNavigationRuntimeAnchorsRef,
        webHotColdCountsRef,
    ]);

    return {
        resolveWebScrollMetrics,
        resolveWebViewportTelemetryDiagnostics,
    };
}
