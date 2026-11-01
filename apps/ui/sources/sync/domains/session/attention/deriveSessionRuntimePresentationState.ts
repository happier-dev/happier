import type {
    PrimaryTurnStatusV1,
    SessionRuntimeActivityState,
} from '@happier-dev/protocol';

export const SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS = 120_000;

/**
 * Bounded fallback lifetime after the daemon accepts a resume request.
 * The marker itself is set at initiation and intentionally remains active throughout the
 * potentially slow resume RPC. Post-attach activity normally clears it first; this bound keeps
 * an accepted request with no subsequent publisher activity from latching the indicator forever.
 */
export const SESSION_RESUMING_PRESENTATION_TIMEOUT_MS = 30_000;

export type SessionRuntimeActivityPresentationState = 'idle' | 'working' | 'backgroundActive';

export type SessionRuntimePresentationState = Readonly<{
    isOnline: boolean;
    isActive: boolean;
    hasTerminalMaterializedTurnStatus: boolean;
    terminalStatus: PrimaryTurnStatusV1 | null;
    freshThinking: boolean;
    freshInProgress: boolean;
    freshProviderRuntimeActivity: boolean;
    working: boolean;
    backgroundActive: boolean;
    /**
     * How many units of runtime activity are running while no foreground turn is, or `0`.
     *
     * The provider ledger already counts them and the projection already carries the integer
     * (`runtimeActivityActiveCount`) across the wire, the warm cache and the persisted schema; it
     * used to be collapsed to the boolean above one line before the only surface that speaks about
     * it, which is why the session could only ever say "working in background".
     *
     * It is an ATTESTED count, never a claim: it is non-zero only when the projection itself is
     * `active`, which the schema pins to `activeCount > 0`, and it is `0` whenever a foreground turn
     * owns the session, because the boolean it accompanies is.
     *
     * It counts runtime-activity units, NOT background commands specifically. The projection is the
     * sum of every contributor (`session/runtimeActivity/aggregate.ts`) — today the Claude provider
     * task ledger and running execution runs — so a surface may state the number but must not name
     * the kind.
     */
    backgroundActiveCount: number;
    activityState: SessionRuntimeActivityPresentationState;
    runtimeProjectionInProgress: boolean;
    runtimeActivelyWorking: boolean;
    freshPermissionRequired: boolean;
    freshActionRequired: boolean;
}>;

export type DeriveSessionRuntimePresentationStateInput = Readonly<{
    active?: boolean | null;
    activeAt?: number | null;
    archivedAt?: number | null;
    presence?: unknown;
    thinking?: boolean | null;
    thinkingAt?: number | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    latestReadyEventAt?: number | null;
    runtimeActivityState?: SessionRuntimeActivityState | null;
    runtimeActivityActiveCount?: number | null;
    runtimeActivityObservedAt?: number | null;
    runtimeActivityRevision?: number | null;
    meaningfulActivityAt?: number | null;
    hasPendingPermissionRequests?: boolean | null;
    hasPendingUserActionRequests?: boolean | null;
    pendingRequestObservedAt?: number | null;
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

/**
 * Whether the runtime that publishes this session's state is still there to publish it.
 *
 * One owner for "live", because it is the precondition of every claim derived from a report the
 * runtime made: the presentation state below, and the session-observation fact beside it. Two
 * consumers already re-decided it locally (`sessionListPlacementProjection`,
 * `sessionListRowStateSnapshot` both spell `isOnline && backgroundActive`) because the deriver did
 * not — which is the shape a split decision takes before it diverges.
 */
export function isLiveSessionRuntime(
    input: Pick<DeriveSessionRuntimePresentationStateInput, 'active' | 'presence' | 'archivedAt'>,
): boolean {
    const isArchived = typeof input.archivedAt === 'number' && Number.isFinite(input.archivedAt);
    return !isArchived && input.active === true && input.presence === 'online';
}

/**
 * The instants that prove somebody was still observing this session's runtime, newest first.
 *
 * **`runtimeActivityObservedAt` is not a heartbeat.** The server stamps it only when the projected
 * `(state, activeCount)` pair actually changes — a semantic duplicate never rewrites storage — so a
 * background task that has been running for an hour legitimately carries an hour-old instant.
 * Ageing that instant out on its own would mark live work dead. These timestamps describe
 * observation uncertainty; publisher presence and explicit activity snapshots own liveness.
 *
 * The session keep-alive is the signal that genuinely repeats: the CLI pings every
 * `HAPPIER_SESSION_KEEPALIVE_IDLE_MS` (15 s by default, faster while a turn is in flight), which is
 * what advances `activeAt`. Either instant being recent means the claim is still witnessed.
 */
export function readSessionRuntimeObservationTimestamps(
    input: Pick<DeriveSessionRuntimePresentationStateInput, 'activeAt' | 'runtimeActivityObservedAt'>,
): readonly number[] {
    const timestamps: number[] = [];
    const activeAt = normalizeRuntimeStatusTimestamp(input.activeAt);
    if (activeAt !== null) timestamps.push(activeAt);
    const observedAt = normalizeRuntimeStatusTimestamp(input.runtimeActivityObservedAt);
    if (observedAt !== null) timestamps.push(observedAt);
    return timestamps;
}

export function deriveSessionRuntimePresentationState(
    input: DeriveSessionRuntimePresentationStateInput,
    nowMs: number,
): SessionRuntimePresentationState {
    const latestTurnStatus = input.latestTurnStatus ?? null;
    const isArchived = typeof input.archivedAt === 'number' && Number.isFinite(input.archivedAt);
    const freshInProgressSignals = isArchived ? [] : readFreshInProgressRuntimeSignalTimestamps(input, nowMs);
    const thinkingAt = normalizeRuntimeStatusTimestamp(input.thinkingAt);
    const isOnline = input.presence === 'online';
    const isActive = input.active === true;
    const isLiveRuntime = isLiveSessionRuntime(input);
    const hasTerminalMaterializedTurnStatus = isTerminalPrimaryTurnStatus(latestTurnStatus);
    const blocksLegacyThinking = isLegacyThinkingBlockedByTurnProjection(latestTurnStatus);
    const freshThinking =
        !isArchived
        && input.thinking === true
        && isLiveRuntime
        && isFreshTimestamp(thinkingAt, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)
        && !blocksLegacyThinking;
    const freshInProgress = freshInProgressSignals.length > 0;
    const runtimeActivityState = isArchived
        ? 'idle'
        : readRuntimeActivityPresentationState(input, isLiveRuntime);
    const freshProviderRuntimeActivity = runtimeActivityState === 'active';
    const working = freshInProgress || freshThinking;
    const backgroundActive = !working && freshProviderRuntimeActivity;
    const activityState: SessionRuntimeActivityPresentationState = working
        ? 'working'
        : backgroundActive
            ? 'backgroundActive'
            : 'idle';
    const runtimeActivelyWorking = isLiveRuntime && working;

    return {
        isOnline,
        isActive,
        hasTerminalMaterializedTurnStatus,
        terminalStatus: hasTerminalMaterializedTurnStatus ? latestTurnStatus : null,
        freshThinking,
        freshInProgress,
        freshProviderRuntimeActivity,
        working,
        backgroundActive,
        backgroundActiveCount: backgroundActive ? readRuntimeActivityActiveCount(input) : 0,
        activityState,
        runtimeProjectionInProgress: freshInProgress,
        runtimeActivelyWorking,
        // Keep an outstanding request visible until its count clears or its owning runtime is no
        // longer live. `pendingRequestObservedAt` need not advance while a request waits, so its age
        // is not settlement evidence. Updated CLIs retain and retry exact settlement intents;
        // older producers can leave an unresolved count after a failed cancellation write.
        freshPermissionRequired:
            input.hasPendingPermissionRequests === true
            && isLiveRuntime,
        freshActionRequired:
            input.hasPendingUserActionRequests === true
            && isLiveRuntime,
    };
}

/** The last witnessed attachment after the existing reconnect grace expires; never a terminal outcome. */
export function readSessionRuntimeLostSinceMs(
    input: Pick<DeriveSessionRuntimePresentationStateInput, 'active' | 'activeAt' | 'presence'>,
    nowMs: number,
): number | null {
    if (input.active !== false || input.presence === 'online') return null;
    const lastSeenAtMs = normalizeRuntimeStatusTimestamp(input.activeAt);
    return lastSeenAtMs !== null && !isFreshTimestamp(lastSeenAtMs, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)
        ? lastSeenAtMs
        : null;
}

/** Newer child evidence can outlive the owning session's last attachment observation. */
export function isSessionOwnedActivityUnobserved(
    runtimeLostSinceMs: number | null | undefined,
    latestObservedAtMs: number | null | undefined,
): boolean {
    return runtimeLostSinceMs != null
        && !(typeof latestObservedAtMs === 'number' && Number.isFinite(latestObservedAtMs)
            && latestObservedAtMs > runtimeLostSinceMs);
}

export function readFreshInProgressRuntimeSignalTimestamps(
    input: DeriveSessionRuntimePresentationStateInput,
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
    input: DeriveSessionRuntimePresentationStateInput,
    nowMs: number,
): readonly number[] {
    const runtimeStatus = deriveSessionRuntimePresentationState(input, nowMs);
    const timestamps: number[] = [];
    if (runtimeStatus.freshThinking) {
        const thinkingAt = normalizeRuntimeStatusTimestamp(input.thinkingAt);
        if (thinkingAt !== null) timestamps.push(thinkingAt);
    }
    timestamps.push(...readFreshInProgressRuntimeSignalTimestamps(input, nowMs));
    if (runtimeStatus.freshProviderRuntimeActivity) {
        // Age changes the observation presentation ("awaiting updates"), not the reported work.
        // Wake once when the newest witness expires so mounted rows can state that uncertainty.
        const witnesses = readSessionRuntimeObservationTimestamps(input)
            .filter((timestamp) => isFreshTimestamp(timestamp, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS));
        if (witnesses.length > 0) timestamps.push(Math.max(...witnesses));
    }
    return timestamps;
}

export function resolveNextSessionRuntimePresentationFreshnessAtMs(
    input: DeriveSessionRuntimePresentationStateInput,
    nowMs: number,
): number | null {
    const expirations: number[] = [];
    for (const timestamp of readSessionRuntimePresentationFreshnessTimestamps(input, nowMs)) {
        if (!isFreshTimestamp(timestamp, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)) continue;
        expirations.push(Math.trunc(timestamp) + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    }
    if (input.active === false && input.presence !== 'online') {
        const lastSeenAtMs = normalizeRuntimeStatusTimestamp(input.activeAt);
        if (lastSeenAtMs !== null && isFreshTimestamp(lastSeenAtMs, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)) {
            expirations.push(lastSeenAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
        }
    }
    if (expirations.length === 0) return null;
    return Math.min(...expirations);
}

export function resolveSessionRuntimePresenceFields(
    input: Pick<DeriveSessionRuntimePresentationStateInput,
        'thinking' | 'thinkingAt' | 'latestTurnStatus' | 'latestTurnStatusObservedAt'>,
): SessionRuntimePresenceFields {
    const thinkingAt = normalizeRuntimeStatusTimestamp(input.thinkingAt) ?? 0;
    const latestTurnStatus = input.latestTurnStatus ?? null;
    if (isTerminalPrimaryTurnStatus(latestTurnStatus)) {
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

export function isTerminalPrimaryTurnStatus(status: PrimaryTurnStatusV1 | null): boolean {
    return status === 'completed' || status === 'cancelled' || status === 'failed';
}

function isLegacyThinkingBlockedByTurnProjection(latestTurnStatus: PrimaryTurnStatusV1 | null): boolean {
    return isTerminalPrimaryTurnStatus(latestTurnStatus);
}

function normalizeRuntimeStatusTimestamp(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

/**
 * The projected active count, or `0` when the projection does not attest one.
 *
 * Shared with the state resolver below so "is there runtime activity" and "how much" can never
 * disagree: a positive count here is exactly the condition that makes the state `active`.
 */
function readRuntimeActivityActiveCount(
    input: DeriveSessionRuntimePresentationStateInput,
): number {
    const value = input.runtimeActivityActiveCount;
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : 0;
}

function readRuntimeActivityPresentationState(
    input: DeriveSessionRuntimePresentationStateInput,
    isLiveRuntime: boolean,
): SessionRuntimeActivityState {
    if (
        input.runtimeActivityState === 'active'
        && readRuntimeActivityActiveCount(input) > 0
    ) {
        // Publisher presence owns reachability and expiry. A delayed heartbeat is not settlement
        // evidence: replacing its active report with a shorter UI lease moves unfinished work to
        // Needs attention. Observation age is presented separately by deriveSessionWorkObservation.
        return isLiveRuntime ? 'active' : 'unknown';
    }
    if (
        input.runtimeActivityState === 'idle'
        && input.runtimeActivityActiveCount === 0
    ) return 'idle';
    return 'unknown';
}
