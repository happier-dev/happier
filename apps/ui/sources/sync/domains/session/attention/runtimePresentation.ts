import type {
    PrimaryTurnStatusV1,
    SessionRuntimeActivityState,
    SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

export const SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS = 120_000;
export const SESSION_OPTIMISTIC_PENDING_THINKING_MS = 15_000;
export const SESSION_RESUMING_PRESENTATION_TIMEOUT_MS = 30_000;

export type SessionRuntimeAttentionState =
    | 'idle'
    | 'working'
    | 'failed'
    | 'permission_required'
    | 'action_required';

export type SessionRuntimeActivityPresentationState =
    | 'idle'
    | 'working'
    | 'backgroundActive';

export type SessionRuntimePresentationInput = Readonly<{
    active?: boolean | null;
    activeAt?: number | null;
    archivedAt?: number | null;
    presence?: unknown;
    thinking?: boolean | null;
    thinkingAt?: number | null;
    optimisticThinkingAt?: number | null;
    hasPendingUserMessages?: boolean | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    runtimeActivityState?: SessionRuntimeActivityState | null;
    runtimeActivityActiveCount?: number | null;
    runtimeActivityObservedAt?: number | null;
    runtimeActivityRevision?: number | null;
    meaningfulActivityAt?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    hasPendingPermissionRequests?: boolean | null;
    hasPendingUserActionRequests?: boolean | null;
    pendingRequestObservedAt?: number | null;
    nowMs?: number;
}>;

export type SessionRuntimePresentationState = Readonly<{
    attention: SessionRuntimeAttentionState;
    activityState: SessionRuntimeActivityPresentationState;
    working: boolean;
    backgroundActive: boolean;
    freshThinking: boolean;
    projectedTurnInProgress: boolean;
    freshProviderRuntimeActivity: boolean;
    freshOptimisticPendingUserMessage: boolean;
    freshPermissionRequired: boolean;
    freshActionRequired: boolean;
    terminalStatus: PrimaryTurnStatusV1 | null;
    hasTerminalPrimaryTurnProjection: boolean;
}>;

export type SessionRuntimePresenceFields = Readonly<{
    thinking: boolean;
    thinkingAt: number;
}>;

export type SessionRuntimeFreshnessSignal = Readonly<{
    timestamp: number;
    budgetMs: number;
    expiresAtMs: number;
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

export function hasProjectedActiveTurn(status: PrimaryTurnStatusV1 | null | undefined): boolean {
    return status === 'in_progress';
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
    const isArchived = typeof input.archivedAt === 'number' && Number.isFinite(input.archivedAt);
    const hasTerminalPrimaryTurnProjection = hasTerminalPrimaryTurnStatus(latestTurnStatus);
    const terminalStatus = hasTerminalPrimaryTurnProjection ? latestTurnStatus : null;
    const thinkingAt = normalizeRuntimeStatusTimestamp(input.thinkingAt);
    const optimisticThinkingAt = normalizeRuntimeStatusTimestamp(input.optimisticThinkingAt);
    const isLiveRuntime = !isArchived && input.active === true && input.presence === 'online';

    // The lifecycle projection is the canonical active-turn fact. It is cleared by
    // complete/fail/cancel (including daemon exit settlement), not elapsed wall time.
    const projectedTurnInProgress = !isArchived && hasProjectedActiveTurn(latestTurnStatus);
    const freshProviderRuntimeActivity = !isArchived && hasProviderRuntimeActivity(input);

    const freshThinking =
        input.thinking === true
        && isLiveRuntime
        && thinkingAt !== null
        && isFreshTimestamp(thinkingAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)
        && !isLegacyThinkingBlockedByTurnProjection(latestTurnStatus);

    const freshOptimisticPendingUserMessage =
        input.hasPendingUserMessages === true
        && isLiveRuntime
        && optimisticThinkingAt !== null
        && isFreshTimestamp(optimisticThinkingAt, nowMs, SESSION_OPTIMISTIC_PENDING_THINKING_MS)
        && !hasTerminalPrimaryTurnProjection;

    const working =
        projectedTurnInProgress
        || freshThinking
        || freshOptimisticPendingUserMessage;
    const backgroundActive = !working && freshProviderRuntimeActivity;
    const activityState: SessionRuntimeActivityPresentationState = working
        ? 'working'
        : backgroundActive
            ? 'backgroundActive'
            : 'idle';
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
        && isLiveRuntime;

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
        activityState,
        working,
        backgroundActive,
        freshThinking,
        projectedTurnInProgress,
        freshProviderRuntimeActivity,
        freshOptimisticPendingUserMessage,
        freshPermissionRequired,
        freshActionRequired,
        terminalStatus,
        hasTerminalPrimaryTurnProjection,
    };
}

export function readSessionRuntimePresentationFreshnessTimestamps(
    input: SessionRuntimePresentationInput,
    nowMs: number,
): readonly number[] {
    return readSessionRuntimePresentationFreshnessSignals(input, nowMs).map((signal) => signal.timestamp);
}

export function readSessionRuntimePresentationFreshnessExpirations(
    input: SessionRuntimePresentationInput,
    nowMs: number,
): readonly number[] {
    return readSessionRuntimePresentationFreshnessSignals(input, nowMs).map((signal) => signal.expiresAtMs);
}

export function readSessionRuntimePresentationFreshnessSignals(
    input: SessionRuntimePresentationInput,
    nowMs: number,
): readonly SessionRuntimeFreshnessSignal[] {
    const runtimePresentation = deriveSessionRuntimePresentationState({ ...input, nowMs });
    const signals: SessionRuntimeFreshnessSignal[] = [];
    const addFreshnessSignal = (timestamp: number | null | undefined, budgetMs: number) => {
        const normalizedTimestamp = normalizeRuntimeStatusTimestamp(timestamp);
        if (normalizedTimestamp === null) return;
        if (!isFreshTimestamp(normalizedTimestamp, nowMs, budgetMs)) return;
        signals.push({
            timestamp: normalizedTimestamp,
            budgetMs,
            expiresAtMs: normalizedTimestamp + budgetMs,
        });
    };

    if (runtimePresentation.freshThinking) {
        addFreshnessSignal(input.thinkingAt, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    }
    if (runtimePresentation.freshOptimisticPendingUserMessage) {
        addFreshnessSignal(input.optimisticThinkingAt, SESSION_OPTIMISTIC_PENDING_THINKING_MS);
    }
    if (runtimePresentation.freshActionRequired) {
        addFreshnessSignal(input.pendingRequestObservedAt, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    }
    return signals;
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

function hasProviderRuntimeActivity(input: SessionRuntimePresentationInput): boolean {
    return input.runtimeActivityState === 'active'
        && typeof input.runtimeActivityActiveCount === 'number'
        && Number.isFinite(input.runtimeActivityActiveCount)
        && input.runtimeActivityActiveCount > 0;
}
