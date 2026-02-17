import type { ServerSelectionPresentation } from '@/sync/domains/server/selection/serverSelectionTypes';

import { applySessionListPresentation } from './sessionListPresentation';
import type { SessionListViewItem } from './sessionListViewData';

export type ComputeVisibleSessionListViewDataParams = Readonly<{
    source: SessionListViewItem[] | null;
    hideInactiveSessions: boolean;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    presentation: Readonly<{
        enabled: boolean;
        presentation: ServerSelectionPresentation;
        selectedServerIds?: ReadonlyArray<string>;
    }>;
}>;

const PINNED_GROUP_KEY_V1 = 'pinned-v1';

function normalizeSessionKey(serverIdRaw: unknown, sessionIdRaw: unknown): string | null {
    const serverId = typeof serverIdRaw === 'string' ? serverIdRaw.trim() : '';
    const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
    if (!serverId || !sessionId) return null;
    return `${serverId}:${sessionId}`;
}

function reorderSessionItemsByKeys(
    items: ReadonlyArray<Extract<SessionListViewItem, { type: 'session' }>>,
    keys: ReadonlyArray<string> | undefined
): Array<Extract<SessionListViewItem, { type: 'session' }>> {
    if (!keys || keys.length === 0 || items.length < 2) {
        return [...items];
    }

    const byKey = new Map<string, Extract<SessionListViewItem, { type: 'session' }>>();
    const remaining: Array<Extract<SessionListViewItem, { type: 'session' }>> = [];

    for (const item of items) {
        const k = normalizeSessionKey(item.serverId, item.session?.id);
        if (k) {
            byKey.set(k, item);
        }
        remaining.push(item);
    }

    const out: Array<Extract<SessionListViewItem, { type: 'session' }>> = [];
    const used = new Set<Extract<SessionListViewItem, { type: 'session' }>>();

    for (const key of keys) {
        const normalized = typeof key === 'string' ? key.trim() : '';
        if (!normalized) continue;
        const found = byKey.get(normalized);
        if (found && !used.has(found)) {
            out.push(found);
            used.add(found);
        }
    }

    for (const item of remaining) {
        if (used.has(item)) continue;
        out.push(item);
    }

    return out;
}

function applyGroupOrdering(
    source: ReadonlyArray<SessionListViewItem>,
    orderByGroupKey: Readonly<Record<string, ReadonlyArray<string> | undefined>>
): SessionListViewItem[] {
    const sessionsByGroup = new Map<string, Array<Extract<SessionListViewItem, { type: 'session' }>>>();

    for (const item of source) {
        if (item.type !== 'session') continue;
        const groupKey = typeof item.groupKey === 'string' ? item.groupKey : '';
        if (!groupKey) continue;
        if (!sessionsByGroup.has(groupKey)) sessionsByGroup.set(groupKey, []);
        sessionsByGroup.get(groupKey)!.push(item);
    }

    const reorderedByGroup = new Map<string, Array<Extract<SessionListViewItem, { type: 'session' }>>>();
    for (const [groupKey, items] of sessionsByGroup.entries()) {
        const keys = orderByGroupKey[groupKey];
        if (!keys || keys.length === 0) continue;
        reorderedByGroup.set(groupKey, reorderSessionItemsByKeys(items, keys));
    }

    if (reorderedByGroup.size === 0) {
        return [...source];
    }

    const indicesByGroup = new Map<string, number>();
    const out: SessionListViewItem[] = [];
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
        out.push(replacementList[index] ?? item);
        indicesByGroup.set(groupKey, index + 1);
    }
    return out;
}

function pruneOrphanHeaders(items: ReadonlyArray<SessionListViewItem>): SessionListViewItem[] {
    const out: SessionListViewItem[] = [];
    let pendingSectionHeader: Extract<SessionListViewItem, { type: 'header' }> | null = null;
    let pendingGroupHeader: Extract<SessionListViewItem, { type: 'header' }> | null = null;

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
        if (item.type === 'session') {
            if (pendingSectionHeader) {
                out.push(pendingSectionHeader);
                pendingSectionHeader = null;
            }
            if (pendingGroupHeader) {
                out.push(pendingGroupHeader);
                pendingGroupHeader = null;
            }
            out.push(item);
            continue;
        }
    }

    return out;
}

function filterHideInactiveSessions(items: ReadonlyArray<SessionListViewItem>): SessionListViewItem[] {
    const out: SessionListViewItem[] = [];
    let pendingSectionHeader: Extract<SessionListViewItem, { type: 'header' }> | null = null;
    let pendingGroupHeader: Extract<SessionListViewItem, { type: 'header' }> | null = null;

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
        if (item.type === 'session') {
            const isActive = item.section === 'active' || item.session.active === true;
            if (!isActive) {
                continue;
            }
            if (pendingSectionHeader) {
                if (pendingSectionHeader.headerKind === 'active') {
                    out.push(pendingSectionHeader);
                }
                pendingSectionHeader = null;
            }
            if (pendingGroupHeader) {
                out.push(pendingGroupHeader);
                pendingGroupHeader = null;
            }
            out.push(item);
        }
    }

    return out;
}

export function computeVisibleSessionListViewData(
    params: ComputeVisibleSessionListViewDataParams
): SessionListViewItem[] | null {
    const source = params.source;
    if (!source) return null;

    const ordered = applyGroupOrdering(source, params.sessionListGroupOrderV1 ?? {});
    const orderedWithoutArchived = ordered.filter((item) => {
        if (!item || item.type !== 'session') return true;
        return item.session?.archivedAt == null;
    });

    const pinnedSet = new Set(
        (params.pinnedSessionKeysV1 ?? [])
            .map((k) => (typeof k === 'string' ? k.trim() : ''))
            .filter(Boolean),
    );

    const pinnedSessions: Array<Extract<SessionListViewItem, { type: 'session' }>> = [];
    const remainder: SessionListViewItem[] = [];

    for (const item of orderedWithoutArchived) {
        if (item.type !== 'session') {
            remainder.push(item);
            continue;
        }
        const key = normalizeSessionKey(item.serverId, item.session?.id);
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

    const pinnedHeader: Extract<SessionListViewItem, { type: 'header' }> | null =
        pinnedSessions.length > 0
            ? { type: 'header', title: 'Pinned', headerKind: 'pinned', groupKey: PINNED_GROUP_KEY_V1 }
            : null;

    const pinnedOrdered = reorderSessionItemsByKeys(
        pinnedSessions,
        params.sessionListGroupOrderV1?.[PINNED_GROUP_KEY_V1],
    );

    const remainderPruned = pruneOrphanHeaders(remainder);
    const remainderFiltered = params.hideInactiveSessions
        ? filterHideInactiveSessions(remainderPruned)
        : remainderPruned;

    const remainderPresented = applySessionListPresentation(remainderFiltered, {
        enabled: params.presentation.enabled,
        presentation: params.presentation.presentation,
        selectedServerIds: params.presentation.selectedServerIds,
    });

    return [
        ...(pinnedHeader ? [pinnedHeader, ...pinnedOrdered] : []),
        ...remainderPresented,
    ];
}
