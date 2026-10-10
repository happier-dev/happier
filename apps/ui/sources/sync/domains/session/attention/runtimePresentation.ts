import { SESSION_AWARENESS_OPTIMISTIC_PENDING_INPUT_MS, SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS, hasProjectedActiveTurnV1, hasTerminalPrimaryTurnStatusV1, isFreshAwarenessTimestampV1, isLiveSessionRuntimeV1, projectSessionAwarenessRuntimeV1 } from '@happier-dev/protocol/sessions/awareness/runtime';
import { normalizeAwarenessTimestampV1 } from '@happier-dev/protocol/sessions/awareness/inputV1';
import { projectSessionAwarenessOperationalV1 } from '@happier-dev/protocol/sessions/awareness/projectV1';
import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { SessionRuntimeActivityState } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';

/**
 * The UI adapter over the canonical Session-awareness runtime owner.
 *
 * Every semantic decision below — live/stale/gone, working versus background activity, terminal
 * turns defeating stale thinking, pending-request freshness — now lives once in Protocol
 * (`sessions/awareness/runtime.ts`) so the server projection, the CLI mapper, Voice and this UI
 * cannot drift. What stays here is genuinely UI-shaped: this package's presentation vocabulary,
 * its device-local presence/optimistic-input inputs, and the timer scheduling that decides when
 * a visible row must recompute.
 */
export const SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS = SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS;
export const SESSION_OPTIMISTIC_PENDING_THINKING_MS = SESSION_AWARENESS_OPTIMISTIC_PENDING_INPUT_MS;
/**
 * Safety-net lifetime after the daemon accepts a resume request. The store keeps the explicit
 * marker for the entire in-flight RPC and normally clears it on authoritative post-attach state.
 */
export const SESSION_RESUMING_PRESENTATION_TIMEOUT_MS = 30_000;

export type SessionRuntimePresentationInput = Readonly<{
    resumingAt?: number | null;
    controlServiceability?: 'servable' | 'recoverable_unservable' | null;
    pendingBlockedCount?: number | null;
    latestReadyEventSeq?: number | null;
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

export type SessionRuntimePresentationState = import('@happier-dev/protocol').SessionAwarenessRuntimeFactsV1 & Readonly<{
    operational: import('@happier-dev/protocol').SessionAwarenessProjectionV1['operational'];
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
    return isFreshAwarenessTimestampV1(timestamp, nowMs, budgetMs);
}

export function normalizeRuntimeStatusTimestamp(value: number | null | undefined): number | null {
    return normalizeAwarenessTimestampV1(value);
}

export function hasTerminalPrimaryTurnStatus(status: PrimaryTurnStatusV1 | null | undefined): boolean {
    return hasTerminalPrimaryTurnStatusV1(status);
}

export function hasProjectedActiveTurn(status: PrimaryTurnStatusV1 | null | undefined): boolean {
    return hasProjectedActiveTurnV1(status);
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
    return isLiveSessionRuntimeV1(
        { presence: readAwarenessPresence(input.presence), active: input.active },
        normalizeAwarenessTimestampV1(input.archivedAt) !== null,
    );
}

/**
 * Presence as the canonical owner models it. A UI row that has no presence evidence at all is
 * `unknown`, not offline — the awareness contract keeps those distinct so a surface never reports
 * "last seen" for a session it simply has not heard about yet.
 */
export function readAwarenessPresence(presence: unknown): 'online' | 'offline' | 'unknown' {
    if (presence === 'online') return 'online';
    return presence === undefined || presence === null ? 'unknown' : 'offline';
}

export function toAwarenessRuntimeInput(input: SessionRuntimePresentationInput) {
    return {
        lifecycle: {
            archivedAtMs: input.archivedAt,
            latestReadyEventSeq: input.latestReadyEventSeq,
            latestTurnStatus: input.latestTurnStatus,
            latestTurnStatusObservedAtMs: input.latestTurnStatusObservedAt,
            meaningfulActivityAtMs: input.meaningfulActivityAt,
        },
        runtime: {
            presence: readAwarenessPresence(input.presence),
            resumingAtMs: input.resumingAt,
            controlServiceability: input.controlServiceability,
            active: input.active,
            lastObservedAtMs: input.activeAt,
            thinking: input.thinking,
            thinkingAtMs: input.thinkingAt,
            optimisticThinkingAtMs: input.optimisticThinkingAt,
            activityState: input.runtimeActivityState,
            activityActiveCount: input.runtimeActivityActiveCount,
        },
        pending: {
            hasPendingPermissionRequests: input.hasPendingPermissionRequests,
            hasPendingUserActionRequests: input.hasPendingUserActionRequests,
            pendingRequestObservedAtMs: input.pendingRequestObservedAt,
            queuedInputCount: input.hasPendingUserMessages === true ? 1 : 0,
            blockedInputCount: input.pendingBlockedCount,
        },
    } as const;
}

/**
 * Instant this session's runtime was last observed, once it is gone rather than merely quiet —
 * and `null` while it is live *or* while the gap is still short enough to be a reconnect blip.
 *
 * This is a loss of observation and never proof of a terminal outcome: work the runtime was
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
    return projectSessionAwarenessRuntimeV1({
        ...toAwarenessRuntimeInput(input),
        nowMs,
    }).lostSinceMs;
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

export function projectUiSessionRuntimeAwareness(
    input: SessionRuntimePresentationInput,
): SessionRuntimePresentationState {
    const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs)
        ? input.nowMs
        : Date.now();
    const normalized = toAwarenessRuntimeInput(input);
    const facts = projectSessionAwarenessRuntimeV1({ ...normalized, nowMs });
    const operational = projectSessionAwarenessOperationalV1({ runtime: facts, lifecycle: normalized.lifecycle });
    return {
        ...facts,
        operational,

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
    const runtimePresentation = projectUiSessionRuntimeAwareness({ ...input, nowMs });
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

    if (!runtimePresentation.live) {
        addFreshnessSignal(input.activeAt, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    }
    if (runtimePresentation.freshThinking) {
        addFreshnessSignal(input.thinkingAt, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    }
    if (runtimePresentation.freshOptimisticPendingInput) {
        addFreshnessSignal(input.optimisticThinkingAt, SESSION_OPTIMISTIC_PENDING_THINKING_MS);
    }
    if (runtimePresentation.freshPermissionRequired || runtimePresentation.freshActionRequired) {
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
