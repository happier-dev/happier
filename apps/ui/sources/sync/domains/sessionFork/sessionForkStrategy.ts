import type { SessionForkPoint, SessionForkRpcResult } from '@happier-dev/protocol';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

/**
 * The three routes the fork strategy modal offers. `native` and `replay` are
 * same-engine fork operations owned by the existing `session.fork` lifecycle;
 * `configure` leaves the modal entirely and hands authoring to New Session.
 */
export type SessionForkStrategyRoute = 'native' | 'replay' | 'configure';

/** The two routes that actually issue a fork request. */
export type SessionForkOperationRoute = Exclude<SessionForkStrategyRoute, 'configure'>;

export type SessionForkRpcOutcomeV1 =
    | Readonly<{ type: 'created'; childSessionId: string }>
    /**
     * The daemon decided. No child exists, so retrying — or choosing the other
     * route — is safe.
     */
    | Readonly<{
        type: 'failed';
        kind: 'update_required' | 'error';
        errorCode: string;
        message: string | null;
    }>
    /**
     * The request was emitted and we cannot prove what happened to it. A blind
     * retry could commit a second provider-side fork, so callers must reconcile
     * against real lineage instead.
     */
    | Readonly<{ type: 'unknown'; errorCode: string }>;

const UNKNOWN_OUTCOME_ERROR_CODES: ReadonlySet<string> = new Set<string>([
    // The daemon accepted the request and the launch is still pending; the child
    // may yet appear.
    SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
    // `forkSession` collapses a thrown transport error and an undecodable daemon
    // reply into `UNEXPECTED`. In both cases the request may already have been
    // emitted, so neither may claim the source is untouched.
    SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
]);

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function classifySessionForkRpcOutcome(result: SessionForkRpcResult): SessionForkRpcOutcomeV1 {
    if (result.ok === true) {
        const childSessionId = normalizeNonEmptyString(result.childSessionId);
        if (childSessionId) return { type: 'created', childSessionId };
        // A success shape without an id tells us a fork happened but not which
        // one. Reconciliation, never a retry.
        return { type: 'unknown', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED };
    }

    const errorCode = normalizeNonEmptyString(result.errorCode) ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED;
    if (UNKNOWN_OUTCOME_ERROR_CODES.has(errorCode)) {
        return { type: 'unknown', errorCode };
    }
    return {
        type: 'failed',
        kind: errorCode === SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE ? 'update_required' : 'error',
        errorCode,
        message: normalizeNonEmptyString(result.errorMessage),
    };
}

/* -------------------------------------------------------------------------- *
 * Outcome-unknown reconciliation
 * -------------------------------------------------------------------------- */

export type SessionForkChildCandidate = Readonly<{
    sessionId: string;
    metadata: unknown;
}>;

export type SessionForkChildLookupV1 =
    | Readonly<{ type: 'found'; childSessionId: string }>
    | Readonly<{ type: 'none' }>
    | Readonly<{ type: 'ambiguous' }>;

/**
 * The daemon records the strategy it actually resolved, never the generic
 * `native` intent the user picked. Reading the recorded value back is how the
 * client proves it is not adopting a Replay child for a Native request — it is
 * not a second copy of the daemon's native-selection policy.
 */
const NATIVE_RESOLVED_STRATEGIES: ReadonlySet<string> = new Set(['native', 'provider_native', 'acp_fork_latest']);
const REPLAY_RESOLVED_STRATEGIES: ReadonlySet<string> = new Set(['replay']);

function readForkLineage(metadata: unknown): Readonly<{
    parentSessionId: string;
    parentCutoffSeqInclusive: number;
    strategy: string;
    requestId: string | null;
}> | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const fork = (metadata as Record<string, unknown>).forkV1;
    if (!fork || typeof fork !== 'object' || Array.isArray(fork)) return null;
    const record = fork as Record<string, unknown>;
    if (record.v !== 1) return null;
    const parentSessionId = normalizeNonEmptyString(record.parentSessionId);
    const strategy = normalizeNonEmptyString(record.strategy);
    const parentCutoffSeqInclusive = record.parentCutoffSeqInclusive;
    if (!parentSessionId || !strategy || typeof parentCutoffSeqInclusive !== 'number') return null;
    return {
        parentSessionId,
        parentCutoffSeqInclusive,
        strategy,
        requestId: normalizeNonEmptyString(record.requestId),
    };
}

/**
 * Resolves the child a fork request actually produced, for the case where the
 * RPC outcome is unknown.
 *
 * Newness is proven by the set of children that already existed when the
 * request was submitted rather than by a timestamp, because `createdAtMs` is
 * written on the daemon's clock and a skewed comparison would either adopt an
 * unrelated older child or refuse a valid one.
 *
 * A `latest` request cannot know which sequence the daemon resolved, so the
 * cutoff is not part of the match for it; parent, strategy family and newness
 * still are. Several matches are reported as ambiguous instead of guessed.
 */
export type SessionForkLineageMatch = Readonly<{
    parentSessionId: string;
    forkPoint: SessionForkPoint;
    route: SessionForkOperationRoute;
    /** Durable identity emitted with this exact fork attempt, when available. */
    requestId?: string | null;
}>;

/**
 * Whether this Session's recorded lineage is the child a given fork request
 * would have produced. Shared by the pre-submit snapshot of already-existing
 * children and by the post-submit reconciliation pass, so both use exactly one
 * definition of "the child for this request".
 */
export function isForkChildOfRequest(
    candidate: SessionForkChildCandidate,
    match: SessionForkLineageMatch,
): boolean {
    const lineage = readForkLineage(candidate.metadata);
    if (!lineage) return false;
    if (lineage.parentSessionId !== match.parentSessionId) return false;
    const acceptedStrategies = match.route === 'native'
        ? NATIVE_RESOLVED_STRATEGIES
        : REPLAY_RESOLVED_STRATEGIES;
    if (!acceptedStrategies.has(lineage.strategy)) return false;
    const requestId = normalizeNonEmptyString(match.requestId);
    // The daemon's fork cutoff is an effective content boundary, not necessarily
    // the sequence clicked in the UI (a clicked user row yields N−1). When the
    // request identity survived into durable lineage it is the exact proof of
    // this attempt; comparing adjacent sequence values here would create a
    // second, divergent cutoff resolver in the consumer.
    if (requestId) return lineage.requestId === requestId;
    if (
        match.forkPoint.type === 'seq'
        && lineage.parentCutoffSeqInclusive !== match.forkPoint.upToSeqInclusive
    ) {
        return false;
    }
    return true;
}

export function findForkChildForRequest(params: Readonly<{
    candidates: readonly SessionForkChildCandidate[];
    parentSessionId: string;
    forkPoint: SessionForkPoint;
    route: SessionForkOperationRoute;
    requestId?: string | null;
    knownChildSessionIds: ReadonlySet<string>;
}>): SessionForkChildLookupV1 {
    const match: SessionForkLineageMatch = {
        parentSessionId: params.parentSessionId,
        forkPoint: params.forkPoint,
        route: params.route,
        requestId: params.requestId,
    };

    const matches: string[] = [];
    for (const candidate of params.candidates) {
        if (params.knownChildSessionIds.has(candidate.sessionId)) continue;
        if (!isForkChildOfRequest(candidate, match)) continue;
        matches.push(candidate.sessionId);
        if (matches.length > 1) return { type: 'ambiguous' };
    }

    const only = matches[0];
    return only ? { type: 'found', childSessionId: only } : { type: 'none' };
}
