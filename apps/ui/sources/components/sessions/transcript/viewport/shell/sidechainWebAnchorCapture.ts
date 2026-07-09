import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';

export type SidechainWebLocalHeightChangeAnchor = Readonly<{
    metrics: WebTranscriptScrollMetrics;
    mode: 'preserve-position' | 'follow-bottom';
    sessionId: string;
}>;

function resolveWebTranscriptMetrics(element: HTMLElement | null | undefined): WebTranscriptScrollMetrics | null {
    if (!element) return null;
    const scrollTop = element.scrollTop;
    const scrollHeight = element.scrollHeight;
    const clientHeight = element.clientHeight;
    if (
        typeof scrollTop !== 'number' ||
        typeof scrollHeight !== 'number' ||
        typeof clientHeight !== 'number' ||
        !Number.isFinite(scrollTop) ||
        !Number.isFinite(scrollHeight) ||
        !Number.isFinite(clientHeight)
    ) {
        return null;
    }
    return {
        clientHeight,
        element,
        scrollHeight,
        scrollTop,
    };
}

export function resolveSidechainWebPrependAnchor(params: Readonly<{
    element: HTMLElement | null | undefined;
    pinThresholdPx: number;
}>): WebTranscriptScrollMetrics | null {
    const metrics = resolveWebTranscriptMetrics(params.element);
    if (!metrics) return null;
    if (!isWebTranscriptScrollable(metrics, 1)) return null;
    if (getWebTranscriptDistanceFromBottom(metrics) <= params.pinThresholdPx) return null;
    return metrics;
}

export function resolveSidechainWebLocalHeightChangeAnchor(params: Readonly<{
    element: HTMLElement | null | undefined;
    platformOS: string;
    resolveViewportGuardThresholdPx: (viewportPx: number) => number;
    sessionId: string;
}>): SidechainWebLocalHeightChangeAnchor | null {
    if (params.platformOS !== 'web') return null;
    const metrics = resolveWebTranscriptMetrics(params.element);
    if (!metrics) return null;
    if (!isWebTranscriptScrollable(metrics, 1)) return null;

    const viewportGuardThresholdPx = params.resolveViewportGuardThresholdPx(metrics.clientHeight);
    return {
        metrics,
        mode: getWebTranscriptDistanceFromBottom(metrics) <= viewportGuardThresholdPx
            ? 'follow-bottom'
            : 'preserve-position',
        sessionId: params.sessionId,
    };
}
