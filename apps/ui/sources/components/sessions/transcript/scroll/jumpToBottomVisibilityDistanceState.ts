export function resolveNextJumpToBottomDistanceVisibilityState(params: Readonly<{
    previousCommittedDistance: number;
    nextDistance: number;
    revealThresholdPx: number;
}>): number {
    const threshold = typeof params.revealThresholdPx === 'number' && Number.isFinite(params.revealThresholdPx)
        ? Math.max(0, Math.trunc(params.revealThresholdPx))
        : 0;
    const previous = typeof params.previousCommittedDistance === 'number' && Number.isFinite(params.previousCommittedDistance)
        ? Math.max(0, params.previousCommittedDistance)
        : 0;
    const next = typeof params.nextDistance === 'number' && Number.isFinite(params.nextDistance)
        ? Math.max(0, params.nextDistance)
        : 0;
    const previousVisible = previous >= threshold;
    const nextVisible = next >= threshold;
    if (previousVisible === nextVisible) return previous;
    return nextVisible ? next : 0;
}
