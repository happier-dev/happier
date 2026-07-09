import type { TranscriptViewportTelemetryScrollReason } from '../../scroll/transcriptViewportTelemetry';
import type { WebTranscriptScrollMetrics } from '../../webTranscriptScrollMetrics';

export type WebViewportResizeObservation = Readonly<{
    nextWebMetrics: WebTranscriptScrollMetrics;
    previousWebMetrics: WebTranscriptScrollMetrics;
    reason: Extract<TranscriptViewportTelemetryScrollReason, 'viewport-resized'>;
}>;

function metricsChanged(
    previousMetrics: WebTranscriptScrollMetrics,
    nextMetrics: WebTranscriptScrollMetrics,
): boolean {
    return previousMetrics.clientHeight !== nextMetrics.clientHeight
        || previousMetrics.scrollHeight !== nextMetrics.scrollHeight
        || previousMetrics.scrollTop !== nextMetrics.scrollTop;
}

export function resolveWebViewportResizeObservation(params: Readonly<{
    nextMetrics: WebTranscriptScrollMetrics;
    previousMetrics: WebTranscriptScrollMetrics | null;
}>): WebViewportResizeObservation | null {
    if (!params.previousMetrics) return null;
    if (params.previousMetrics.element !== params.nextMetrics.element) return null;
    if (!metricsChanged(params.previousMetrics, params.nextMetrics)) return null;
    return {
        nextWebMetrics: params.nextMetrics,
        previousWebMetrics: params.previousMetrics,
        reason: 'viewport-resized',
    };
}
