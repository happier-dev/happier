import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol';

const USAGE_LIMIT_RECOVERY_STALE_ACTIVITY_SKEW_MS = 1_000;

function normalizePositiveTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

export function hasMeaningfulActivityAfterRuntimeIssue(input: Readonly<{
    meaningfulActivityAt?: number | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
}>): boolean {
    const activityAt = normalizePositiveTimestamp(input.meaningfulActivityAt);
    const issueAt = normalizePositiveTimestamp(input.lastRuntimeIssue?.occurredAt)
        ?? normalizePositiveTimestamp(input.latestTurnStatusObservedAt);
    const latestTurnStatusObservedAt = normalizePositiveTimestamp(input.latestTurnStatusObservedAt);
    if (
        issueAt !== null
        && latestTurnStatusObservedAt !== null
        && (input.latestTurnStatus === 'failed' || input.latestTurnStatus === 'cancelled')
        && latestTurnStatusObservedAt <= issueAt + USAGE_LIMIT_RECOVERY_STALE_ACTIVITY_SKEW_MS
    ) {
        return false;
    }
    return activityAt !== null
        && issueAt !== null
        && activityAt > issueAt + USAGE_LIMIT_RECOVERY_STALE_ACTIVITY_SKEW_MS;
}
