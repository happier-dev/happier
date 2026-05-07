import {
    getWebTranscriptDistanceFromBottom,
    resolveWebTranscriptMaxScrollTop,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';

export type WebBottomFollowAdjustmentMode = 'following' | 'released' | 'jumping';

export type WebBottomFollowAdjustmentInput = Readonly<{
    mode: WebBottomFollowAdjustmentMode;
    nextMetrics: WebTranscriptScrollMetrics;
    previousMetrics: WebTranscriptScrollMetrics;
    recentUserIntent?: boolean;
    tolerancePx?: number;
    minAdjustmentPx?: number;
}>;

function resolveFiniteNonNegative(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, value)
        : fallback;
}

function clampScrollTop(value: number, maxScrollTop: number): number {
    return Math.max(0, Math.min(value, maxScrollTop));
}

export function resolveWebBottomFollowAdjustment(input: WebBottomFollowAdjustmentInput): number | null {
    if (input.mode !== 'following') return null;
    if (input.recentUserIntent === true) return null;

    const tolerancePx = resolveFiniteNonNegative(input.tolerancePx, 0);
    const previousDistanceFromBottom = getWebTranscriptDistanceFromBottom(input.previousMetrics);
    if (previousDistanceFromBottom > tolerancePx) return null;

    const nextMaxScrollTop = resolveWebTranscriptMaxScrollTop(input.nextMetrics);
    const targetScrollTop = clampScrollTop(nextMaxScrollTop - previousDistanceFromBottom, nextMaxScrollTop);
    const minAdjustmentPx = resolveFiniteNonNegative(input.minAdjustmentPx, 0.5);
    if (Math.abs(targetScrollTop - input.nextMetrics.scrollTop) < minAdjustmentPx) return null;

    return targetScrollTop;
}
