import type {
    PrimaryTurnStatusV1,
    SessionRuntimeActivityState,
    SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

export const SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS = 120_000;
export const SESSION_OPTIMISTIC_PENDING_THINKING_MS = 15_000;
/**
 * Safety-net lifetime after the daemon accepts a resume request. The store keeps the explicit
 * marker for the entire in-flight RPC and normally clears it on authoritative post-attach state.
 */
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

/**
 * Whether the runtime that publishes this session's state is still there to publish it.
 *
 * One owner for "live", because it is the precondition of every claim derived from a report the
 * runtime made. An archived session is not live no matter what its last report said, so a consumer
 * that re-spells the rule as `active && online` reads an archived session's final in-progress
 * projection as work still happening.
 */
export function isLiveSessionRuntime(
    input: Pick<SessionRuntimePresentationInput, 'active' | 'presence' | 'archivedAt'>,
): boolean {
    const isArchived = typeof input.archivedAt === 'number' && Number.isFinite(input.archivedAt);
    return !isArchived && input.active === true && input.presence === 'online';
}

/**
 * Instant this session's runtime was last observed, once it is gone rather than merely quiet —
 * and `null` while it is live *or* while the gap is still short enough to be a reconnect blip.
 *
 * This is deliberately a death fact and never an inactivity verdict: work the runtime was
 * performing keeps its last reported state for as long as the runtime might still report again,
 * however long that is. Only crossing the same staleness bound the rest of the runtime story uses
 * turns "we have not heard from it" into "it is gone", which is what lets a consumer close work
 * that has no other closing path — nothing else can ever write the result of a call whose process
 * exited.
 *
 * One owner, because "gone since when" is the precondition of every such retirement and the
 * instant itself is the bound: a consumer must not retire evidence that is newer than it.
 */
export function readSessionRuntimeLostSinceMs(
    input: Pick<SessionRuntimePresentationInput, 'active' | 'presence' | 'archivedAt' | 'activeAt'>,
    nowMs: number,
): number | null {
    if (isLiveSessionRuntime(input)) return null;
    const lastObservedAtMs = normalizeRuntimeStatusTimestamp(input.activeAt);
    if (lastObservedAtMs === null) return null;
    return nowMs - lastObservedAtMs > SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS ? lastObservedAtMs : null;
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
    const isLiveRuntime = isLiveSessionRuntime(input);

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
