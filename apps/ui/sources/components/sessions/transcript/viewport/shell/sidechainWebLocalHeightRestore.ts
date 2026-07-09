import type { TranscriptOlderPaginationSnapshot } from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import {
    resolveTranscriptViewportTelemetryPlatform,
    type TranscriptViewportTelemetryEvent,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    isWebTranscriptScrollable,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    restoreWebDomLocalHeightChange,
    type WebDomLocalHeightChangeResult,
} from '@/components/sessions/transcript/viewport/driver/webDom';
import type { WebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import type { SidechainWebLocalHeightChangeAnchor } from './sidechainWebAnchorCapture';

type SidechainWebLocalHeightRestoreTelemetryEvent =
    Extract<TranscriptViewportTelemetryEvent, Readonly<{ type: 'scroll-write' }>> &
    Readonly<{
        coldCount: number;
        domClientHeight: number;
        domScrollHeight: number;
        domScrollTop: number;
        flashListContentHeight: number;
        flashListLayoutHeight: number;
        hotCount: 0;
        paginationPhase: TranscriptOlderPaginationSnapshot['phase'];
        paginationSuspendedReasons: TranscriptOlderPaginationSnapshot['suspendedReasons'];
        pendingWebPrependAnchorKind: 'none';
        programmaticWebWrite: true;
        scrollable: boolean;
        trigger: 'restore';
    }>;

export function buildSidechainWebLocalHeightRestoreTelemetryEvent(params: Readonly<{
    anchor: SidechainWebLocalHeightChangeAnchor;
    flashListContentHeightPx: number;
    flashListLayoutHeightPx: number;
    itemCount: number;
    paginationSnapshot: TranscriptOlderPaginationSnapshot;
    platformOS: string;
    result: Extract<WebDomLocalHeightChangeResult, Readonly<{ ok: true }>>;
    timestampMs: number;
}>): SidechainWebLocalHeightRestoreTelemetryEvent {
    const { element } = params.anchor.metrics;
    return {
        type: 'scroll-write',
        writer: 'web-dom-restore',
        reason: 'content-size-change',
        sessionId: params.anchor.sessionId,
        platform: resolveTranscriptViewportTelemetryPlatform(params.platformOS),
        listImplementation: 'flash_v2',
        mode: params.anchor.mode === 'follow-bottom' ? 'follow-bottom' : 'restore-anchor',
        targetOffsetY: params.result.targetScrollTop,
        previousOffsetY: params.result.previousScrollTop,
        layoutHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
        distanceFromBottom: params.result.distanceFromBottom,
        trigger: 'restore',
        domScrollTop: element.scrollTop,
        domScrollHeight: element.scrollHeight,
        domClientHeight: element.clientHeight,
        flashListContentHeight: params.flashListContentHeightPx,
        flashListLayoutHeight: params.flashListLayoutHeightPx,
        scrollable: isWebTranscriptScrollable({
            element,
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
        }, 1),
        paginationPhase: params.paginationSnapshot.phase,
        paginationSuspendedReasons: params.paginationSnapshot.suspendedReasons,
        coldCount: params.itemCount,
        hotCount: 0,
        pendingWebPrependAnchorKind: 'none',
        programmaticWebWrite: true,
        timestampMs: params.timestampMs,
    };
}

export function applySidechainWebLocalHeightRestore(params: Readonly<{
    anchor: SidechainWebLocalHeightChangeAnchor;
    flashListContentHeightPx: number;
    flashListLayoutHeightPx: number;
    itemCount: number;
    paginationSnapshot: TranscriptOlderPaginationSnapshot;
    platformOS: string;
    recordTelemetry: (event: SidechainWebLocalHeightRestoreTelemetryEvent) => void;
    timestampMs: number;
    webDomObservation: WebDomScrollObservation;
}>): boolean {
    const result = restoreWebDomLocalHeightChange({
        capturedMetrics: params.anchor.metrics,
        mode: params.anchor.mode,
        observation: params.webDomObservation,
    });
    if (!result.ok) return false;

    params.recordTelemetry(buildSidechainWebLocalHeightRestoreTelemetryEvent({
        anchor: params.anchor,
        flashListContentHeightPx: params.flashListContentHeightPx,
        flashListLayoutHeightPx: params.flashListLayoutHeightPx,
        itemCount: params.itemCount,
        paginationSnapshot: params.paginationSnapshot,
        platformOS: params.platformOS,
        result,
        timestampMs: params.timestampMs,
    }));
    return true;
}
