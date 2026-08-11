import type { SessionRuntimeIssueSourceV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import {
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
    isFreshTimestamp,
    isLiveSessionRuntime,
    readSessionRuntimeObservationTimestamps,
} from './deriveSessionRuntimePresentationState';

/**
 * Is this session still observing the work it owns — and if not, since when?
 *
 * **The mitigation half of the truthfulness fix (RULING-16).** When the session that owned a piece
 * of agent work is gone or unobserved, a surface states that ONCE, at section level, and leaves the
 * rows it cannot observe exactly as it last saw them. The alternative — rewriting each row's status
 * — is a durable-looking lie about work the client never observed, and it silently moves rows
 * between sections while it does so.
 *
 * **It reports, it never concludes.** Two facts are knowable here and both come from somewhere else:
 * the CLI already classifies why a session's runtime failed (`lastRuntimeIssue`, whose `auth_error`
 * has never been interpreted by any surface in this app), and the client can always ask how old its
 * newest witness of that runtime is. Nothing below infers a stop from silence — 4.9.3 forbids it,
 * and this repo has refused timeout-based death twice in writing.
 *
 * **Not a status, and not per row.** The result describes the SESSION. A consumer states it once
 * beside the work; it must never be mapped onto an entry's status, a section membership or a glyph.
 */

/**
 * Why the session stopped, in the surface's vocabulary rather than the transport's.
 *
 * Total by construction: a new `SessionRuntimeIssueSourceV1` member fails the typecheck here rather
 * than defaulting into a sentence that describes the wrong failure.
 */
const REASON_BY_ISSUE_SOURCE: Readonly<Record<SessionRuntimeIssueSourceV1, SessionWorkObservationReason>> = {
    auth_error: 'auth',
    usage_limit: 'usage_limit',
    provider_process_exit: 'process_exit',
    provider_process_exit_after_switch: 'process_exit',
    provider_status_error: 'error',
    provider_session_error: 'error',
    stream_error: 'error',
    permission_blocked: 'error',
    dependency_failure: 'error',
    unknown: 'unknown',
};

export type SessionWorkObservationReason =
    | 'auth'
    /** Kept distinct so a consumer can defer to the usage-limit surface that already owns this. */
    | 'usage_limit'
    | 'process_exit'
    | 'error'
    | 'unknown';

export type SessionWorkObservation =
    /** The runtime is there and recently witnessed. Say nothing. */
    | Readonly<{ state: 'observed' }>
    /** The runtime reported a failure and nothing has been observed since. */
    | Readonly<{ state: 'stopped'; sinceMs: number; reason: SessionWorkObservationReason }>
    /** Nobody is watching. `sinceMs` is the newest instant we know it WAS watched, if any. */
    | Readonly<{ state: 'unobserved'; sinceMs: number | null }>;

export type DeriveSessionWorkObservationInput = Readonly<{
    archivedAt?: number | null;
    active?: boolean | null;
    activeAt?: number | null;
    presence?: unknown;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    runtimeActivityObservedAt?: number | null;
    meaningfulActivityAt?: number | null;
    latestTurnStatusObservedAt?: number | null;
}>;

export function deriveSessionWorkObservation(
    input: DeriveSessionWorkObservationInput,
    nowMs: number,
): SessionWorkObservation {
    const stoppedAt = readRuntimeFailureAtMs(input.lastRuntimeIssue);
    if (stoppedAt !== null) {
        // A reported failure stands as the current fact until something newer contradicts it. The
        // contradiction has to be evidence, not the mere passage of time: a session that failed and
        // then produced activity, a turn or a runtime observation afterwards has recovered.
        const observedSince = readEvidenceSinceFailureAtMs(input);
        if (observedSince === null || observedSince <= stoppedAt) {
            return {
                state: 'stopped',
                sinceMs: stoppedAt,
                reason: toSessionWorkObservationReason(input.lastRuntimeIssue?.source),
            };
        }
    }

    const witnesses = readSessionRuntimeObservationTimestamps(input);
    const isWitnessed = witnesses.some(
        (timestamp) => isFreshTimestamp(timestamp, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS),
    );
    if (isLiveSessionRuntime(input) && isWitnessed) return { state: 'observed' };

    return {
        state: 'unobserved',
        sinceMs: witnesses.length > 0 ? Math.max(...witnesses) : null,
    };
}

/**
 * The surface vocabulary for an issue source, degrading a source this build predates to `unknown`.
 *
 * The table is total over the current union, so adding a member is a typecheck failure here rather
 * than a silent mis-description. The runtime fallback covers the other direction — a CLI a release
 * ahead — where naming the wrong failure would be worse than naming none.
 */
function toSessionWorkObservationReason(
    source: SessionRuntimeIssueSourceV1 | undefined,
): SessionWorkObservationReason {
    if (source === undefined) return 'unknown';
    return REASON_BY_ISSUE_SOURCE[source] ?? 'unknown';
}

/**
 * When the runtime reported it had failed, or `null` when it has not.
 *
 * `SessionRuntimeIssueV1` is schema-pinned to `status: 'failed'` and `scope: 'primary_session'`, and
 * both are re-checked rather than assumed: the field arrives from the wire and a session-scoped
 * failure is the only kind that says anything about the work the session owned.
 */
function readRuntimeFailureAtMs(issue: SessionRuntimeIssueV1 | null | undefined): number | null {
    if (!issue || issue.status !== 'failed' || issue.scope !== 'primary_session') return null;
    return typeof issue.occurredAt === 'number' && Number.isFinite(issue.occurredAt) && issue.occurredAt > 0
        ? Math.trunc(issue.occurredAt)
        : null;
}

function readEvidenceSinceFailureAtMs(input: DeriveSessionWorkObservationInput): number | null {
    const candidates = [
        input.meaningfulActivityAt,
        input.latestTurnStatusObservedAt,
        input.runtimeActivityObservedAt,
    ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
    return candidates.length > 0 ? Math.max(...candidates) : null;
}
