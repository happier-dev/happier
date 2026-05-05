export const ACTIVITY_COMPLETION_RECENCY_WINDOW_MS = 30_000;

export function isRecentActivityCompletion(
    occurredAtMs: number | null | undefined,
    nowMs: number,
): occurredAtMs is number {
    return typeof occurredAtMs === 'number'
        && Number.isFinite(occurredAtMs)
        && occurredAtMs > 0
        && nowMs - occurredAtMs <= ACTIVITY_COMPLETION_RECENCY_WINDOW_MS;
}
