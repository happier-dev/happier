import type {
    OlderPaginationScrollTrigger,
} from '@/components/sessions/transcript/pagination/olderPaginationMachine';
import type {
    TranscriptOlderPaginationSnapshot,
    TranscriptOlderPaginationScrollMetrics,
} from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import {
    resolveTranscriptViewportTelemetryRendererFacts,
    resolveTranscriptViewportTelemetryPlatform,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type {
    TranscriptViewportTelemetryEvent,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type {
    TranscriptViewportObservedOffset,
} from '@/components/sessions/transcript/viewport/driver/transcriptViewportFacts';
import {
    resolveWebDomOlderLoadObservation,
} from '@/components/sessions/transcript/viewport/driver/webDomOlderLoadObservation';
import type {
    WebDomOlderLoadObservationFacts,
} from '@/components/sessions/transcript/viewport/driver/webDomOlderLoadObservation';
import type {
    WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { TranscriptListShellDataOrder } from './transcriptListShellCapabilities';

type SidechainWebScrollMetrics = Pick<WebTranscriptScrollMetrics, 'clientHeight' | 'scrollHeight' | 'scrollTop'>;

type SidechainWebOlderLoadObservationFacts =
    Omit<WebDomOlderLoadObservationFacts, 'metrics'> &
    Readonly<{ metrics: SidechainWebScrollMetrics }>;

export type SidechainOlderLoadTelemetryFacts = Readonly<{
    contentHeightPx: number;
    distanceFromBottomPx: number;
    itemCount: number;
    layoutHeightPx: number;
    offsetY: number;
    scrollable: boolean;
    trigger: OlderPaginationScrollTrigger;
    webMetrics: SidechainWebScrollMetrics | null;
}>;

export type SidechainOlderLoadObservationInput =
    | number
    | Readonly<{
        /** Estimate-immune item-space edge proximity (native; see the machine contract). */
        itemsToOlderEdge?: number | null;
        nativeObservedOffset?: TranscriptViewportObservedOffset | null;
        offsetY?: number;
        trigger?: OlderPaginationScrollTrigger;
        webObservation?: SidechainWebOlderLoadObservationFacts | null;
    }>;

export type SidechainOlderLoadIngressResult =
    | Readonly<{ ok: false; reason: 'missing_offset' | 'not_older_edge' }>
    | Readonly<{
        ok: true;
        observation: SidechainOlderLoadObservationInput;
        webElement: HTMLElement | null;
    }>;

export type SidechainOlderLoadObservationResult =
    | Readonly<{ ok: false; reason: 'invalid_offset' }>
    | Readonly<{
        ok: true;
        pagination: Readonly<{
            offsetY: number;
            scrollable: boolean;
            trigger?: OlderPaginationScrollTrigger;
            itemsToOlderEdge?: number | null;
        }>;
        telemetry: SidechainOlderLoadTelemetryFacts;
    }>;

export function applySidechainCommittedLayoutObservation(params: Readonly<{
    nativeObservedOffset: TranscriptViewportObservedOffset | null;
    onObservation: (observation: SidechainOlderLoadObservationInput) => void;
    platformOS: string;
    viewportGuardThresholdPx: number;
    webElement: unknown;
}>): boolean {
    if (params.platformOS === 'web') {
        const webObservation = resolveWebDomOlderLoadObservation({
            requestedTrigger: 'layout-committed',
            target: params.webElement,
            viewportGuardThresholdPx: params.viewportGuardThresholdPx,
        });
        if (!webObservation) return false;
        params.onObservation({
            offsetY: webObservation.offsetY,
            webObservation,
        });
        return true;
    }
    if (!params.nativeObservedOffset) return false;
    params.onObservation({
        nativeObservedOffset: params.nativeObservedOffset,
        offsetY: params.nativeObservedOffset.canonicalOffsetY,
        trigger: 'layout-committed',
    });
    return true;
}

type ScrollObservedTelemetryEvent = TranscriptViewportTelemetryEvent & Readonly<{ type: 'scroll-observed' }>;

export function resolveSidechainOlderLoadScrollEventObservation(params: Readonly<{
    event: unknown;
    viewportGuardThresholdPx: number;
}>): SidechainOlderLoadIngressResult {
    const nativeEventTarget = readNativeEventTarget(params.event);
    const topLevelEventTarget = readTopLevelEventTarget(params.event);
    const webObservationTarget = nativeEventTarget ?? topLevelEventTarget;
    const webObservation = resolveWebDomOlderLoadObservation({
        requestedTrigger: 'scroll',
        target: webObservationTarget,
        viewportGuardThresholdPx: params.viewportGuardThresholdPx,
    });
    if (webObservation) {
        return {
            ok: true,
            observation: {
                offsetY: webObservation.offsetY,
                webObservation,
            },
            webElement: webObservation.metrics.element,
        };
    }

    const offsetY =
        readFiniteNumber(readNativeEventContentOffsetY(params.event)) ??
        readScrollTop(nativeEventTarget) ??
        readScrollTop(topLevelEventTarget);
    if (offsetY === null) {
        return { ok: false, reason: 'missing_offset' };
    }

    return {
        ok: true,
        observation: {
            offsetY,
            trigger: 'scroll',
        },
        webElement: null,
    };
}

export function resolveSidechainOlderLoadEdgeReachedObservation(params: Readonly<{
    nativeObservedOffset?: TranscriptViewportObservedOffset | null;
    reachedEdge?: 'start' | 'end';
    resolveReachedEdge?: (edge: 'start' | 'end') => 'newer' | 'older';
    viewportGuardThresholdPx: number;
    webElement: unknown;
}>): SidechainOlderLoadIngressResult {
    if (
        !params.reachedEdge
        || !params.resolveReachedEdge
        || params.resolveReachedEdge(params.reachedEdge) !== 'older'
    ) {
        return { ok: false, reason: 'not_older_edge' };
    }
    const webObservation = resolveWebDomOlderLoadObservation({
        requestedTrigger: 'edge-reached',
        target: params.webElement,
        viewportGuardThresholdPx: params.viewportGuardThresholdPx,
    });
    if (webObservation) {
        return {
            ok: true,
            observation: {
                offsetY: webObservation.offsetY,
                trigger: webObservation.trigger,
                webObservation,
            },
            webElement: webObservation.metrics.element,
        };
    }

    const nativeObservedOffset = params.nativeObservedOffset ?? null;
    if (!nativeObservedOffset) {
        return { ok: false, reason: 'missing_offset' };
    }
    return {
        ok: true,
        observation: {
            nativeObservedOffset,
            offsetY: nativeObservedOffset.canonicalOffsetY,
            trigger: 'edge-reached',
        },
        webElement: null,
    };
}

export function resolveSidechainOlderLoadObservation(params: Readonly<{
    contentHeightPx: number;
    dataOrder: TranscriptListShellDataOrder;
    itemCount: number;
    layoutHeightPx: number;
    observation: SidechainOlderLoadObservationInput;
    platformOS: string;
    viewportGuardThresholdPx: number;
}>): SidechainOlderLoadObservationResult {
    const webObservation = typeof params.observation === 'number'
        ? null
        : params.observation.webObservation ?? null;
    const nativeObservedOffset =
        params.platformOS !== 'web' && typeof params.observation !== 'number'
            ? params.observation.nativeObservedOffset ?? null
            : null;
    const fallbackOffsetY =
        typeof params.observation === 'number'
            ? params.observation
            : params.observation.offsetY;
    const offsetY = webObservation?.offsetY ?? nativeObservedOffset?.canonicalOffsetY ?? fallbackOffsetY;
    if (typeof offsetY !== 'number' || !Number.isFinite(offsetY)) {
        return { ok: false, reason: 'invalid_offset' };
    }

    const trigger = webObservation?.trigger ?? (
        typeof params.observation === 'number'
            ? undefined
            : params.observation.trigger
    );
    const itemsToOlderEdge =
        typeof params.observation === 'number'
            ? null
            : params.observation.itemsToOlderEdge ?? null;
    const layoutHeightPx =
        params.platformOS === 'web' && webObservation
            ? webObservation.layoutHeight
            : params.layoutHeightPx;
    const contentHeightPx =
        params.platformOS === 'web' && webObservation
            ? webObservation.contentHeight
            : params.contentHeightPx;
    const normalizedOffsetY = normalizeSidechainOlderLoadOffset({
        dataOrder: params.dataOrder,
        nativeObservedOffset,
        offsetY,
        platformOS: params.platformOS,
        webObservation,
    });
    if (!Number.isFinite(normalizedOffsetY)) {
        return { ok: false, reason: 'invalid_offset' };
    }
    const webMetrics = webObservation?.metrics ?? null;

    if (layoutHeightPx <= 0 || contentHeightPx <= 0 || contentHeightPx <= layoutHeightPx) {
        return {
            ok: true,
            pagination: {
                offsetY: normalizedOffsetY,
                scrollable: false,
                trigger,
                itemsToOlderEdge,
            },
            telemetry: {
                contentHeightPx,
                distanceFromBottomPx: 0,
                itemCount: params.itemCount,
                layoutHeightPx,
                offsetY: normalizedOffsetY,
                scrollable: false,
                trigger: trigger ?? 'scroll',
                webMetrics,
            },
        };
    }

    const distanceFromBottomPx =
        params.platformOS === 'web' && webObservation
            ? webObservation.distanceFromBottom
            : nativeObservedOffset?.distanceFromLiveTailPx ??
                Math.max(0, Math.trunc(contentHeightPx - layoutHeightPx - normalizedOffsetY));
    const scrollable =
        params.platformOS === 'web' && webObservation
            ? webObservation.scrollable
            : distanceFromBottomPx > params.viewportGuardThresholdPx;

    return {
        ok: true,
        pagination: {
            offsetY: normalizedOffsetY,
            scrollable,
            trigger,
            itemsToOlderEdge,
        },
        telemetry: {
            contentHeightPx,
            distanceFromBottomPx,
            itemCount: params.itemCount,
            layoutHeightPx,
            offsetY: normalizedOffsetY,
            scrollable,
            trigger: trigger ?? 'scroll',
            webMetrics,
        },
    };
}

export function buildSidechainOlderLoadScrollObservedTelemetryEvent(params: Readonly<{
    listContentHeightPx: number;
    listLayoutHeightPx: number;
    paginationSnapshot: TranscriptOlderPaginationSnapshot;
    platformOS: string;
    sessionId: string;
    telemetry: SidechainOlderLoadTelemetryFacts;
    timestampMs: number;
}>): ScrollObservedTelemetryEvent {
    const webMetrics = params.telemetry.webMetrics;
    return {
        type: 'scroll-observed',
        sessionId: params.sessionId,
        platform: resolveTranscriptViewportTelemetryPlatform(params.platformOS),
        listImplementation: resolveTranscriptViewportTelemetryRendererFacts().listImplementation,
        mode: 'user-unpinned',
        reason: 'observed',
        offsetY: params.telemetry.offsetY,
        layoutHeight: params.telemetry.layoutHeightPx,
        contentHeight: params.telemetry.contentHeightPx,
        distanceFromBottom: params.telemetry.distanceFromBottomPx,
        trigger: params.telemetry.trigger,
        ...(webMetrics ? {
            domScrollTop: webMetrics.scrollTop,
            domScrollHeight: webMetrics.scrollHeight,
            domClientHeight: webMetrics.clientHeight,
        } : {}),
        listContentHeight: params.listContentHeightPx,
        listLayoutHeight: params.listLayoutHeightPx,
        scrollable: params.telemetry.scrollable,
        paginationPhase: params.paginationSnapshot.phase,
        paginationSuspendedReasons: params.paginationSnapshot.suspendedReasons,
        programmaticWebWrite: false,
        timestampMs: params.timestampMs,
    };
}

export function applySidechainOlderLoadObservation(params: Readonly<{
    contentHeightPx: number;
    dataOrder: TranscriptListShellDataOrder;
    listContentHeightPx: number;
    listLayoutHeightPx: number;
    getPaginationSnapshot: () => TranscriptOlderPaginationSnapshot;
    itemCount: number;
    layoutHeightPx: number;
    observation: SidechainOlderLoadObservationInput;
    onScrollObservation: (metrics: TranscriptOlderPaginationScrollMetrics) => void;
    platformOS: string;
    recordTelemetry?: ((event: ScrollObservedTelemetryEvent) => void) | null;
    sessionId: string;
    timestampMs: number;
    viewportGuardThresholdPx: number;
}>): boolean {
    const normalized = resolveSidechainOlderLoadObservation({
        contentHeightPx: params.contentHeightPx,
        dataOrder: params.dataOrder,
        itemCount: params.itemCount,
        layoutHeightPx: params.layoutHeightPx,
        observation: params.observation,
        platformOS: params.platformOS,
        viewportGuardThresholdPx: params.viewportGuardThresholdPx,
    });
    if (!normalized.ok) return false;

    params.onScrollObservation(normalized.pagination);

    if (params.platformOS === 'web' && params.recordTelemetry) {
        params.recordTelemetry(buildSidechainOlderLoadScrollObservedTelemetryEvent({
            listContentHeightPx: params.listContentHeightPx,
            listLayoutHeightPx: params.listLayoutHeightPx,
            paginationSnapshot: params.getPaginationSnapshot(),
            platformOS: params.platformOS,
            sessionId: params.sessionId,
            telemetry: normalized.telemetry,
            timestampMs: params.timestampMs,
        }));
    }

    return true;
}

function normalizeSidechainOlderLoadOffset(params: Readonly<{
    dataOrder: TranscriptListShellDataOrder;
    nativeObservedOffset: TranscriptViewportObservedOffset | null;
    offsetY: number;
    platformOS: string;
    webObservation: SidechainWebOlderLoadObservationFacts | null;
}>): number {
    if (params.platformOS === 'web' && params.webObservation) {
        return params.webObservation.offsetY;
    }
    if (params.platformOS !== 'web' && params.dataOrder === 'newest-first') {
        return params.nativeObservedOffset?.canonicalOffsetY ?? Number.NaN;
    }
    return params.offsetY;
}

function readNativeEventTarget(event: unknown): unknown {
    const nativeEvent = readObjectProperty(event, 'nativeEvent');
    return readObjectProperty(nativeEvent, 'target');
}

function readTopLevelEventTarget(event: unknown): unknown {
    return readObjectProperty(event, 'target');
}

function readNativeEventContentOffsetY(event: unknown): unknown {
    const nativeEvent = readObjectProperty(event, 'nativeEvent');
    const contentOffset = readObjectProperty(nativeEvent, 'contentOffset');
    return readObjectProperty(contentOffset, 'y');
}

function readScrollTop(target: unknown): number | null {
    return readFiniteNumber(readObjectProperty(target, 'scrollTop'));
}

function readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readObjectProperty(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object') return null;
    return (value as Record<string, unknown>)[key];
}
