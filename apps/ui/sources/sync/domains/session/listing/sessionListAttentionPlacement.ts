import { t } from '@/text';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/runtimePresentation';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { hasActivityClearlyAfterTerminalProjection } from './sessionListTerminalActivity';
import {
    normalizeSessionListAttentionPlacementMode,
    normalizeSessionListWorkingPlacementMode,
    type SessionListAttentionPlacementMode,
    type SessionListAttentionPlacementReason,
    type SessionListWorkingPlacementMode,
} from './sessionListAttentionPlacementTypes';

export const ATTENTION_PLACEMENT_GROUP_KEY_V1 = 'attention-promotion-v1';
export const WORKING_PLACEMENT_GROUP_KEY_V1 = 'working-placement-v1';
export const SESSION_LIST_WORKING_RETENTION_LIMIT_MS = 12 * 60 * 60 * 1000;

export type SessionListAttentionPlacementOptions = Readonly<{
    mode: SessionListAttentionPlacementMode;
    retainSessionKeys?: ReadonlySet<string> | ReadonlyArray<string> | null;
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
}>;

type PlacementLane<Reason extends PlacementReason> = Readonly<{
    resolveCandidate: (params: Readonly<{
        item: SessionItem;
        row: SessionListRenderableSession | null;
        originalIndex: number;
        retainedKeys: ReadonlySet<string>;
        retainedKeyRanks: ReadonlyMap<string, number>;
        nowMs: number;
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
};

function normalizeSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function normalizePositiveTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function isWorkingSession(session: SessionListRenderableSession, nowMs: number): boolean {
    return deriveSessionRuntimePresentationState({
        active: session.active,
        activeAt: session.thinking === false ? 0 : session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus: session.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt ?? null,
        meaningfulActivityAt: session.meaningfulActivityAt ?? null,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        hasPendingPermissionRequests: session.hasPendingPermissionRequests,
        hasPendingUserActionRequests: session.hasPendingUserActionRequests,
        pendingRequestObservedAt: session.pendingRequestObservedAt ?? null,
        nowMs,
    }).working;
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
): SessionListAttentionPlacementReason | null {
    const runtimePresentation = deriveSessionRuntimePresentationState({
        active: session.active,
        activeAt: session.thinking === false ? 0 : session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus: session.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt ?? null,
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
    if (runtimePresentation.working) {
        return null;
    }
    if (isTerminalTurnAfterReadCursor(session)) {
        return 'ready';
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
        return normalizePositiveTimestamp(session.pendingRequestObservedAt) ?? 0;
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
    return 0;
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
    nowMs: number;
}>): PlacementCandidate<SessionListAttentionPlacementReason> | null {
    const key = normalizeSessionListKeyParts(params.item.serverId, params.item.sessionId).sessionKey;
    if (!key || !params.row) return null;
    if (params.item.archivedAt != null || params.row.archivedAt != null) return null;

    const reason = resolveAttentionReason(params.row, params.nowMs);
    if (!reason && !params.retainedKeys.has(key)) return null;
    if (!reason && isWorkingSession(params.row, params.nowMs)) return null;

    const resolvedReason = reason ?? 'ready';
    return {
        item: params.item,
        row: params.row,
        key,
        reason: resolvedReason,
        timestamp: resolveAttentionTimestamp(params.row, resolvedReason),
        originalIndex: params.originalIndex,
        retainedIndex: params.retainedKeyRanks.get(key) ?? null,
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
    if (resolveAttentionReason(params.row, params.nowMs)) return null;
    if (!isWorkingSession(params.row, params.nowMs) && !(params.retainedKeys.has(key) && isRetainableWorkingSession(params.row, params.nowMs))) {
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
    };
}

function createGlobalAttentionSessionItem(candidate: PlacementCandidate<SessionListAttentionPlacementReason>): SessionItem {
    return {
        ...candidate.item,
        groupKey: ATTENTION_PLACEMENT_GROUP_KEY_V1,
        groupKind: 'attention',
        attentionPlacementReason: candidate.reason,
        workingPlacementReason: undefined,
        variant: 'default',
        keepVisibleWhenInactive: true,
    };
}

function createWithinGroupAttentionSessionItem(candidate: PlacementCandidate<SessionListAttentionPlacementReason>): SessionItem {
    if (
        candidate.item.keepVisibleWhenInactive === true
        && candidate.item.attentionPlacementReason === candidate.reason
        && candidate.item.workingPlacementReason == null
    ) {
        return candidate.item;
    }
    return {
        ...candidate.item,
        attentionPlacementReason: candidate.reason,
        workingPlacementReason: undefined,
        keepVisibleWhenInactive: true,
    };
}

function createGlobalWorkingSessionItem(candidate: PlacementCandidate<'working'>): SessionItem {
    return {
        ...candidate.item,
        groupKey: WORKING_PLACEMENT_GROUP_KEY_V1,
        groupKind: 'working',
        attentionPlacementReason: undefined,
        workingPlacementReason: 'working',
        variant: 'default',
        keepVisibleWhenInactive: true,
    };
}

function createWithinGroupWorkingSessionItem(candidate: PlacementCandidate<'working'>): SessionItem {
    if (
        candidate.item.keepVisibleWhenInactive === true
        && candidate.item.workingPlacementReason === 'working'
        && candidate.item.attentionPlacementReason == null
    ) {
        return candidate.item;
    }
    return {
        ...candidate.item,
        attentionPlacementReason: undefined,
        workingPlacementReason: 'working',
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
            nowMs: params.nowMs,
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
    lane: PlacementLane<Reason>,
    nowMs: number,
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
            nowMs,
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
        const reordered = reorderSessionRunWithinGroup(run, retainedKeys, params.lane, params.nowMs);
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
        resolveSessionRow: params.resolveSessionRow,
        lane: WORKING_LANE,
        nowMs: params.nowMs,
        header: {
            type: 'header',
            title: t('sessionsList.workingSectionTitle'),
            headerKind: 'working',
            groupKey: WORKING_PLACEMENT_GROUP_KEY_V1,
        },
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
