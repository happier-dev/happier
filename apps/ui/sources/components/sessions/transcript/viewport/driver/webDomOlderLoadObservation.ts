import { TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX } from '@/components/sessions/transcript/_constants';
import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';

export type WebDomOlderLoadObservationTrigger = 'edge-reached' | 'scroll';

type WebDomOlderLoadObservationRequestedTrigger =
    | WebDomOlderLoadObservationTrigger
    | 'layout-committed';

export type WebDomOlderLoadObservationFacts = Readonly<{
    contentHeight: number;
    distanceFromBottom: number;
    layoutHeight: number;
    metrics: WebTranscriptScrollMetrics;
    offsetY: number;
    scrollable: boolean;
    trigger: WebDomOlderLoadObservationRequestedTrigger;
}>;

export function resolveWebDomOlderLoadObservationTrigger(params: Readonly<{
    requestedTrigger?: WebDomOlderLoadObservationTrigger;
    scrollTop: number;
}>): WebDomOlderLoadObservationTrigger {
    const isGenuineTopFrame =
        params.scrollTop >= 0 &&
        params.scrollTop <= TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX;
    return isGenuineTopFrame
        ? 'edge-reached'
        : params.requestedTrigger ?? 'scroll';
}

export function resolveWebDomOlderLoadObservation(params: Readonly<{
    requestedTrigger?: WebDomOlderLoadObservationRequestedTrigger;
    target: unknown;
    viewportGuardThresholdPx: number;
}>): WebDomOlderLoadObservationFacts | null {
    if (!isWebScrollElementLike(params.target)) return null;
    const metrics: WebTranscriptScrollMetrics = {
        element: params.target,
        scrollTop: params.target.scrollTop,
        scrollHeight: params.target.scrollHeight,
        clientHeight: params.target.clientHeight,
    };
    const distanceFromBottom = getWebTranscriptDistanceFromBottom(metrics);
    const trigger =
        params.requestedTrigger === 'layout-committed'
            ? params.requestedTrigger
            : resolveWebDomOlderLoadObservationTrigger({
                requestedTrigger: params.requestedTrigger,
                scrollTop: metrics.scrollTop,
            });
    const viewportGuardThresholdPx =
        Number.isFinite(params.viewportGuardThresholdPx)
            ? Math.max(0, params.viewportGuardThresholdPx)
            : 0;

    return {
        contentHeight: metrics.scrollHeight,
        distanceFromBottom,
        layoutHeight: metrics.clientHeight,
        metrics,
        offsetY: metrics.scrollTop,
        scrollable:
            isWebTranscriptScrollable(metrics, 1) &&
            distanceFromBottom > viewportGuardThresholdPx,
        trigger,
    };
}

function isWebScrollElementLike(value: unknown): value is HTMLElement {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<HTMLElement>;
    return (
        typeof candidate.scrollTop === 'number' &&
        typeof candidate.scrollHeight === 'number' &&
        typeof candidate.clientHeight === 'number'
    );
}
