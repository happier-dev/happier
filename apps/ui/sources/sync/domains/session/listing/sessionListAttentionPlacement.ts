import { t } from '@/text';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/runtimePresentation';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import {
    resolveSessionAttentionStandingSource,
    type SessionAttentionStandingPolicy,
    type SessionAttentionStandingSource,
} from '@/sync/domains/session/organization/attentionStanding';

import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { hasActivityClearlyAfterTerminalProjection } from './sessionListTerminalActivity';
import {
    normalizeSessionListAttentionPlacementMode,
    normalizeSessionListWorkingPlacementMode,
    type SessionListAttentionPlacementMode,
    type SessionListAttentionPlacementReason,
    type SessionListWorkingPlacementMode,
    type SessionListWorkingPlacementReason,
} from './sessionListAttentionPlacementTypes';

export const ATTENTION_PLACEMENT_GROUP_KEY_V1 = 'attention-promotion-v1';
export const WORKING_PLACEMENT_GROUP_KEY_V1 = 'working-placement-v1';
export const SESSION_LIST_WORKING_RETENTION_LIMIT_MS = 12 * 60 * 60 * 1000;

export type SessionListAttentionPlacementOptions = Readonly<{
    mode: SessionListAttentionPlacementMode;
    /**
     * Rows to hold in the band for one more pass even though they no longer
     * earn it — the session the user is currently reading. Retention carries
     * keys only: the reason that placed a row is a live fact about the session,
     * and replaying a stale one would relabel an approved session as still
     * blocked.
     */
    retainSessionKeys?: ReadonlySet<string> | ReadonlyArray<string> | null;
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
        standingPolicy: SessionAttentionStandingPolicy | undefined;
        nowMs: number;
        workingPlacementOptions?: SessionListWorkingPlacementOptions;
    }>) => PlacementCandidate<Reason> | null;
    compareCandidates: (left: PlacementCandidate<Reason>, right: PlacementCandidate<Reason>) => number;
    createGlobalSessionItem: (candidate: PlacementCandidate<Reason>) => SessionItem;
    createWithinGroupSessionItem: (candidate: PlacementCandidate<Reason>) => SessionItem;
}>;

const ATTENTION_REASON_PRIORITY: Readonly<Record<SessionListAttentionPlacementReason, number>> = {
    action_required: 0,
    permission_required: 1,
    failed: 2,
    ready: 3,
    unread: 4,
    // Standing is the floor of the band: it only reaches sessions whose own
    // signals place them nowhere, so it always sorts behind every earned reason.
    standing: 5,
};

function normalizeSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function normalizePositiveTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function deriveRuntimePresentationForSession(session: SessionListRenderableSession, nowMs: number) {
    return deriveSessionRuntimePresentationState({
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

function isWorkingPlacementSession(session: SessionListRenderableSession, nowMs: number): boolean {
    const runtimePresentation = deriveRuntimePresentationForSession(session, nowMs);
    return runtimePresentation.working
        || (session.presence === 'online' && runtimePresentation.backgroundActive);
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
    if (hasActivityClearlyAfterTerminalProjection(session.meaningfulActivityAt, session.latestTurnStatusObservedAt)) {
        return false;
    }
    const turnCompletedAt = normalizePositiveTimestamp(session.lastTurnCompletedAt);
    const readStateUpdatedAt = normalizePositiveTimestamp(session.metadata?.readStateV1?.updatedAt);
    if (turnCompletedAt != null && readStateUpdatedAt != null && readStateUpdatedAt >= turnCompletedAt) {
        return false;
    }
    const sessionSeq = normalizeSeq(session.seq);
    if (sessionSeq == null) return false;
    return sessionSeq > (normalizeSeq(session.lastViewedSessionSeq) ?? 0);
}

function isPrimarySessionFailure(session: SessionListRenderableSession): boolean {
    return session.latestTurnStatus === 'failed'
        && shouldPromoteFailedSessionAttention(session);
}

function shouldPromoteFailedSessionAttention(session: SessionListRenderableSession): boolean {
    return session.active === true || session.hasUnreadMessages === true;
}

function resolveAttentionReason(
    session: SessionListRenderableSession,
    nowMs: number,
    standingSource: SessionAttentionStandingSource = 'none',
): SessionListAttentionPlacementReason | null {
    const runtimePresentation = deriveSessionRuntimePresentationState({
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
    if (runtimePresentation.attention === 'failed' && isPrimarySessionFailure(session)) {
        return 'failed';
    }
    if (runtimePresentation.freshActionRequired) {
        return 'action_required';
    }
    if (runtimePresentation.freshPermissionRequired) {
        return 'permission_required';
    }
    if ((session.pendingBlockedCount ?? 0) > 0) {
        return 'action_required';
    }
    if (
        runtimePresentation.working
        || (session.presence === 'online' && runtimePresentation.backgroundActive)
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
    if (reason === 'unread') {
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
 * This checkout carries no became-unread fact — neither a server column nor a
 * renderable stamp — so the closest correct key available is the same activity
 * time the row is already ordered by everywhere else. The limitation is
 * observable: an unread session that keeps receiving messages moves within the
 * unread run of the attention band. It costs no extra index work, because that
 * same activity already reorders the source index and re-runs placement.
 */
function resolveUnreadAttentionTimestamp(session: Pick<
    SessionListRenderableSession,
    'meaningfulActivityAt' | 'updatedAt' | 'createdAt'
>): number | null {
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
    const priorityDelta = ATTENTION_REASON_PRIORITY[left.reason] - ATTENTION_REASON_PRIORITY[right.reason];
    if (priorityDelta !== 0) return priorityDelta;
    return compareByTimestamp(left, right);
}

function resolveAttentionCandidate(params: Readonly<{
    item: SessionItem;
    row: SessionListRenderableSession | null;
    originalIndex: number;
    retainedKeys: ReadonlySet<string>;
    retainedKeyRanks: ReadonlyMap<string, number>;
    standingPolicy: SessionAttentionStandingPolicy | undefined;
    nowMs: number;
}>): PlacementCandidate<SessionListAttentionPlacementReason> | null {
    const key = normalizeSessionListKeyParts(params.item.serverId, params.item.sessionId).sessionKey;
    if (!key || !params.row) return null;
    if (params.item.archivedAt != null || params.row.archivedAt != null) return null;

    const standingSource = params.standingPolicy
        ? resolveSessionAttentionStandingSource(params.standingPolicy, key)
        : 'none';
    const reason = resolveAttentionReason(params.row, params.nowMs, standingSource);
    if (!reason && !params.retainedKeys.has(key)) return null;
    if (!reason && isWorkingPlacementSession(params.row, params.nowMs)) return null;

    // A retained row has no live reason left, so it is held with the neutral
    // one. Its former reason is a fact about the session that has since
    // changed; replaying it would paint an approved permission, a handled
    // request, or a cleared failure back onto the row the user just resolved.
    const resolvedReason = reason ?? 'ready';
    return {
        item: params.item,
        row: params.row,
        key,
        reason: resolvedReason,
        timestamp: resolveAttentionTimestamp(params.row, resolvedReason),
        originalIndex: params.originalIndex,
        retainedIndex: params.retainedKeyRanks.get(key) ?? null,
        explicitStanding: resolvedReason === 'standing' && standingSource === 'override',
    };
}

function resolveWorkingCandidate(params: Readonly<{
    item: SessionItem;
    row: SessionListRenderableSession | null;
    originalIndex: number;
    retainedKeys: ReadonlySet<string>;
    retainedKeyRanks: ReadonlyMap<string, number>;
    nowMs: number;
    workingPlacementOptions?: SessionListWorkingPlacementOptions;
}>): PlacementCandidate<'working'> | null {
    const key = normalizeSessionListKeyParts(params.item.serverId, params.item.sessionId).sessionKey;
    if (!key || !params.row) return null;
    if (params.item.archivedAt != null || params.row.archivedAt != null) return null;
    if (resolveAttentionReason(params.row, params.nowMs)) return null;
    const runtimePresentation = deriveRuntimePresentationForSession(params.row, params.nowMs);
    const liveWorking = runtimePresentation.working
        || (params.row.presence === 'online' && runtimePresentation.backgroundActive);
    if (!liveWorking && !(params.retainedKeys.has(key) && isRetainableWorkingSession(params.row, params.nowMs))) {
        return null;
    }
    return {
        item: params.item,
        row: params.row,
        key,
        reason: 'working',
        timestamp: 0,
        originalIndex: params.originalIndex,
        retainedIndex: params.retainedKeyRanks.get(key) ?? null,
        retainedWorking: !liveWorking,
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
        && candidate.item.workingPlacementReason == null
    ) {
        return candidate.item;
    }
    return {
        ...candidate.item,
        attentionPlacementReason: candidate.reason,
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

type SessionListPlacementResult = Readonly<{
    placementItems: SessionListIndexItem[];
    remainder: SessionListIndexItem[];
    promotedCount: number;
}>;

function buildSessionListGlobalPlacement<Reason extends PlacementReason>(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    retainedKeys?: ReadonlySet<string> | ReadonlyArray<string> | null;
    standingPolicy?: SessionAttentionStandingPolicy;
    workingPlacementOptions?: SessionListWorkingPlacementOptions;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    lane: PlacementLane<Reason>;
    header: Extract<SessionListIndexItem, { type: 'header' }>;
    nowMs: number;
}>): SessionListPlacementResult | null {
    if (params.source.length === 0) return null;

    const retainedKeys = normalizeRetainedKeys(params.retainedKeys);
    const retainedKeyRanks = buildRetainedKeyRanks(params.retainedKeys);
    const promoted: Array<PlacementCandidate<Reason>> = [];
    const promotedKeySet = new Set<string>();

    params.source.forEach((item, originalIndex) => {
        if (item.type !== 'session') return;
        const candidate = params.lane.resolveCandidate({
            item,
            row: params.resolveSessionRow(item.serverId, item.sessionId),
            originalIndex,
            retainedKeys,
            retainedKeyRanks,
            standingPolicy: params.standingPolicy,
            nowMs: params.nowMs,
            workingPlacementOptions: params.workingPlacementOptions,
        });
        if (!candidate) return;
        promoted.push(candidate);
        promotedKeySet.add(candidate.key);
    });

    if (promoted.length === 0) {
        return null;
    }

    promoted.sort(params.lane.compareCandidates);

    const remainder = params.source.filter((item) => {
        if (item.type !== 'session') return true;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        return !key || !promotedKeySet.has(key);
    });

    return {
        placementItems: [
            params.header,
            ...promoted.map(params.lane.createGlobalSessionItem),
        ],
        remainder,
        promotedCount: promoted.length,
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
    workingPlacementOptions?: SessionListWorkingPlacementOptions,
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
            standingPolicy,
            nowMs,
            workingPlacementOptions,
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
    standingPolicy?: SessionAttentionStandingPolicy;
    workingPlacementOptions?: SessionListWorkingPlacementOptions;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    lane: PlacementLane<Reason>;
    nowMs: number;
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
            params.workingPlacementOptions,
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

    const result = buildSessionListGlobalPlacement({
        source: params.source,
        retainedKeys: params.options.retainSessionKeys,
        standingPolicy: params.options.standingPolicy,
        resolveSessionRow: params.resolveSessionRow,
        lane: ATTENTION_LANE,
        nowMs: params.nowMs,
        header: {
            type: 'header',
            title: t('sessionsList.attentionSectionTitle'),
            headerKind: 'attention',
            groupKey: ATTENTION_PLACEMENT_GROUP_KEY_V1,
        },
    });
    return result
        ? {
            attentionItems: result.placementItems,
            remainder: result.remainder,
            promotedCount: result.promotedCount,
        }
        : null;
}

function createWorkingPlacementHeader(): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: t('sessionsList.workingSectionTitle'),
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

    const result = buildSessionListGlobalPlacement({
        source: params.source,
        retainedKeys: params.options.retainSessionKeys,
        workingPlacementOptions: params.options,
        resolveSessionRow: params.resolveSessionRow,
        lane: WORKING_LANE,
        nowMs: params.nowMs,
        header: createWorkingPlacementHeader(),
    });
    return result
        ? {
            workingItems: result.placementItems,
            remainder: result.remainder,
            promotedCount: result.promotedCount,
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
        retainedKeys: params.options.retainSessionKeys,
        standingPolicy: params.options.standingPolicy,
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
        workingPlacementOptions: params.options,
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
