export function resolveNextJumpToBottomDistanceVisibilityState(params: Readonly<{
    previousCommittedDistance: number;
    nextDistance: number;
    revealThresholdPx: number;
    viewportHeightPx?: number;
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
    const viewportHeight = params.viewportHeightPx ?? 0;
    const previousBeyondViewport = viewportHeight > 0 && previous > viewportHeight;
    const nextBeyondViewport = viewportHeight > 0 && next > viewportHeight;
    if (previousVisible === nextVisible && previousBeyondViewport === nextBeyondViewport) return previous;
    return nextVisible || nextBeyondViewport ? next : 0;
}
