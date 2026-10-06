import { describeWorkStatusBucket } from '@/components/work/status/workStatusBuckets';
import { projectUiSessionRuntimeAwareness } from '@/sync/domains/session/attention/runtimePresentation';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import {
    resolveSessionAttentionStandingSource,
    resolveSessionReminderPresentation,
    type SessionAttentionStandingPolicy,
    type SessionAttentionStandingSource,
} from '@/sync/domains/session/organization/attentionStanding';

import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import type { SessionListRenderableSession } from './sessionListRenderable';
import {
    hasActivityClearlyAfterTerminalProjectionV1,
    readSessionAwarenessOperationalPrimaryRankV1,
    type SessionPersonalAttentionReasonV1,
} from '@happier-dev/protocol';
import {
    normalizeSessionListAttentionPlacementMode,
    normalizeSessionListWorkingPlacementMode,
    type SessionListAttentionPlacementMode,
    type SessionListAttentionPlacementReason,
    type SessionListAttentionPlacementOrdering,
    type SessionListRetainedAttentionPlacement,
    type SessionListWorkingPlacementMode,
    type SessionListWorkingPlacementReason,
} from './sessionListAttentionPlacementTypes';
import { presentSessionPersonalAttentionReason } from './deriveSessionListActivity';
import { normalizeSessionViewerCompatibility } from '../readState/sessionViewer';

export const ATTENTION_PLACEMENT_GROUP_KEY_V1 = 'attention-promotion-v1';
export const WORKING_PLACEMENT_GROUP_KEY_V1 = 'working-placement-v1';
export const SESSION_LIST_WORKING_RETENTION_LIMIT_MS = 12 * 60 * 60 * 1000;

export type SessionListAttentionPlacementOptions = Readonly<{
    mode: SessionListAttentionPlacementMode;
    /** Archived corpus hosts opt in; active-library placement remains archive-excluding. */
    includeArchived?: boolean;
    /** Preserve the opened row's ordering, independently of its live displayed reason. */
    retainPlacements?: ReadonlyArray<SessionListRetainedAttentionPlacement>;
    /**
     * The user's Keep in Needs attention instructions, carried as the policy
     * itself rather than a resolved key set: an account default plus per-session
     * overrides, resolved per row by the single owner in the organization
     * domain.
     */
    standingPolicy?: SessionAttentionStandingPolicy;
}>;

export type SessionListWorkingPlacementOptions = Readonly<{
    mode: SessionListWorkingPlacementMode;
    retainSessionKeys?: ReadonlySet<string> | ReadonlyArray<string> | null;
}>;

export type SessionListAttentionPlacementResult = Readonly<{
    attentionItems: SessionListIndexItem[];
    remainder: SessionListIndexItem[];
    promotedCount: number;
}>;

export type SessionListWorkingPlacementResult = Readonly<{
    workingItems: SessionListIndexItem[];
    remainder: SessionListIndexItem[];
    promotedCount: number;
}>;

type SessionItem = Extract<SessionListIndexItem, { type: 'session' }>;
type PlacementReason = SessionListAttentionPlacementReason | 'working';

type PlacementCandidate<Reason extends PlacementReason> = Readonly<{
    item: SessionItem;
    row: SessionListRenderableSession;
    key: string;
    reason: Reason;
    timestamp: number;
    originalIndex: number;
    retainedIndex: number | null;
    retainedWorking?: boolean;
    attentionOrdering?: SessionListAttentionPlacementOrdering;
    /**
     * Only meaningful for a 'standing' placement: true when the user asked for
     * THIS session to stay in the band, false when standing comes from the
     * account default. Explicit intent outranks "Hide inactive sessions"; a
     * blanket default must not silently disable that filter.
     */
    explicitStanding?: boolean;
}>;

type PlacementLane<Reason extends PlacementReason> = Readonly<{
    resolveCandidate: (params: Readonly<{
        item: SessionItem;
        row: SessionListRenderableSession | null;
        originalIndex: number;
        retainedKeys: ReadonlySet<string>;
        retainedKeyRanks: ReadonlyMap<string, number>;
        retainedAttentionPlacements?: ReadonlyMap<string, SessionListRetainedAttentionPlacement>;
        standingPolicy: SessionAttentionStandingPolicy | undefined;
        nowMs: number;
        allowArchived?: boolean;
    }>) => PlacementCandidate<Reason> | null;
    compareCandidates: (left: PlacementCandidate<Reason>, right: PlacementCandidate<Reason>) => number;
    createGlobalSessionItem: (candidate: PlacementCandidate<Reason>) => SessionItem;
    createWithinGroupSessionItem: (candidate: PlacementCandidate<Reason>) => SessionItem;
}>;

function readAttentionReasonPriority(reason: SessionListAttentionPlacementReason): number {
    switch (reason) {
        case 'failed':
        case 'permission_required':
        case 'action_required':
        case 'ready':
            return readSessionAwarenessOperationalPrimaryRankV1(reason);
        case 'mentioned':
            return readSessionAwarenessOperationalPrimaryRankV1('ready') - 1;
        case 'unread':
            return readSessionAwarenessOperationalPrimaryRankV1('ready') - 2;
        case 'reminder':
        case 'standing':
            // Standing is the floor of the band: it only reaches sessions whose own
            // signals place them nowhere, so it always sorts behind every earned reason.
            return readSessionAwarenessOperationalPrimaryRankV1('none') - 1;
    }
}

function normalizeSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function normalizePositiveTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function deriveRuntimePresentationForSession(session: SessionListRenderableSession, nowMs: number) {
    return projectUiSessionRuntimeAwareness({
        active: session.active,
        activeAt: session.thinking === false ? 0 : session.activeAt,
        archivedAt: session.archivedAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        optimisticThinkingAt: session.optimisticThinkingAt ?? null,
        hasPendingUserMessages: (session.pendingCount ?? 0) > 0,
        latestTurnStatus: session.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt ?? null,
        runtimeActivityState: session.runtimeActivityState ?? 'unknown',
        runtimeActivityActiveCount: session.runtimeActivityActiveCount ?? null,
        runtimeActivityObservedAt: session.runtimeActivityObservedAt ?? null,
        runtimeActivityRevision: session.runtimeActivityRevision ?? null,
        meaningfulActivityAt: session.meaningfulActivityAt ?? null,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        hasPendingPermissionRequests: session.hasPendingPermissionRequests,
        hasPendingUserActionRequests: session.hasPendingUserActionRequests,
        pendingRequestObservedAt: session.pendingRequestObservedAt ?? null,
        nowMs,
    });
}

function isRetainableWorkingSession(session: SessionListRenderableSession, nowMs: number): boolean {
    if (
        session.active !== true
        || session.presence !== 'online'
        || session.latestTurnStatus !== 'in_progress'
        || session.thinking === false
        || session.archivedAt != null
    ) {
        return false;
    }
    const retentionAnchor = resolveWorkingRetentionAnchor(session);
    return retentionAnchor !== null
        && retentionAnchor + SESSION_LIST_WORKING_RETENTION_LIMIT_MS > nowMs;
}

function isTerminalTurnAfterReadCursor(session: SessionListRenderableSession): boolean {
    if (session.latestTurnStatus !== 'completed') {
        return false;
    }
    if (hasActivityClearlyAfterTerminalProjectionV1(session.meaningfulActivityAt, session.latestTurnStatusObservedAt)) {
        return false;
    }
    const turnCompletedAt = normalizePositiveTimestamp(session.lastTurnCompletedAt);
    const readStateUpdatedAt = normalizePositiveTimestamp(session.metadata?.readStateV1?.updatedAt);
    if (turnCompletedAt != null && readStateUpdatedAt != null && readStateUpdatedAt >= turnCompletedAt) {
        return false;
    }
    const sessionSeq = normalizeSeq(session.seq);
    const readCursor = normalizeSeq(session.lastViewedSessionSeq);
    if (sessionSeq == null || readCursor == null) return false;
    return sessionSeq > readCursor;
}

function isPrimarySessionFailure(session: SessionListRenderableSession): boolean {
    return session.latestTurnStatus === 'failed'
        && shouldPromoteFailedSessionAttention(session);
}

function shouldPromoteFailedSessionAttention(session: SessionListRenderableSession): boolean {
    return session.active === true || session.hasUnreadMessages === true;
}

function presentCanonicalAttentionReason(
    reason: SessionPersonalAttentionReasonV1 | null,
): SessionListAttentionPlacementReason | null {
    const presentation = presentSessionPersonalAttentionReason(reason);
    switch (presentation) {
        case 'attention': return 'standing';
        case 'quiet': return null;
        case 'thinking':
        case 'pending':
            return null;
        default: return presentation;
    }
}

function resolveLegacyAttentionReason(
    session: SessionListRenderableSession,
    runtimePresentation: ReturnType<typeof deriveRuntimePresentationForSession>,
    standingSource: SessionAttentionStandingSource = 'none',
): SessionListAttentionPlacementReason | null {
    if (runtimePresentation.operational.primary === 'failed' && isPrimarySessionFailure(session)) {
        return 'failed';
    }
    if (runtimePresentation.freshPermissionRequired) {
        return 'permission_required';
    }
    if (runtimePresentation.freshActionRequired) {
        return 'action_required';
    }
    if ((session.pendingBlockedCount ?? 0) > 0) {
        return 'action_required';
    }
    if (
        runtimePresentation.working
        || runtimePresentation.runtime === 'background_active'
    ) {
        return null;
    }
    if (isTerminalTurnAfterReadCursor(session)) {
        return 'ready';
    }
    // Weakest attention signal, so it is checked last: anything the session
    // explicitly asked for keeps its own reason and its own ordering. Unread is
    // read from the canonical unread fact the row already renders its badge
    // from, so the band and the badge can never disagree.
    if (session.hasUnreadMessages === true) {
        return 'unread';
    }
    // Attention standing is a FLOOR, and only the FINAL return is the floor:
    // the early `return null` above means "the working lane owns this row", not
    // "nothing places this row", so standing must never be resolved there.
    if (standingSource !== 'none') {
        return 'standing';
    }
    return null;
}

function resolveAttentionReason(
    session: SessionListRenderableSession,
    runtimePresentation: ReturnType<typeof deriveRuntimePresentationForSession>,
    liveWorking: boolean,
    standingSource: SessionAttentionStandingSource = 'none',
): SessionListAttentionPlacementReason | null {
    const viewer = normalizeSessionViewerCompatibility(session);
    if (viewer.kind === 'legacy_owner') {
        // Released pre-viewer owner rows retain their bounded compatibility
        // adapter until the supported predecessor is contracted.
        return resolveLegacyAttentionReason(session, runtimePresentation, standingSource);
    }
    if (viewer.kind === 'untracked') return null;

    // Operational working placement remains an orthogonal Lane 09A concern and
    // keeps its established precedence. Every personal reason below comes from
    // the Protocol-owned viewer decision; raw seq/pending/runtime facts cannot
    // override a quiet modern projection.
    if (liveWorking) return null;
    const projected = viewer.viewer.attention;
    if (projected.needsAttention) {
        return presentCanonicalAttentionReason(projected.primary);
    }
    // The Account default is presentation-only and may apply only after the
    // server has established personal relevance. It cannot enroll broad Team,
    // Group, or direct-access history into attention.
    if (standingSource !== 'none' && viewer.viewer.relevance.relevant) {
        return 'standing';
    }
    return null;
}

type SessionListPlacementProjection = Readonly<{
    attentionReason: SessionListAttentionPlacementReason | null;
    standingSource: SessionAttentionStandingSource;
    liveWorking: boolean;
}>;

function projectSessionListPlacement(params: Readonly<{
    session: SessionListRenderableSession;
    sessionKey: string;
    standingPolicy?: SessionAttentionStandingPolicy;
    nowMs: number;
}>): SessionListPlacementProjection {
    const runtimePresentation = deriveRuntimePresentationForSession(params.session, params.nowMs);
    const liveWorking = runtimePresentation.working
        || runtimePresentation.runtime === 'background_active';
    const standingSource = params.standingPolicy
        ? resolveSessionAttentionStandingSource(params.standingPolicy, params.sessionKey, params.nowMs)
        : 'none';
    const attentionReason = resolveAttentionReason(
        params.session,
        runtimePresentation,
        liveWorking,
        standingSource,
    );
    const dueReminder = resolveSessionReminderPresentation(
        params.standingPolicy?.overridesBySessionKey[params.sessionKey], params.nowMs,
    )?.state === 'due';
    return {
        attentionReason: attentionReason === 'standing' && dueReminder ? 'reminder' : attentionReason,
        standingSource,
        liveWorking,
    };
}

function resolveWorkingRetentionAnchor(session: SessionListRenderableSession): number | null {
    return maxNormalizedTimestamp([
        session.latestTurnStatusObservedAt,
        session.thinkingAt,
        session.activeAt,
        session.optimisticThinkingAt,
    ]);
}

function maxNormalizedTimestamp(values: ReadonlyArray<number | null | undefined>): number | null {
    let max: number | null = null;
    for (const value of values) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
        const normalized = Math.trunc(value);
        max = max === null ? normalized : Math.max(max, normalized);
    }
    return max;
}

function resolveAttentionTimestamp(
    session: SessionListRenderableSession,
    reason: SessionListAttentionPlacementReason,
): number {
    if (reason === 'action_required' || reason === 'permission_required') {
        return resolveActionRequiredAttentionTimestamp(session) ?? 0;
    }
    if (reason === 'failed') {
        return normalizePositiveTimestamp(session.lastRuntimeIssue?.occurredAt)
            ?? normalizePositiveTimestamp(session.latestTurnStatusObservedAt)
            ?? 0;
    }
    if (reason === 'ready') {
        return normalizePositiveTimestamp(session.latestReadyEventAt)
            ?? normalizePositiveTimestamp(session.latestTurnStatusObservedAt)
            ?? 0;
    }
    // A mention is an unread edge like any other, so it orders by the same
    // stable "became unread" instant. The wire carries no separate mention time
    // and the client has no clock that could invent one.
    if (reason === 'unread' || reason === 'mentioned') {
        return resolveUnreadAttentionTimestamp(session) ?? 0;
    }
    // Standing has no moment of its own — the session did nothing to earn the
    // band — so standing rows fall back to source order within their run.
    return 0;
}

/**
 * Unread membership is a boolean edge, so the ideal ordering key is the instant
 * the session BECAME unread: it stays constant for as long as the row stays
 * unread, and further messages then cannot re-sort the attention lane under a
 * reader who has not read anything yet.
 *
 * Modern rows carry that stable private instant in `viewer.readState`. The
 * activity-time fallback below is retained only for supported pre-viewer Home
 * rows whose released wire shape could not supply the private frontier stamp.
 */
function resolveUnreadAttentionTimestamp(session: Pick<
    SessionListRenderableSession,
    'viewer' | 'unreadSince' | 'meaningfulActivityAt' | 'updatedAt' | 'createdAt'
>): number | null {
    if (session.viewer?.readState.state === 'tracking') {
        return normalizePositiveTimestamp(session.viewer.readState.unreadSince);
    }
    // Bounded pre-viewer wire compatibility: current rows carry the stable
    // private value above, while released scalar rows may still project it.
    const legacyUnreadSince = normalizePositiveTimestamp(session.unreadSince);
    if (legacyUnreadSince !== null) return legacyUnreadSince;
    return normalizePositiveTimestamp(session.meaningfulActivityAt)
        ?? normalizePositiveTimestamp(session.updatedAt)
        ?? normalizePositiveTimestamp(session.createdAt);
}

function resolveActionRequiredAttentionTimestamp(session: Pick<
    SessionListRenderableSession,
    'pendingRequestObservedAt' | 'updatedAt' | 'createdAt'
>): number | null {
    return normalizePositiveTimestamp(session.pendingRequestObservedAt)
        ?? normalizePositiveTimestamp(session.updatedAt)
        ?? normalizePositiveTimestamp(session.createdAt);
}

function normalizeRetainedKeys(retained: ReadonlySet<string> | ReadonlyArray<string> | null | undefined): ReadonlySet<string> {
    if (!retained) return new Set();
    if (retained instanceof Set) return retained;
    return new Set(retained);
}

function buildRetainedKeyRanks(retained: ReadonlySet<string> | ReadonlyArray<string> | null | undefined): ReadonlyMap<string, number> {
    if (!retained) return new Map();
    const ranks = new Map<string, number>();
    let index = 0;
    for (const key of retained) {
        const normalized = typeof key === 'string' ? key.trim() : '';
        if (normalized && !ranks.has(normalized)) {
            ranks.set(normalized, index);
            index += 1;
        }
    }
    return ranks;
}

function compareByTimestamp<Reason extends PlacementReason>(
    left: PlacementCandidate<Reason>,
    right: PlacementCandidate<Reason>,
): number {
    if (left.retainedIndex !== null && right.retainedIndex !== null && left.retainedIndex !== right.retainedIndex) {
        return left.retainedIndex - right.retainedIndex;
    }
    if (right.timestamp !== left.timestamp) return right.timestamp - left.timestamp;
    if (left.originalIndex !== right.originalIndex) return left.originalIndex - right.originalIndex;
    return left.key.localeCompare(right.key);
}

function compareAttentionCandidates(
    left: PlacementCandidate<SessionListAttentionPlacementReason>,
    right: PlacementCandidate<SessionListAttentionPlacementReason>,
): number {
    const priorityDelta = readAttentionReasonPriority(right.attentionOrdering?.reason ?? right.reason)
        - readAttentionReasonPriority(left.attentionOrdering?.reason ?? left.reason);
    if (priorityDelta !== 0) return priorityDelta;
    return compareByTimestamp(left, right);
}

function resolveAttentionCandidate(params: Readonly<{
    item: SessionItem;
    row: SessionListRenderableSession | null;
    originalIndex: number;
    retainedKeys: ReadonlySet<string>;
    retainedKeyRanks: ReadonlyMap<string, number>;
    retainedAttentionPlacements?: ReadonlyMap<string, SessionListRetainedAttentionPlacement>;
    standingPolicy: SessionAttentionStandingPolicy | undefined;
    nowMs: number;
    allowArchived?: boolean;
}>): PlacementCandidate<SessionListAttentionPlacementReason> | null {
    const key = normalizeSessionListKeyParts(params.item.serverId, params.item.sessionId).sessionKey;
    if (!key || !params.row) return null;
    if (!params.allowArchived && (params.item.archivedAt != null || params.row.archivedAt != null)) return null;

    return createAttentionCandidate({
        ...params,
        key,
        row: params.row,
        projection: projectSessionListPlacement({
            session: params.row,
            sessionKey: key,
            standingPolicy: params.standingPolicy,
            nowMs: params.nowMs,
        }),
    });
}

function createAttentionCandidate(params: Readonly<{
    item: SessionItem;
    row: SessionListRenderableSession;
    key: string;
    projection: SessionListPlacementProjection;
    originalIndex: number;
    retainedKeys: ReadonlySet<string>;
    retainedKeyRanks: ReadonlyMap<string, number>;
    retainedAttentionPlacements?: ReadonlyMap<string, SessionListRetainedAttentionPlacement>;
}>): PlacementCandidate<SessionListAttentionPlacementReason> | null {
    const reason = params.projection.attentionReason;
    if (!reason && !params.retainedKeys.has(params.key)) return null;
    if (!reason && params.projection.liveWorking) return null;

    // Retention preserves ordering, while presentation continues to reflect live facts.
    const retained = params.retainedAttentionPlacements?.get(params.key);
    const held = retained !== undefined && (reason === null || reason === 'standing' || reason === 'reminder');
    const resolvedReason = held ? 'ready' : reason ?? 'ready';
    const attentionOrdering = held
        ? { reason: retained.reason, timestamp: retained.timestamp }
        : { reason: resolvedReason, timestamp: resolveAttentionTimestamp(params.row, resolvedReason) };
    return {
        item: params.item,
        row: params.row,
        key: params.key,
        reason: resolvedReason,
        timestamp: attentionOrdering.timestamp,
        attentionOrdering,
        originalIndex: params.originalIndex,
        retainedIndex: params.retainedKeyRanks.get(params.key) ?? null,
        explicitStanding: resolvedReason === 'standing' && params.projection.standingSource === 'override',
    };
}

function resolveWorkingCandidate(params: Readonly<{
    item: SessionItem;
    row: SessionListRenderableSession | null;
    originalIndex: number;
    retainedKeys: ReadonlySet<string>;
    retainedKeyRanks: ReadonlyMap<string, number>;
    nowMs: number;
}>): PlacementCandidate<'working'> | null {
    const key = normalizeSessionListKeyParts(params.item.serverId, params.item.sessionId).sessionKey;
    if (!key || !params.row) return null;
    if (params.item.archivedAt != null || params.row.archivedAt != null) return null;
    return createWorkingCandidate({
        ...params,
        key,
        row: params.row,
        projection: projectSessionListPlacement({
            session: params.row,
            sessionKey: key,
            nowMs: params.nowMs,
        }),
    });
}

function createWorkingCandidate(params: Readonly<{
    item: SessionItem;
    row: SessionListRenderableSession;
    key: string;
    projection: SessionListPlacementProjection;
    originalIndex: number;
    retainedKeys: ReadonlySet<string>;
    retainedKeyRanks: ReadonlyMap<string, number>;
    nowMs: number;
}>): PlacementCandidate<'working'> | null {
    if (params.item.archivedAt != null || params.row.archivedAt != null) return null;
    if (params.projection.attentionReason) return null;
    if (
        !params.projection.liveWorking
        && !(params.retainedKeys.has(params.key) && isRetainableWorkingSession(params.row, params.nowMs))
    ) {
        return null;
    }
    return {
        item: params.item,
        row: params.row,
        key: params.key,
        reason: 'working',
        timestamp: 0,
        originalIndex: params.originalIndex,
        retainedIndex: params.retainedKeyRanks.get(params.key) ?? null,
        retainedWorking: !params.projection.liveWorking,
    };
}

/**
 * Whether placement exempts the row from "Hide inactive sessions". Every earned
 * attention reason does: the session itself is asking for the user. Standing
 * only does when the user asked for THIS session — standing derived from the
 * account default would otherwise turn that filter into a no-op for every quiet
 * session. Placement never CLEARS an exemption the row already carries for its
 * own reasons, so the flag is spread in rather than assigned.
 */
function keepAttentionCandidateVisibleWhenInactive(
    candidate: PlacementCandidate<SessionListAttentionPlacementReason>,
): boolean {
    return candidate.reason !== 'standing' || candidate.explicitStanding === true;
}

function createGlobalAttentionSessionItem(candidate: PlacementCandidate<SessionListAttentionPlacementReason>): SessionItem {
    return {
        ...candidate.item,
        groupKey: ATTENTION_PLACEMENT_GROUP_KEY_V1,
        groupKind: 'attention',
        attentionPlacementReason: candidate.reason,
        attentionPlacementOrdering: candidate.attentionOrdering,
        workingPlacementReason: undefined,
        variant: 'default',
        ...(keepAttentionCandidateVisibleWhenInactive(candidate) ? { keepVisibleWhenInactive: true } : {}),
    };
}

function createWithinGroupAttentionSessionItem(candidate: PlacementCandidate<SessionListAttentionPlacementReason>): SessionItem {
    const keepVisibleWhenInactive = keepAttentionCandidateVisibleWhenInactive(candidate);
    if (
        (!keepVisibleWhenInactive || candidate.item.keepVisibleWhenInactive === true)
        && candidate.item.attentionPlacementReason === candidate.reason
        && candidate.item.attentionPlacementOrdering?.reason === candidate.attentionOrdering?.reason
        && candidate.item.attentionPlacementOrdering?.timestamp === candidate.attentionOrdering?.timestamp
        && candidate.item.workingPlacementReason == null
    ) {
        return candidate.item;
    }
    return {
        ...candidate.item,
        attentionPlacementReason: candidate.reason,
        attentionPlacementOrdering: candidate.attentionOrdering,
        workingPlacementReason: undefined,
        ...(keepVisibleWhenInactive ? { keepVisibleWhenInactive: true } : {}),
    };
}

function resolveWorkingPlacementReason(candidate: PlacementCandidate<'working'>): SessionListWorkingPlacementReason {
    // Retained placement keeps the session in the working group after its
    // live signals went stale; rows use the distinct reason to render a
    // paused indicator instead of pretending live activity.
    return candidate.retainedWorking === true ? 'working-retained' : 'working';
}

function createGlobalWorkingSessionItem(candidate: PlacementCandidate<'working'>): SessionItem {
    const workingPlacementReason = resolveWorkingPlacementReason(candidate);
    return {
        ...candidate.item,
        groupKey: WORKING_PLACEMENT_GROUP_KEY_V1,
        groupKind: 'working',
        attentionPlacementReason: undefined,
        attentionPlacementOrdering: undefined,
        workingPlacementReason,
        variant: 'default',
        keepVisibleWhenInactive: true,
    };
}

function createWithinGroupWorkingSessionItem(candidate: PlacementCandidate<'working'>): SessionItem {
    const workingPlacementReason = resolveWorkingPlacementReason(candidate);
    if (
        candidate.item.keepVisibleWhenInactive === true
        && candidate.item.workingPlacementReason === workingPlacementReason
        && candidate.item.attentionPlacementReason == null
    ) {
        return candidate.item;
    }
    return {
        ...candidate.item,
        attentionPlacementReason: undefined,
        attentionPlacementOrdering: undefined,
        workingPlacementReason,
        keepVisibleWhenInactive: true,
    };
}

const ATTENTION_LANE: PlacementLane<SessionListAttentionPlacementReason> = {
    resolveCandidate: resolveAttentionCandidate,
    compareCandidates: compareAttentionCandidates,
    createGlobalSessionItem: createGlobalAttentionSessionItem,
    createWithinGroupSessionItem: createWithinGroupAttentionSessionItem,
};

const WORKING_LANE: PlacementLane<'working'> = {
    resolveCandidate: resolveWorkingCandidate,
    compareCandidates: compareByTimestamp,
    createGlobalSessionItem: createGlobalWorkingSessionItem,
    createWithinGroupSessionItem: createWithinGroupWorkingSessionItem,
};

export type SessionListGlobalPlacementsResult = Readonly<{
    attentionItems: SessionListIndexItem[];
    workingItems: SessionListIndexItem[];
    remainder: SessionListIndexItem[];
    attentionPromotedCount: number;
    workingPromotedCount: number;
}>;

export function buildSessionListGlobalPlacements(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    attentionOptions: SessionListAttentionPlacementOptions | undefined;
    workingOptions: SessionListWorkingPlacementOptions | undefined;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    nowMs: number;
}>): SessionListGlobalPlacementsResult | null {
    if (params.source.length === 0) return null;

    const attentionEnabled = normalizeSessionListAttentionPlacementMode(params.attentionOptions?.mode) === 'global'
        && params.attentionOptions != null;
    const workingEnabled = normalizeSessionListWorkingPlacementMode(params.workingOptions?.mode) === 'global'
        && params.workingOptions != null;
    if (!attentionEnabled && !workingEnabled) return null;

    const retainedAttentionPlacements = new Map((attentionEnabled ? params.attentionOptions?.retainPlacements ?? [] : [])
        .map((placement) => [placement.key, placement] as const));
    const retainedAttentionSource = [...retainedAttentionPlacements.keys()];
    const retainedWorkingSource = workingEnabled ? params.workingOptions?.retainSessionKeys : undefined;
    const retainedAttentionKeys = normalizeRetainedKeys(retainedAttentionSource);
    const retainedAttentionKeyRanks = buildRetainedKeyRanks(retainedAttentionSource);
    const retainedWorkingKeys = normalizeRetainedKeys(retainedWorkingSource);
    const retainedWorkingKeyRanks = buildRetainedKeyRanks(retainedWorkingSource);
    const attentionCandidates: Array<PlacementCandidate<SessionListAttentionPlacementReason>> = [];
    const workingCandidates: Array<PlacementCandidate<'working'>> = [];
    const promotedKeySet = new Set<string>();

    params.source.forEach((item, originalIndex) => {
        if (item.type !== 'session') return;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        if (!key) return;
        const row = params.resolveSessionRow(item.serverId, item.sessionId);
        if (!row) return;
        const projection = projectSessionListPlacement({
            session: row,
            sessionKey: key,
            standingPolicy: attentionEnabled ? params.attentionOptions?.standingPolicy : undefined,
            nowMs: params.nowMs,
        });

        if (
            attentionEnabled
            && (params.attentionOptions?.includeArchived === true || (item.archivedAt == null && row.archivedAt == null))
        ) {
            const attentionCandidate = createAttentionCandidate({
                item,
                row,
                key,
                projection,
                originalIndex,
                retainedKeys: retainedAttentionKeys,
                retainedKeyRanks: retainedAttentionKeyRanks,
                retainedAttentionPlacements,
            });
            if (attentionCandidate) {
                attentionCandidates.push(attentionCandidate);
                promotedKeySet.add(key);
                return;
            }
        }

        if (!workingEnabled) return;
        const workingCandidate = createWorkingCandidate({
            item,
            row,
            key,
            projection,
            originalIndex,
            retainedKeys: retainedWorkingKeys,
            retainedKeyRanks: retainedWorkingKeyRanks,
            nowMs: params.nowMs,
        });
        if (!workingCandidate) return;
        workingCandidates.push(workingCandidate);
        promotedKeySet.add(key);
    });

    if (attentionCandidates.length === 0 && workingCandidates.length === 0) {
        return null;
    }

    attentionCandidates.sort(compareAttentionCandidates);
    workingCandidates.sort(compareByTimestamp);

    const remainder = params.source.filter((item) => {
        if (item.type !== 'session') return true;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        return !key || !promotedKeySet.has(key);
    });

    return {
        attentionItems: attentionCandidates.length > 0
            ? [
                {
                    type: 'header',
                    title: describeWorkStatusBucket('needs_you'),
                    headerKind: 'attention',
                    groupKey: ATTENTION_PLACEMENT_GROUP_KEY_V1,
                },
                ...attentionCandidates.map(createGlobalAttentionSessionItem),
            ]
            : [],
        workingItems: workingCandidates.length > 0
            ? [
                createWorkingPlacementHeader(),
                ...workingCandidates.map(createGlobalWorkingSessionItem),
            ]
            : [],
        remainder,
        attentionPromotedCount: attentionCandidates.length,
        workingPromotedCount: workingCandidates.length,
    };
}

type SessionRunEntry = Readonly<{
    item: SessionItem;
    row: SessionListRenderableSession | null;
    originalIndex: number;
}>;

function reorderSessionRunWithinGroup<Reason extends PlacementReason>(
    entries: ReadonlyArray<SessionRunEntry>,
    retainedKeys: ReadonlySet<string>,
    standingPolicy: SessionAttentionStandingPolicy | undefined,
    lane: PlacementLane<Reason>,
    nowMs: number,
    allowArchived?: boolean,
    retainedAttentionPlacements?: ReadonlyMap<string, SessionListRetainedAttentionPlacement>,
): Readonly<{
    items: SessionListIndexItem[];
    changed: boolean;
}> {
    const candidates = new Map<SessionItem, PlacementCandidate<Reason>>();
    const retainedKeyRanks = buildRetainedKeyRanks(retainedKeys);
    for (const entry of entries) {
        const candidate = lane.resolveCandidate({
            item: entry.item,
            row: entry.row,
            originalIndex: entry.originalIndex,
            retainedKeys,
            retainedKeyRanks,
            retainedAttentionPlacements,
            standingPolicy,
            nowMs,
            allowArchived,
        });
        if (candidate) candidates.set(entry.item, candidate);
    }

    if (candidates.size === 0) {
        return {
            items: entries.map((entry) => entry.item),
            changed: false,
        };
    }

    const promoted = [...candidates.values()].sort(lane.compareCandidates);
    const remainder = entries
        .map((entry) => entry.item)
        .filter((item) => !candidates.has(item));
    const items = [
        ...promoted.map(lane.createWithinGroupSessionItem),
        ...remainder,
    ];
    const original = entries.map((entry) => entry.item);
    const changed = items.length !== original.length || items.some((item, index) => item !== original[index]);
    return { items, changed };
}

function applySessionListPlacementWithinGroups<Reason extends PlacementReason>(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    retainedKeys?: ReadonlySet<string> | ReadonlyArray<string> | null;
    retainedAttentionPlacements?: ReadonlyMap<string, SessionListRetainedAttentionPlacement>;
    standingPolicy?: SessionAttentionStandingPolicy;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    lane: PlacementLane<Reason>;
    nowMs: number;
    allowArchived?: boolean;
}>): SessionListIndexItem[] {
    if (params.source.length === 0) {
        return params.source as SessionListIndexItem[];
    }

    const retainedKeys = normalizeRetainedKeys(params.retainedKeys);
    const out: SessionListIndexItem[] = [];
    let run: SessionRunEntry[] = [];
    let changed = false;

    const flushRun = () => {
        if (run.length === 0) return;
        const reordered = reorderSessionRunWithinGroup(
            run,
            retainedKeys,
            params.standingPolicy,
            params.lane,
            params.nowMs,
            params.allowArchived,
            params.retainedAttentionPlacements,
        );
        out.push(...reordered.items);
        changed = changed || reordered.changed;
        run = [];
    };

    params.source.forEach((item, originalIndex) => {
        if (item.type === 'session') {
            run.push({
                item,
                row: params.resolveSessionRow(item.serverId, item.sessionId),
                originalIndex,
            });
            return;
        }
        flushRun();
        out.push(item);
    });
    flushRun();

    return changed ? out : params.source as SessionListIndexItem[];
}

export function buildSessionListAttentionPlacement(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListAttentionPlacementOptions | undefined;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    nowMs: number;
}>): SessionListAttentionPlacementResult | null {
    if (normalizeSessionListAttentionPlacementMode(params.options?.mode) !== 'global' || !params.options) {
        return null;
    }

    const result = buildSessionListGlobalPlacements({
        source: params.source,
        attentionOptions: params.options,
        workingOptions: undefined,
        resolveSessionRow: params.resolveSessionRow,
        nowMs: params.nowMs,
    });
    return result && result.attentionPromotedCount > 0
        ? {
            attentionItems: result.attentionItems,
            remainder: result.remainder,
            promotedCount: result.attentionPromotedCount,
        }
        : null;
}

function createWorkingPlacementHeader(): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: describeWorkStatusBucket('working'),
        headerKind: 'working',
        groupKey: WORKING_PLACEMENT_GROUP_KEY_V1,
    };
}

export function buildSessionListWorkingPlacement(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListWorkingPlacementOptions | undefined;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    nowMs: number;
}>): SessionListWorkingPlacementResult | null {
    if (normalizeSessionListWorkingPlacementMode(params.options?.mode) !== 'global' || !params.options) {
        return null;
    }

    const result = buildSessionListGlobalPlacements({
        source: params.source,
        attentionOptions: undefined,
        workingOptions: params.options,
        resolveSessionRow: params.resolveSessionRow,
        nowMs: params.nowMs,
    });
    return result && result.workingPromotedCount > 0
        ? {
            workingItems: result.workingItems,
            remainder: result.remainder,
            promotedCount: result.workingPromotedCount,
        }
        : null;
}

export function applySessionListAttentionPlacementWithinGroups(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListAttentionPlacementOptions | undefined;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    nowMs: number;
}>): SessionListIndexItem[] {
    if (normalizeSessionListAttentionPlacementMode(params.options?.mode) !== 'withinGroups' || !params.options) {
        return params.source as SessionListIndexItem[];
    }

    return applySessionListPlacementWithinGroups({
        source: params.source,
        retainedKeys: params.options.retainPlacements?.map((placement) => placement.key),
        retainedAttentionPlacements: new Map(params.options.retainPlacements?.map((placement) => [placement.key, placement])),
        standingPolicy: params.options.standingPolicy,
        allowArchived: params.options.includeArchived === true,
        resolveSessionRow: params.resolveSessionRow,
        lane: ATTENTION_LANE,
        nowMs: params.nowMs,
    });
}

export function applySessionListWorkingPlacementWithinGroups(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListWorkingPlacementOptions | undefined;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    nowMs: number;
}>): SessionListIndexItem[] {
    if (normalizeSessionListWorkingPlacementMode(params.options?.mode) !== 'withinGroups' || !params.options) {
        return params.source as SessionListIndexItem[];
    }

    return applySessionListPlacementWithinGroups({
        source: params.source,
        retainedKeys: params.options.retainSessionKeys,
        resolveSessionRow: params.resolveSessionRow,
        lane: WORKING_LANE,
        nowMs: params.nowMs,
    });
}

export { normalizeSessionListAttentionPlacementMode, normalizeSessionListWorkingPlacementMode };
export type {
    SessionListAttentionPlacementMode,
    SessionListAttentionPlacementReason,
    SessionListWorkingPlacementMode,
};
