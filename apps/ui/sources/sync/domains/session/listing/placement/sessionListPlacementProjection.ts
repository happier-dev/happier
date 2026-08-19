import {
    deriveSessionRuntimePresentationState,
    resolveNextSessionRuntimePresentationFreshnessAtMs,
} from '../../attention/deriveSessionRuntimePresentationState';
import {
    resolveSessionAttentionStandingSource,
    type SessionAttentionStandingPolicy,
} from '../../organization/attentionStanding';
import type { SessionListAttentionPromotionReason } from '../attentionPromotion/sessionListAttentionPromotionTypes';
import { isSessionListReadyForReview } from '../sessionListReadyForReview';
import type { SessionListRenderableSession } from '../sessionListRenderable';
import {
    normalizeSessionListPlacementKey,
    normalizeSessionListWorkingRetentionKeys,
    shouldRetainSessionListWorkingPlacement,
    type SessionListWorkingRetentionKeySource,
} from './sessionListWorkingRetention';

export type SessionListPlacementKind = 'none' | 'working' | SessionListAttentionPromotionReason;

/**
 * Item-level projection of a 'working' placement: 'working' means live
 * working signals, 'working-retained' means the session is held in the
 * working group by retention while its signals are stale (rows render a
 * paused indicator for it). Both count as working placement for grouping.
 */
export type SessionListWorkingPlacementReason = 'working' | 'working-retained';

export function isSessionListWorkingPlacementReason(value: unknown): value is SessionListWorkingPlacementReason {
    return value === 'working' || value === 'working-retained';
}

export type SessionListPlacementProjection = Readonly<{
    kind: SessionListPlacementKind;
    timestamp: number | null;
    retainedWorking: boolean;
    /**
     * Only meaningful for a 'standing' placement: true when the user asked for
     * THIS session to stay in the band, false when standing comes from the
     * account default. Explicit intent outranks "Hide inactive sessions"; a
     * blanket default must not silently disable that filter.
     */
    explicitStanding: boolean;
}>;

export function projectSessionListPlacement(params: Readonly<{
    session: SessionListRenderableSession;
    nowMs: number;
    sessionKey?: string | null;
    retainedWorkingSessionKeys?: SessionListWorkingRetentionKeySource;
    standingPolicy?: SessionAttentionStandingPolicy;
}>): SessionListPlacementProjection {
    const runtimeStatus = deriveSessionRuntimePresentationState(params.session, params.nowMs);
    if (runtimeStatus.freshActionRequired) {
        return createPlacement('action_required', resolveSessionListPlacementTimestampForReason(params.session, 'action_required'));
    }
    if (runtimeStatus.freshPermissionRequired) {
        return createPlacement('permission_required', resolveSessionListPlacementTimestampForReason(params.session, 'permission_required'));
    }
    if ((params.session.pendingBlockedCount ?? 0) > 0) {
        return createPlacement('action_required', resolveSessionListPlacementTimestampForReason(params.session, 'action_required'));
    }
    if (runtimeStatus.working) {
        return createPlacement('working', null);
    }
    if (isPrimarySessionFailure(params.session)) {
        return createPlacement('failed', resolveSessionListPlacementTimestampForReason(params.session, 'failed'));
    }
    if (runtimeStatus.isOnline && runtimeStatus.backgroundActive) {
        return createPlacement('working', null);
    }
    if (isSessionListReadyForReview(params.session)) {
        return createPlacement('ready', resolveSessionListPlacementTimestampForReason(params.session, 'ready'));
    }
    if (params.session.hasUnreadMessages === true) {
        return createPlacement('unread', resolveSessionListPlacementTimestampForReason(params.session, 'unread'));
    }

    const sessionKey = params.sessionKey ?? normalizeSessionListPlacementKey(null, params.session.id);
    const retainedWorking = shouldRetainSessionListWorkingPlacement({
        session: params.session,
        sessionKey,
        retainedKeys: normalizeSessionListWorkingRetentionKeys(params.retainedWorkingSessionKeys),
        nowMs: params.nowMs,
    });
    if (retainedWorking) {
        return { kind: 'working', timestamp: null, retainedWorking: true, explicitStanding: false };
    }
    // Attention standing is a FLOOR, never an override: it only reaches a
    // session whose own signals place it nowhere, so a read session the user
    // asked to keep stays in the band while unread/ready/working/failed
    // placements keep their own reason and ordering key.
    const standingSource = params.standingPolicy && sessionKey
        ? resolveSessionAttentionStandingSource(params.standingPolicy, sessionKey)
        : 'none';
    if (standingSource !== 'none') {
        return { kind: 'standing', timestamp: null, retainedWorking: false, explicitStanding: standingSource === 'override' };
    }
    return { kind: 'none', timestamp: null, retainedWorking: false, explicitStanding: false };
}

/**
 * Upper bound on freshness-boundary steps when comparing two placement
 * projections over time. Each step consumes at least one expiring freshness
 * signal of one of the two sessions (a session carries at most a handful),
 * so a walk that has not settled by then is treated as divergent for safety.
 */
const MAX_PLACEMENT_DIVERGENCE_BOUNDARY_STEPS = 12;

/**
 * Whether two renderables project to different placements at `nowMs` or at
 * ANY future freshness boundary. Placement is piecewise-constant in time:
 * with retention keys out of scope it only changes when a runtime freshness
 * signal expires, and those horizons come from the canonical
 * `resolveNextSessionRuntimePresentationFreshnessAtMs` resolver. Comparing at
 * a single instant is not enough — e.g. a mid-turn `latestTurnStatusObservedAt`
 * refresh keeps the placement 'working' NOW but extends the working window,
 * and missing it would leave stale timestamps in the committed view data.
 */
export function didSessionListPlacementProjectionDiverge(params: Readonly<{
    previous: SessionListRenderableSession;
    next: SessionListRenderableSession;
    nowMs: number;
}>): boolean {
    let atMs = params.nowMs;
    for (let step = 0; step < MAX_PLACEMENT_DIVERGENCE_BOUNDARY_STEPS; step += 1) {
        const previousPlacement = projectSessionListPlacement({ session: params.previous, nowMs: atMs });
        const nextPlacement = projectSessionListPlacement({ session: params.next, nowMs: atMs });
        if (
            previousPlacement.kind !== nextPlacement.kind
            || previousPlacement.timestamp !== nextPlacement.timestamp
        ) {
            return true;
        }
        const previousBoundary = resolveNextSessionRuntimePresentationFreshnessAtMs(params.previous, atMs);
        const nextBoundary = resolveNextSessionRuntimePresentationFreshnessAtMs(params.next, atMs);
        const boundary = previousBoundary === null
            ? nextBoundary
            : nextBoundary === null
                ? previousBoundary
                : Math.min(previousBoundary, nextBoundary);
        if (boundary === null) return false;
        // Defensive only: the freshness resolver returns boundaries strictly
        // beyond atMs (expiry = fresh timestamp + budget). Treat a
        // non-advancing boundary as divergent rather than looping.
        if (boundary <= atMs) return true;
        atMs = boundary;
    }
    return true;
}

/**
 * Single owner of the attention-reason → ordering-timestamp rule. Both the
 * store-side placement projection above and the index promotion lane resolve
 * candidate order through this table, so a lane can never sort by a different
 * fact than the one the rebuild gate compared.
 */
export function resolveSessionListPlacementTimestampForReason(
    session: SessionListRenderableSession,
    reason: SessionListAttentionPromotionReason,
): number | null {
    switch (reason) {
        case 'action_required':
        case 'permission_required':
            return normalizePlacementTimestamp(
                session.pendingRequestObservedAt,
                session.updatedAt,
                session.createdAt,
            );
        case 'failed':
            return normalizePlacementTimestamp(
                session.lastRuntimeIssue?.occurredAt,
                session.latestTurnStatusObservedAt,
            );
        case 'ready':
            return normalizePlacementTimestamp(
                session.latestReadyEventAt,
                session.latestTurnStatusObservedAt,
            );
        case 'unread':
            return resolveSessionListUnreadPlacementTimestamp(session);
        case 'standing':
            return null;
    }
}

/**
 * Unread rows are ordered by WHEN THEY BECAME UNREAD, never by their latest
 * activity: an unread session that keeps receiving messages must not re-sort
 * the attention lane (and must not invalidate the committed list) while its
 * membership is unchanged. `unreadSince` is the canonical entry fact — server
 * materialized when available, otherwise stamped once by the renderable merge
 * owner. The activity fallback only applies to rows that never passed through
 * that owner (e.g. raw warm-cache rehydration), and reproduces the previous
 * ordering exactly for them.
 */
function resolveSessionListUnreadPlacementTimestamp(session: Pick<
    SessionListRenderableSession,
    'unreadSince' | 'meaningfulActivityAt' | 'updatedAt' | 'createdAt'
>): number | null {
    return normalizePlacementTimestamp(
        session.unreadSince,
        session.meaningfulActivityAt,
        session.updatedAt,
        session.createdAt,
    );
}

/**
 * Activity time stamped as `unreadSince` when a session first enters the
 * unread state without a server-materialized entry fact.
 */
export function resolveSessionListUnreadEntryActivityAt(session: Pick<
    SessionListRenderableSession,
    'meaningfulActivityAt' | 'updatedAt' | 'createdAt'
>): number | null {
    return normalizePlacementTimestamp(
        session.meaningfulActivityAt,
        session.updatedAt,
        session.createdAt,
    );
}

function createPlacement(
    kind: Exclude<SessionListPlacementKind, 'none'>,
    timestamp: number | null,
): SessionListPlacementProjection {
    return { kind, timestamp, retainedWorking: false, explicitStanding: false };
}

function normalizePlacementTimestamp(...values: readonly unknown[]): number | null {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
    }
    return null;
}

function isPrimarySessionFailure(session: SessionListRenderableSession): boolean {
    const issue = session.lastRuntimeIssue;
    return session.latestTurnStatus === 'failed'
        && issue?.v === 1
        && issue.scope === 'primary_session'
        && issue.status === 'failed'
        && shouldPromoteFailedSessionAttention(session);
}

function shouldPromoteFailedSessionAttention(session: SessionListRenderableSession): boolean {
    return session.active === true || session.hasUnreadMessages === true;
}
