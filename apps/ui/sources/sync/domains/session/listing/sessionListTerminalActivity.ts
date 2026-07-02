export const SESSION_LIST_TERMINAL_ACTIVITY_SKEW_MS = 1_000;

export function hasActivityClearlyAfterTerminalProjection(
    meaningfulActivityAt: number | null | undefined,
    latestTurnStatusObservedAt: number | null | undefined,
): boolean {
    const activityAt = normalizePositiveTimestamp(meaningfulActivityAt);
    const observedAt = normalizePositiveTimestamp(latestTurnStatusObservedAt);
    return activityAt != null
        && observedAt != null
        && activityAt > observedAt + SESSION_LIST_TERMINAL_ACTIVITY_SKEW_MS;
}

function normalizePositiveTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}
