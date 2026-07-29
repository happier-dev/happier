import * as React from 'react';
import {
    configureTranscriptViewportTelemetryFromTuning,
    transcriptViewportTelemetry,
    type TranscriptViewportTelemetryWebTrigger,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import { sync } from '@/sync/sync';
import {
    resolveWebViewportTelemetryDiagnostics as resolveWebViewportTelemetryDiagnosticsRecord,
} from '@/components/sessions/transcript/viewport/telemetryHost/webDiagnostics';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    resolveWebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { TranscriptOlderPaginationSnapshot } from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import type { TranscriptNavigationRuntimeAnchor } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationRuntimeAnchors';

type MutableRef<T> = { current: T };

export function useTranscriptWebViewportTelemetryDiagnostics(params: Readonly<{
    chatListNativeId: string;
    listContentHeightRef: MutableRef<number>;
    listLayoutHeightRef: MutableRef<number>;
    olderPaginationSnapshotRef: MutableRef<TranscriptOlderPaginationSnapshot>;
    transcriptNavigationRuntimeAnchorsRef: MutableRef<readonly TranscriptNavigationRuntimeAnchor[]>;
    webScrollContainerRef: MutableRef<HTMLElement | null>;
}>) {
    const {
        chatListNativeId,
        listContentHeightRef,
        listLayoutHeightRef,
        olderPaginationSnapshotRef,
        transcriptNavigationRuntimeAnchorsRef,
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
        listContentHeight?: number;
        listLayoutHeight?: number;
        metrics?: WebTranscriptScrollMetrics | null;
        paginationPhase?: TranscriptOlderPaginationSnapshot['phase'];
        paginationSuspendedReasons?: TranscriptOlderPaginationSnapshot['suspendedReasons'];
        programmaticWebWrite: boolean;
        scrollable?: boolean;
        trigger: TranscriptViewportTelemetryWebTrigger;
    }>) => {
        return resolveWebViewportTelemetryDiagnosticsRecord({
            currentListContentHeight: listContentHeightRef.current,
            currentListLayoutHeight: listLayoutHeightRef.current,
            enabled: Boolean(resolveEnabledViewportTelemetryTuning()),
            listContentHeight: diagnosticParams.listContentHeight,
            listLayoutHeight: diagnosticParams.listLayoutHeight,
            metrics: diagnosticParams.metrics,
            paginationPhase: diagnosticParams.paginationPhase,
            paginationSnapshot: olderPaginationSnapshotRef.current,
            paginationSuspendedReasons: diagnosticParams.paginationSuspendedReasons,
            programmaticWebWrite: diagnosticParams.programmaticWebWrite,
            runtimeAnchors: transcriptNavigationRuntimeAnchorsRef.current,
            scrollable: diagnosticParams.scrollable,
            trigger: diagnosticParams.trigger,
        });
    }, [
        listContentHeightRef,
        listLayoutHeightRef,
        olderPaginationSnapshotRef,
        resolveEnabledViewportTelemetryTuning,
        transcriptNavigationRuntimeAnchorsRef,
    ]);

    return {
        resolveWebScrollMetrics,
        resolveWebViewportTelemetryDiagnostics,
    };
}
