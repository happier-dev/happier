import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol';

export const SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS = 120_000;

export type SessionRuntimeAttentionState =
    | 'idle'
    | 'working'
    | 'failed'
    | 'permission_required'
    | 'action_required';

export type SessionRuntimePresentationInput = Readonly<{
    active?: boolean | null;
    activeAt?: number | null;
    presence?: unknown;
    thinking?: boolean | null;
    thinkingAt?: number | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    meaningfulActivityAt?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    hasPendingPermissionRequests?: boolean | null;
    hasPendingUserActionRequests?: boolean | null;
    pendingRequestObservedAt?: number | null;
    nowMs?: number;
}>;

export type SessionRuntimePresentationState = Readonly<{
    attention: SessionRuntimeAttentionState;
    working: boolean;
    freshThinking: boolean;
    freshInProgress: boolean;
    freshPermissionRequired: boolean;
    freshActionRequired: boolean;
    terminalStatus: PrimaryTurnStatusV1 | null;
    hasTerminalPrimaryTurnProjection: boolean;
}>;

export type SessionRuntimePresenceFields = Readonly<{
    thinking: boolean;
    thinkingAt: number;
}>;

export function isFreshTimestamp(
    timestamp: number | null | undefined,
    nowMs: number,
    budgetMs: number,
): boolean {
    return typeof timestamp === 'number'
        && Number.isFinite(timestamp)
        && timestamp > 0
        && timestamp + budgetMs > nowMs;
}

export function normalizeRuntimeStatusTimestamp(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

export function hasTerminalPrimaryTurnStatus(status: PrimaryTurnStatusV1 | null | undefined): boolean {
    return status === 'completed' || status === 'cancelled' || status === 'failed';
}

function isLegacyThinkingBlockedByTurnProjection(latestTurnStatus: PrimaryTurnStatusV1 | null): boolean {
    return hasTerminalPrimaryTurnStatus(latestTurnStatus);
}

export function deriveSessionRuntimePresentationState(
    input: SessionRuntimePresentationInput,
): SessionRuntimePresentationState {
    const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs)
        ? input.nowMs
        : Date.now();
    const latestTurnStatus = input.latestTurnStatus ?? null;
    const hasTerminalPrimaryTurnProjection = hasTerminalPrimaryTurnStatus(latestTurnStatus);
    const terminalStatus = hasTerminalPrimaryTurnProjection ? latestTurnStatus : null;
    const freshInProgressSignals = readFreshInProgressRuntimeSignalTimestamps(input, nowMs);
    const thinkingAt = normalizeRuntimeStatusTimestamp(input.thinkingAt);
    const isLiveRuntime = input.active === true && input.presence === 'online';

    const freshInProgress = freshInProgressSignals.length > 0;

    const freshThinking =
        input.thinking === true
        && isLiveRuntime
        && thinkingAt !== null
        && isFreshTimestamp(thinkingAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)
        && !isLegacyThinkingBlockedByTurnProjection(latestTurnStatus);

    const working = freshInProgress || freshThinking;
    const pendingRequestObservedAt = normalizeRuntimeStatusTimestamp(input.pendingRequestObservedAt);
    const hasFreshPendingRequest =
        pendingRequestObservedAt !== null
        && isFreshTimestamp(pendingRequestObservedAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    const freshActionRequired =
        input.hasPendingUserActionRequests === true
        && isLiveRuntime
        && (working || hasFreshPendingRequest);
    const freshPermissionRequired =
        input.hasPendingPermissionRequests === true
        && isLiveRuntime
        && (working || hasFreshPendingRequest);

    const attention: SessionRuntimeAttentionState =
        latestTurnStatus === 'failed'
            ? 'failed'
            : freshActionRequired
            ? 'action_required'
            : freshPermissionRequired
                ? 'permission_required'
                : working
                    ? 'working'
                    : 'idle';

    return {
        attention,
        working,
        freshThinking,
        freshInProgress,
        freshPermissionRequired,
        freshActionRequired,
        terminalStatus,
        hasTerminalPrimaryTurnProjection,
    };
}

export function readFreshInProgressRuntimeSignalTimestamps(
    input: SessionRuntimePresentationInput,
    nowMs: number,
): readonly number[] {
    const latestTurnStatus = input.latestTurnStatus ?? null;
    const latestTurnStatusObservedAt = normalizeRuntimeStatusTimestamp(input.latestTurnStatusObservedAt);
    if (latestTurnStatus !== 'in_progress' || latestTurnStatusObservedAt === null) return [];

    const timestamps: number[] = [];
    if (isFreshTimestamp(latestTurnStatusObservedAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)) {
        timestamps.push(latestTurnStatusObservedAt);
    }
    const activeAt = normalizeRuntimeStatusTimestamp(input.activeAt);
    if (
        input.active === true
        && input.presence === 'online'
        && activeAt !== null
        && activeAt >= latestTurnStatusObservedAt
        && isFreshTimestamp(activeAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)
    ) {
        timestamps.push(activeAt);
    }
    return timestamps;
}

export function readSessionRuntimePresentationFreshnessTimestamps(
    input: SessionRuntimePresentationInput,
    nowMs: number,
): readonly number[] {
    const runtimePresentation = deriveSessionRuntimePresentationState({ ...input, nowMs });
    const timestamps: number[] = [];
    if (runtimePresentation.freshThinking) {
        const thinkingAt = normalizeRuntimeStatusTimestamp(input.thinkingAt);
        if (thinkingAt !== null) timestamps.push(thinkingAt);
    }
    timestamps.push(...readFreshInProgressRuntimeSignalTimestamps(input, nowMs));
    if (runtimePresentation.freshPermissionRequired || runtimePresentation.freshActionRequired) {
        const pendingRequestObservedAt = normalizeRuntimeStatusTimestamp(input.pendingRequestObservedAt);
        if (pendingRequestObservedAt !== null) timestamps.push(pendingRequestObservedAt);
    }
    return timestamps;
}

export function resolveSessionRuntimePresenceFields(
    input: Pick<SessionRuntimePresentationInput,
        'thinking' | 'thinkingAt' | 'latestTurnStatus' | 'latestTurnStatusObservedAt'>,
): SessionRuntimePresenceFields {
    const thinkingAt = normalizeRuntimeStatusTimestamp(input.thinkingAt) ?? 0;
    if (hasTerminalPrimaryTurnStatus(input.latestTurnStatus ?? null)) {
        return {
            thinking: false,
            thinkingAt: normalizeRuntimeStatusTimestamp(input.latestTurnStatusObservedAt) ?? thinkingAt,
        };
    }
    return {
        thinking: input.thinking === true,
        thinkingAt,
    };
}
