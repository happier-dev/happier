export const TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO = 0.2;
export const TRANSCRIPT_EDGE_PREFETCH_MIN_PX = 1;
export const TRANSCRIPT_EDGE_PREFETCH_MAX_PX = 50_000;

export type ResolveTranscriptEdgePrefetchThresholdPxInput = Readonly<{
    configuredPx: number;
    viewportPx: number;
    fallbackViewportRatio: number;
    minPx: number;
    maxPx: number;
}>;

function normalizeBound(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(0, Math.trunc(value));
}

function clampThresholdPx(value: number, minPx: number, maxPx: number): number {
    return Math.min(maxPx, Math.max(minPx, Math.trunc(value)));
}

export function resolveTranscriptEdgePrefetchThresholdPx(input: ResolveTranscriptEdgePrefetchThresholdPxInput): number {
    const minPx = normalizeBound(input.minPx, TRANSCRIPT_EDGE_PREFETCH_MIN_PX);
    const maxPx = Math.max(minPx, normalizeBound(input.maxPx, TRANSCRIPT_EDGE_PREFETCH_MAX_PX));

    if (input.configuredPx === 0) return 0;
    if (Number.isFinite(input.configuredPx) && input.configuredPx > 0) {
        return clampThresholdPx(input.configuredPx, minPx, maxPx);
    }

    if (
        !Number.isFinite(input.viewportPx) ||
        input.viewportPx <= 0 ||
        !Number.isFinite(input.fallbackViewportRatio) ||
        input.fallbackViewportRatio <= 0
    ) {
        return minPx;
    }

    return clampThresholdPx(input.viewportPx * input.fallbackViewportRatio, minPx, maxPx);
}
