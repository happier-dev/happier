import type { ServerSelectionPresentation } from '@/sync/domains/server/selection/serverSelectionTypes';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import { applySessionListIndexPresentation } from './sessionListIndexPresentation';
import { normalizeTrimmedStringArrayWithSharedEmpty } from './normalizeTrimmedStringArrayWithSharedEmpty';
import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import type { SessionListRenderableSession } from './sessionListRenderable';

export type SessionListOrderingModeV1 = 'custom' | 'created' | 'updated';

export type ComputeVisibleSessionListIndexParams = Readonly<{
    source: ReadonlyArray<SessionListIndexItem> | null;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    hideInactiveSessions: boolean;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    sessionListOrderingModeV1?: SessionListOrderingModeV1;
    presentation: Readonly<{
        enabled: boolean;
        presentation: ServerSelectionPresentation;
        selectedServerIds?: ReadonlyArray<string>;
    }>;
    storageFilterApplied?: boolean;
}>;

const PINNED_GROUP_KEY_V1 = 'pinned-v1';

type VisibleSessionListSourceState = Readonly<{
    hasArchivedSessionItems: boolean;
    hasInactiveSessionsThatNeedFiltering: boolean;
    hasOrphanHeaders: boolean;
}>;

function resolveSessionRowForItem(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): SessionListRenderableSession | null {
    const sessionId = normalizeTrimmedString(item.sessionId);
    if (!sessionId) return null;
    const serverId = normalizeTrimmedString(item.serverId) || null;
    return resolveSessionRow(serverId, sessionId);
}

function inspectVisibleSessionListSourceState(
    items: ReadonlyArray<SessionListIndexItem>,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): VisibleSessionListSourceState {
    let hasArchivedSessionItems = false;
    let hasInactiveSessionsThatNeedFiltering = false;
    let pendingSectionHeader: Extract<SessionListIndexItem, { type: 'header' }> | null = null;
    let pendingGroupHeader: Extract<SessionListIndexItem, { type: 'header' }> | null = null;

    for (const item of items) {
        if (item.type === 'header') {
            if (item.headerKind === 'active' || item.headerKind === 'inactive') {
                pendingSectionHeader = item;
                pendingGroupHeader = null;
            } else {
                pendingGroupHeader = item;
            }
            continue;
        }

        if (item.type !== 'session') {
            continue;
        }

        pendingSectionHeader = null;
        pendingGroupHeader = null;

        const row = resolveSessionRowForItem(item, resolveSessionRow);
        if (!row) {
            continue;
        }

        if (!hasArchivedSessionItems && row.archivedAt != null) {
            hasArchivedSessionItems = true;
        }

        if (
            !hasInactiveSessionsThatNeedFiltering
            && item.section !== 'active'
            && row.active !== true
            && row.keepVisibleWhenInactive !== true
        ) {
            hasInactiveSessionsThatNeedFiltering = true;
        }
    }

    return {
        hasArchivedSessionItems,
        hasInactiveSessionsThatNeedFiltering,
        hasOrphanHeaders: pendingSectionHeader != null || pendingGroupHeader != null,
    };
}

function countOrderedGroups(orderByGroupKey: Readonly<Record<string, ReadonlyArray<string> | undefined>> | undefined): number {
    if (!orderByGroupKey) return 0;
    return Object.values(orderByGroupKey).filter((keys) => Array.isArray(keys) && keys.length > 0).length;
}

function countPinnedSessionKeys(keys: ReadonlyArray<string> | undefined): number {
    return (keys ?? []).filter((key) => typeof key === 'string' && key.trim().length > 0).length;
}

function countSessionItems(items: ReadonlyArray<SessionListIndexItem>): number {
    let count = 0;
    for (const item of items) {
        if (item.type === 'session') {
            count += 1;
        }
    }
    return count;
}

function nowMs(): number {
    const perf = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
    if (typeof perf?.now === 'function') {
        return perf.now();
    }
    return Date.now();
}

function compareSessionItemsByOrderingMode(
    a: Extract<SessionListIndexItem, { type: 'session' }>,
    b: Extract<SessionListIndexItem, { type: 'session' }>,
    orderingMode: SessionListOrderingModeV1,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): number {
    const rowA = resolveSessionRowForItem(a, resolveSessionRow);
    const rowB = resolveSessionRowForItem(b, resolveSessionRow);

    const updatedA = rowA?.updatedAt ?? 0;
    const updatedB = rowB?.updatedAt ?? 0;
    const createdA = rowA?.createdAt ?? 0;
    const createdB = rowB?.createdAt ?? 0;

    if (orderingMode === 'updated') {
        if (updatedB !== updatedA) {
            return updatedB - updatedA;
        }
    } else if (orderingMode === 'created') {
        if (createdB !== createdA) {
            return createdB - createdA;
        }
    } else {
        if (createdB !== createdA) {
            return createdB - createdA;
        }
    }

    if (orderingMode === 'updated' && createdB !== createdA) {
        return createdB - createdA;
    }

    const aId = normalizeTrimmedString(a.sessionId);
    const bId = normalizeTrimmedString(b.sessionId);
    return aId.localeCompare(bId);
}

function isSessionListIndexItemsAlreadyOrderedByOrderingMode(
    source: ReadonlyArray<SessionListIndexItem>,
    orderingMode: SessionListOrderingModeV1,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): boolean {
    const lastSessionByGroupKey = new Map<string, Extract<SessionListIndexItem, { type: 'session' }>>();

    for (const item of source) {
        if (item.type !== 'session') continue;

        const groupKey = normalizeTrimmedString(item.groupKey);
        if (!groupKey) continue;

        const previous = lastSessionByGroupKey.get(groupKey);
        if (previous && compareSessionItemsByOrderingMode(previous, item, orderingMode, resolveSessionRow) > 0) {
            return false;
        }

        lastSessionByGroupKey.set(groupKey, item);
    }

    return lastSessionByGroupKey.size > 0;
}

function sortSessionListIndexItemsByOrderingMode(
    source: ReadonlyArray<SessionListIndexItem>,
    orderingMode: SessionListOrderingModeV1,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): SessionListIndexItem[] {
    if (orderingMode === 'custom') {
        return source as SessionListIndexItem[];
    }

    if (isSessionListIndexItemsAlreadyOrderedByOrderingMode(source, orderingMode, resolveSessionRow)) {
        return source as SessionListIndexItem[];
    }

    const sessionsByGroupKey = new Map<string, Array<Extract<SessionListIndexItem, { type: 'session' }>>>();
    for (const item of source) {
        if (item.type !== 'session') continue;
        const groupKey = normalizeTrimmedString(item.groupKey);
        if (!groupKey) continue;
        if (!sessionsByGroupKey.has(groupKey)) {
            sessionsByGroupKey.set(groupKey, []);
        }
        sessionsByGroupKey.get(groupKey)!.push(item);
    }

    const sortedByGroupKey = new Map<string, Array<Extract<SessionListIndexItem, { type: 'session' }>>>();
    for (const [groupKey, sessions] of sessionsByGroupKey.entries()) {
        if (sessions.length < 2) continue;
        const next = [...sessions].sort((a, b) => compareSessionItemsByOrderingMode(a, b, orderingMode, resolveSessionRow));
        sortedByGroupKey.set(groupKey, next);
    }

    if (sortedByGroupKey.size === 0) {
        return source as SessionListIndexItem[];
    }

    const indicesByGroupKey = new Map<string, number>();
    const out: SessionListIndexItem[] = [];
    let didChange = false;
    for (const item of source) {
        if (item.type !== 'session') {
            out.push(item);
            continue;
        }
        const groupKey = normalizeTrimmedString(item.groupKey);
        const replacementList = groupKey ? sortedByGroupKey.get(groupKey) : undefined;
        if (!replacementList) {
            out.push(item);
            continue;
        }
        const index = indicesByGroupKey.get(groupKey) ?? 0;
        const replacement = replacementList[index] ?? item;
        if (replacement !== item) {
            didChange = true;
        }
        out.push(replacement);
        indicesByGroupKey.set(groupKey, index + 1);
    }

    return didChange ? out : (source as SessionListIndexItem[]);
}

function reorderSessionItemsByKeys(
    items: ReadonlyArray<Extract<SessionListIndexItem, { type: 'session' }>>,
    keys: ReadonlyArray<string> | undefined,
): Array<Extract<SessionListIndexItem, { type: 'session' }>> {
    if (!keys || keys.length === 0 || items.length < 2) {
        return [...items];
    }

    const byKey = new Map<string, Extract<SessionListIndexItem, { type: 'session' }>>();
    for (const item of items) {
        const k = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        if (k) {
            byKey.set(k, item);
        }
    }

    const out: Array<Extract<SessionListIndexItem, { type: 'session' }>> = [];
    const used = new Set<Extract<SessionListIndexItem, { type: 'session' }>>();

    for (const key of keys) {
        const normalized = typeof key === 'string' ? key.trim() : '';
        if (!normalized) continue;
        const found = byKey.get(normalized);
        if (found && !used.has(found)) {
            out.push(found);
            used.add(found);
        }
    }

    for (const item of items) {
        if (used.has(item)) continue;
        out.push(item);
    }

    return out;
}

function applyGroupOrdering(
    source: ReadonlyArray<SessionListIndexItem>,
    orderByGroupKey: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
): SessionListIndexItem[] {
    const sessionsByGroup = new Map<string, Array<Extract<SessionListIndexItem, { type: 'session' }>>>();

    for (const item of source) {
        if (item.type !== 'session') continue;
        const groupKey = typeof item.groupKey === 'string' ? item.groupKey : '';
        if (!groupKey) continue;
        if (!sessionsByGroup.has(groupKey)) sessionsByGroup.set(groupKey, []);
        sessionsByGroup.get(groupKey)!.push(item);
    }

    const reorderedByGroup = new Map<string, Array<Extract<SessionListIndexItem, { type: 'session' }>>>();
    for (const [groupKey, items] of sessionsByGroup.entries()) {
        const keys = orderByGroupKey[groupKey];
        if (!keys || keys.length === 0) continue;
        reorderedByGroup.set(groupKey, reorderSessionItemsByKeys(items, keys));
    }

    if (reorderedByGroup.size === 0) {
        return source as SessionListIndexItem[];
    }

    const indicesByGroup = new Map<string, number>();
    const out: SessionListIndexItem[] = [];
    let didChange = false;
    for (const item of source) {
        if (item.type !== 'session') {
            out.push(item);
            continue;
        }
        const groupKey = typeof item.groupKey === 'string' ? item.groupKey : '';
        const replacementList = reorderedByGroup.get(groupKey);
        if (!replacementList) {
            out.push(item);
            continue;
        }
        const index = indicesByGroup.get(groupKey) ?? 0;
        const replacement = replacementList[index] ?? item;
        if (replacement !== item) {
            didChange = true;
        }
        out.push(replacement);
        indicesByGroup.set(groupKey, index + 1);
    }

    return didChange ? out : (source as SessionListIndexItem[]);
}

type VisibleSessionListHeaderState = {
    pendingSectionHeader: Extract<SessionListIndexItem, { type: 'header' }> | null;
    pendingGroupHeader: Extract<SessionListIndexItem, { type: 'header' }> | null;
};

function createVisibleSessionListHeaderState(): VisibleSessionListHeaderState {
    return {
        pendingSectionHeader: null,
        pendingGroupHeader: null,
    };
}

function pruneOrphanHeaders(items: ReadonlyArray<SessionListIndexItem>): SessionListIndexItem[] {
    const out: SessionListIndexItem[] = [];
    const headerState = createVisibleSessionListHeaderState();

    for (const item of items) {
        if (item.type === 'header') {
            if (item.headerKind === 'active' || item.headerKind === 'inactive') {
                headerState.pendingSectionHeader = item;
                headerState.pendingGroupHeader = null;
            } else {
                headerState.pendingGroupHeader = item;
            }
            continue;
        }
        if (item.type === 'session') {
            if (headerState.pendingSectionHeader) {
                out.push(headerState.pendingSectionHeader);
                headerState.pendingSectionHeader = null;
            }
            if (headerState.pendingGroupHeader) {
                out.push(headerState.pendingGroupHeader);
                headerState.pendingGroupHeader = null;
            }
            out.push(item);
            continue;
        }
    }

    return out;
}

function filterHideInactiveSessions(
    items: ReadonlyArray<SessionListIndexItem>,
    resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'],
): SessionListIndexItem[] {
    const out: SessionListIndexItem[] = [];
    const headerState = createVisibleSessionListHeaderState();

    for (const item of items) {
        if (item.type === 'header') {
            if (item.headerKind === 'active' || item.headerKind === 'inactive') {
                headerState.pendingSectionHeader = item;
                headerState.pendingGroupHeader = null;
            } else {
                headerState.pendingGroupHeader = item;
            }
            continue;
        }
        if (item.type === 'session') {
            const row = resolveSessionRowForItem(item, resolveSessionRow);
            const isActive = item.section === 'active' || row?.active === true;
            if (!isActive && row?.keepVisibleWhenInactive !== true) {
                continue;
            }
            if (headerState.pendingSectionHeader) {
                if (headerState.pendingSectionHeader.headerKind === 'active') {
                    out.push(headerState.pendingSectionHeader);
                }
                headerState.pendingSectionHeader = null;
            }
            if (headerState.pendingGroupHeader) {
                out.push(headerState.pendingGroupHeader);
                headerState.pendingGroupHeader = null;
            }
            out.push(item);
        }
    }

    return out;
}

function computeVisibleSessionListIndexUnmeasured(
    params: ComputeVisibleSessionListIndexParams,
): SessionListIndexItem[] | null {
    const source = params.source;
    if (!source) return null;

    const sessionListOrderingModeV1 = params.sessionListOrderingModeV1 ?? 'custom';
    const pinnedSessionKeys = normalizeTrimmedStringArrayWithSharedEmpty(params.pinnedSessionKeysV1);
    const presentationEnabled = params.presentation.enabled === true;
    const noOrderingOverrides = !Object.values(params.sessionListGroupOrderV1 ?? {}).some(
        (keys) => Array.isArray(keys) && keys.length > 0,
    );
    const sourceState = inspectVisibleSessionListSourceState(source, params.resolveSessionRow);

    if (
        sessionListOrderingModeV1 === 'custom'
        && !params.hideInactiveSessions
        && pinnedSessionKeys.length === 0
        && !presentationEnabled
        && noOrderingOverrides
        && !sourceState.hasArchivedSessionItems
        && !sourceState.hasOrphanHeaders
    ) {
        return source as SessionListIndexItem[];
    }

    const orderedByGroup =
        sessionListOrderingModeV1 === 'custom'
            ? applyGroupOrdering(source, params.sessionListGroupOrderV1 ?? {})
            : source;
    if (
        sessionListOrderingModeV1 === 'custom'
        && orderedByGroup === source
        && !params.hideInactiveSessions
        && pinnedSessionKeys.length === 0
        && !presentationEnabled
        && !sourceState.hasArchivedSessionItems
        && !sourceState.hasOrphanHeaders
    ) {
        return source as SessionListIndexItem[];
    }

    const ordered =
        sessionListOrderingModeV1 === 'custom'
            ? orderedByGroup
            : sortSessionListIndexItemsByOrderingMode(source, sessionListOrderingModeV1, params.resolveSessionRow);
    if (
        sessionListOrderingModeV1 !== 'custom'
        && ordered === source
        && !params.hideInactiveSessions
        && pinnedSessionKeys.length === 0
        && !presentationEnabled
        && !sourceState.hasArchivedSessionItems
        && !sourceState.hasOrphanHeaders
    ) {
        return source as SessionListIndexItem[];
    }

    if (
        sessionListOrderingModeV1 === 'custom'
        && params.hideInactiveSessions
        && pinnedSessionKeys.length === 0
        && !presentationEnabled
        && noOrderingOverrides
        && !sourceState.hasArchivedSessionItems
        && !sourceState.hasOrphanHeaders
        && !sourceState.hasInactiveSessionsThatNeedFiltering
    ) {
        return source as SessionListIndexItem[];
    }

    const orderedWithoutArchived = ordered.filter((item) => {
        if (!item || item.type !== 'session') return true;
        const row = resolveSessionRowForItem(item, params.resolveSessionRow);
        return row?.archivedAt == null;
    });

    const pinnedSet = new Set(pinnedSessionKeys);
    const pinnedSessions: Array<Extract<SessionListIndexItem, { type: 'session' }>> = [];
    const remainder: SessionListIndexItem[] = [];

    for (const item of orderedWithoutArchived) {
        if (item.type !== 'session') {
            remainder.push(item);
            continue;
        }
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        if (key && pinnedSet.has(key)) {
            pinnedSessions.push({
                ...item,
                pinned: true,
                groupKey: PINNED_GROUP_KEY_V1,
                groupKind: 'pinned',
                variant: 'default',
            });
            continue;
        }
        remainder.push(item);
    }

    const pinnedHeader: Extract<SessionListIndexItem, { type: 'header' }> | null =
        pinnedSessions.length > 0
            ? { type: 'header', title: 'Pinned', headerKind: 'pinned', groupKey: PINNED_GROUP_KEY_V1 }
            : null;

    const pinnedOrdered =
        sessionListOrderingModeV1 === 'custom'
            ? reorderSessionItemsByKeys(
                pinnedSessions,
                params.sessionListGroupOrderV1?.[PINNED_GROUP_KEY_V1],
            )
            : sortSessionListIndexItemsByOrderingMode(pinnedSessions, sessionListOrderingModeV1, params.resolveSessionRow);

    const remainderPruned = pruneOrphanHeaders(remainder);
    const remainderFiltered = params.hideInactiveSessions
        ? filterHideInactiveSessions(remainderPruned, params.resolveSessionRow)
        : remainderPruned;

    const remainderPresented = applySessionListIndexPresentation(remainderFiltered, {
        enabled: params.presentation.enabled,
        presentation: params.presentation.presentation,
        selectedServerIds: params.presentation.selectedServerIds,
    });

    return [
        ...(pinnedHeader ? [pinnedHeader, ...pinnedOrdered] : []),
        ...remainderPresented,
    ];
}

export function computeVisibleSessionListIndex(
    params: ComputeVisibleSessionListIndexParams,
): SessionListIndexItem[] | null {
    const source = params.source;
    if (!source) return null;
    if (!syncPerformanceTelemetry.isEnabled()) {
        return computeVisibleSessionListIndexUnmeasured(params);
    }

    const startedAtMs = nowMs();
    const result = computeVisibleSessionListIndexUnmeasured(params);
    const sessionCount = countSessionItems(source);
    syncPerformanceTelemetry.recordDuration(
        'sync.sessions.list.visible.compute',
        nowMs() - startedAtMs,
        {
            items: source.length,
            sessions: sessionCount,
            headers: source.length - sessionCount,
            fastPath: result === source ? 1 : 0,
            hideInactive: params.hideInactiveSessions === true ? 1 : 0,
            pins: countPinnedSessionKeys(params.pinnedSessionKeysV1),
            customOrder: countOrderedGroups(params.sessionListGroupOrderV1),
            presentationEnabled: params.presentation.enabled === true ? 1 : 0,
            storageFilter: params.storageFilterApplied === true ? 1 : 0,
        },
    );
    return result;
}
