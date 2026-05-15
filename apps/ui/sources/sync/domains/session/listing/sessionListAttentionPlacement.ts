import { t } from '@/text';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import type { SessionListRenderableSession } from './sessionListRenderable';
import {
    normalizeSessionListAttentionPlacementMode,
    type SessionListAttentionPlacementMode,
    type SessionListAttentionPlacementReason,
} from './sessionListAttentionPlacementTypes';

export const ATTENTION_PLACEMENT_GROUP_KEY_V1 = 'attention-promotion-v1';

export type SessionListAttentionPlacementOptions = Readonly<{
    mode: SessionListAttentionPlacementMode;
    retainSessionKeys?: ReadonlySet<string> | ReadonlyArray<string> | null;
}>;

export type SessionListAttentionPlacementResult = Readonly<{
    attentionItems: SessionListIndexItem[];
    remainder: SessionListIndexItem[];
    promotedCount: number;
}>;

type SessionItem = Extract<SessionListIndexItem, { type: 'session' }>;

type PlacementCandidate = Readonly<{
    item: SessionItem;
    row: SessionListRenderableSession;
    key: string;
    reason: SessionListAttentionPlacementReason;
    timestamp: number;
    originalIndex: number;
}>;

const REASON_PRIORITY: Readonly<Record<SessionListAttentionPlacementReason, number>> = {
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

function normalizeTimestamp(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizePositiveTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function isPresenceOnline(value: unknown): boolean {
    return value === 'online';
}

function isActiveBlockerSession(session: SessionListRenderableSession): boolean {
    return session.active === true && isPresenceOnline(session.presence);
}

function isWorkingSession(session: SessionListRenderableSession): boolean {
    return session.latestTurnStatus === 'in_progress'
        || session.thinking === true
        || normalizeTimestamp(session.optimisticThinkingAt, 0) > 0
        || normalizeTimestamp(session.thinkingGraceUntil, 0) > Date.now();
}

function isTerminalTurnAfterReadCursor(session: SessionListRenderableSession): boolean {
    if (session.latestTurnStatus !== 'completed') {
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
    const issue = session.lastRuntimeIssue;
    return session.latestTurnStatus === 'failed'
        && issue?.v === 1
        && issue.scope === 'primary_session'
        && issue.status === 'failed';
}

function resolvePlacementReason(session: SessionListRenderableSession): SessionListAttentionPlacementReason | null {
    if (isWorkingSession(session)) {
        return null;
    }
    if (isActiveBlockerSession(session) && session.hasPendingUserActionRequests === true) {
        return 'action_required';
    }
    if (isActiveBlockerSession(session) && session.hasPendingPermissionRequests === true) {
        return 'permission_required';
    }
    if (isPrimarySessionFailure(session)) {
        return 'failed';
    }
    if (isTerminalTurnAfterReadCursor(session)) {
        return 'ready';
    }
    return null;
}

function resolvePlacementTimestamp(
    session: SessionListRenderableSession,
    reason: SessionListAttentionPlacementReason,
): number {
    if (reason === 'failed') {
        return normalizeTimestamp(session.lastRuntimeIssue?.occurredAt, session.updatedAt);
    }
    if (reason === 'ready') {
        return normalizeTimestamp(session.lastTurnCompletedAt, session.updatedAt);
    }
    return normalizeTimestamp(session.updatedAt, session.createdAt);
}

function normalizeRetainedKeys(options: SessionListAttentionPlacementOptions): ReadonlySet<string> {
    const retained = options.retainSessionKeys;
    if (!retained) return new Set();
    if (retained instanceof Set) return retained;
    return new Set(retained);
}

function createGlobalAttentionSessionItem(candidate: PlacementCandidate): SessionItem {
    return {
        ...candidate.item,
        pinned: false,
        groupKey: ATTENTION_PLACEMENT_GROUP_KEY_V1,
        groupKind: 'attention',
        attentionPlacementReason: candidate.reason,
        variant: 'default',
        keepVisibleWhenInactive: true,
    };
}

function createWithinGroupAttentionSessionItem(candidate: PlacementCandidate): SessionItem {
    if (candidate.item.keepVisibleWhenInactive === true && candidate.item.attentionPlacementReason === candidate.reason) {
        return candidate.item;
    }
    return {
        ...candidate.item,
        attentionPlacementReason: candidate.reason,
        keepVisibleWhenInactive: true,
    };
}

function comparePlacementCandidates(left: PlacementCandidate, right: PlacementCandidate): number {
    const priorityDelta = REASON_PRIORITY[left.reason] - REASON_PRIORITY[right.reason];
    if (priorityDelta !== 0) return priorityDelta;
    if (right.timestamp !== left.timestamp) return right.timestamp - left.timestamp;
    if (left.originalIndex !== right.originalIndex) return left.originalIndex - right.originalIndex;
    return left.key.localeCompare(right.key);
}

function resolvePlacementCandidate(params: Readonly<{
    item: SessionItem;
    row: SessionListRenderableSession | null;
    originalIndex: number;
    retainedKeys: ReadonlySet<string>;
}>): PlacementCandidate | null {
    const key = normalizeSessionListKeyParts(params.item.serverId, params.item.sessionId).sessionKey;
    if (!key || !params.row) return null;
    if (params.item.pinned === true || params.item.groupKind === 'pinned') return null;
    if (params.item.archivedAt != null || params.row.archivedAt != null) return null;

    const reason = resolvePlacementReason(params.row);
    if (!reason && !params.retainedKeys.has(key)) return null;
    if (!reason && isWorkingSession(params.row)) return null;

    const resolvedReason = reason ?? 'ready';
    return {
        item: params.item,
        row: params.row,
        key,
        reason: resolvedReason,
        timestamp: resolvePlacementTimestamp(params.row, resolvedReason),
        originalIndex: params.originalIndex,
    };
}

export function buildSessionListAttentionPlacement(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListAttentionPlacementOptions | undefined;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
}>): SessionListAttentionPlacementResult | null {
    if (
        normalizeSessionListAttentionPlacementMode(params.options?.mode) !== 'global'
        || !params.options
        || params.source.length === 0
    ) {
        return null;
    }

    const retainedKeys = normalizeRetainedKeys(params.options);
    const promoted: PlacementCandidate[] = [];
    const promotedKeySet = new Set<string>();

    params.source.forEach((item, originalIndex) => {
        if (item.type !== 'session') return;
        const candidate = resolvePlacementCandidate({
            item,
            row: params.resolveSessionRow(item.serverId, item.sessionId),
            originalIndex,
            retainedKeys,
        });
        if (!candidate) return;
        promoted.push(candidate);
        promotedKeySet.add(candidate.key);
    });

    if (promoted.length === 0) {
        return null;
    }

    promoted.sort(comparePlacementCandidates);

    const remainder = params.source.filter((item) => {
        if (item.type !== 'session') return true;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        return !key || !promotedKeySet.has(key);
    });

    return {
        attentionItems: [{
            type: 'header',
            title: t('sessionsList.attentionSectionTitle'),
            headerKind: 'attention',
            groupKey: ATTENTION_PLACEMENT_GROUP_KEY_V1,
        }, ...promoted.map(createGlobalAttentionSessionItem)],
        remainder,
        promotedCount: promoted.length,
    };
}

type SessionRunEntry = Readonly<{
    item: SessionItem;
    row: SessionListRenderableSession | null;
    originalIndex: number;
}>;

function reorderSessionRunWithinGroup(
    entries: ReadonlyArray<SessionRunEntry>,
    retainedKeys: ReadonlySet<string>,
): Readonly<{
    items: SessionListIndexItem[];
    changed: boolean;
}> {
    const candidates = new Map<SessionItem, PlacementCandidate>();
    for (const entry of entries) {
        const candidate = resolvePlacementCandidate({
            item: entry.item,
            row: entry.row,
            originalIndex: entry.originalIndex,
            retainedKeys,
        });
        if (candidate) candidates.set(entry.item, candidate);
    }

    if (candidates.size === 0) {
        return {
            items: entries.map((entry) => entry.item),
            changed: false,
        };
    }

    const promoted = [...candidates.values()].sort(comparePlacementCandidates);
    const remainder = entries
        .map((entry) => entry.item)
        .filter((item) => !candidates.has(item));
    const items = [
        ...promoted.map(createWithinGroupAttentionSessionItem),
        ...remainder,
    ];
    const original = entries.map((entry) => entry.item);
    const changed = items.length !== original.length || items.some((item, index) => item !== original[index]);
    return { items, changed };
}

export function applySessionListAttentionPlacementWithinGroups(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListAttentionPlacementOptions | undefined;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
}>): SessionListIndexItem[] {
    if (
        normalizeSessionListAttentionPlacementMode(params.options?.mode) !== 'withinGroups'
        || !params.options
        || params.source.length === 0
    ) {
        return params.source as SessionListIndexItem[];
    }

    const retainedKeys = normalizeRetainedKeys(params.options);
    const out: SessionListIndexItem[] = [];
    let run: SessionRunEntry[] = [];
    let changed = false;

    const flushRun = () => {
        if (run.length === 0) return;
        const reordered = reorderSessionRunWithinGroup(run, retainedKeys);
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

export { normalizeSessionListAttentionPlacementMode };
export type { SessionListAttentionPlacementMode, SessionListAttentionPlacementReason };
