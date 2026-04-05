import type { ServerSelectionPresentation } from '@/sync/domains/server/selection/serverSelectionTypes';
import type { SessionListViewItem } from './sessionListViewData';
import { getSessionStorageKind, type SessionListStorageFilter } from '../sessionStorageKind';

type ApplySessionListPresentationParams = Readonly<{
    enabled: boolean;
    presentation: ServerSelectionPresentation;
    selectedServerIds?: ReadonlyArray<string>;
}>;

type ResolveSessionListSourceDataParams = Readonly<{
    enabled: boolean;
    activeServerId: string;
    activeData: ReadonlyArray<SessionListViewItem> | null;
    byServerId?: Readonly<Record<string, ReadonlyArray<SessionListViewItem> | null | undefined>>;
    selectedServerIds?: ReadonlyArray<string>;
}>;

type ResolveVisibleSessionListSummaryParams = ResolveSessionListSourceDataParams;

export type VisibleSessionListSummary = Readonly<{
    sessionsReady: boolean;
    sessionCount: number;
}>;

const EMPTY_VISIBLE_SESSION_LIST_SUMMARY: VisibleSessionListSummary = Object.freeze({
    sessionsReady: true,
    sessionCount: 0,
});

const LOADING_VISIBLE_SESSION_LIST_SUMMARY: VisibleSessionListSummary = Object.freeze({
    sessionsReady: false,
    sessionCount: 0,
});

function toServerLabel(item: SessionListViewItem): string {
    const name = String(item.serverName ?? '').trim();
    if (name) return name;
    const id = String(item.serverId ?? '').trim();
    if (id) return id;
    return 'Unknown server';
}

function stripSyntheticServerHeaders(data: ReadonlyArray<SessionListViewItem>): SessionListViewItem[] {
    return data.filter((item) => !(item.type === 'header' && item.headerKind === 'server'));
}

function hasSyntheticServerHeaders(data: ReadonlyArray<SessionListViewItem>): boolean {
    return data.some((item) => item.type === 'header' && item.headerKind === 'server');
}

function isAlreadyCanonicalGroupedServerPresentation(
    data: ReadonlyArray<SessionListViewItem>,
): boolean {
    if (!hasSyntheticServerHeaders(data)) return false;

    let currentServerId: string | null = null;
    let seenSessionInCurrentGroup = false;
    let sawServerGroup = false;

    for (const item of data) {
        if (item.type === 'header') {
            if (item.headerKind !== 'server') return false;
            if (sawServerGroup && !seenSessionInCurrentGroup) return false;

            currentServerId = String(item.serverId ?? '').trim();
            if (!currentServerId) return false;

            sawServerGroup = true;
            seenSessionInCurrentGroup = false;
            continue;
        }

        if (item.type !== 'session') return false;
        if (!currentServerId) return false;

        const serverId = String(item.serverId ?? '').trim();
        if (!serverId || serverId !== currentServerId) return false;

        seenSessionInCurrentGroup = true;
    }

    return sawServerGroup && seenSessionInCurrentGroup;
}

function selectionCoversAllVisibleServerIds(
    data: ReadonlyArray<SessionListViewItem>,
    selectedServerSet: ReadonlySet<string>,
): boolean {
    for (const item of data) {
        if (item.type === 'header') {
            if (item.headerKind === 'server') {
                return false;
            }
            continue;
        }

        const serverId = String(item.serverId ?? '').trim();
        if (!serverId) continue;
        if (!selectedServerSet.has(serverId)) {
            return false;
        }
    }

    return true;
}

function countDistinctServerIds(data: ReadonlyArray<SessionListViewItem>): number {
    const ids = new Set<string>();
    for (const item of data) {
        const serverId = String(item.serverId ?? '').trim();
        if (!serverId) continue;
        ids.add(serverId);
    }
    return ids.size;
}

function countSessionItems(data: ReadonlyArray<SessionListViewItem>): number {
    let count = 0;
    for (const item of data) {
        if (item.type === 'session') {
            count += 1;
        }
    }
    return count;
}

function countSessionItemsByStorageFilter(
    data: ReadonlyArray<SessionListViewItem>,
    storageFilter: SessionListStorageFilter,
): number {
    if (storageFilter === 'all') {
        return countSessionItems(data);
    }

    let count = 0;
    for (const item of data) {
        if (item.type !== 'session') continue;
        if (getSessionStorageKind(item.session) !== storageFilter) continue;
        count += 1;
    }
    return count;
}

export function resolveSessionListSourceData(
    params: ResolveSessionListSourceDataParams,
): ReadonlyArray<SessionListViewItem> | null {
    if (!params.enabled) {
        return params.activeData;
    }

    const selectedServerIds = Array.isArray(params.selectedServerIds)
        ? params.selectedServerIds.map((id) => String(id ?? '').trim()).filter(Boolean)
        : [];
    if (selectedServerIds.length === 0) {
        return params.activeData;
    }

    const activeServerId = String(params.activeServerId ?? '').trim();
    const scoped = params.byServerId ?? {};
    let usedOnlyActiveDataSource = true;
    if (selectedServerIds.length === 1 && selectedServerIds[0] === activeServerId) {
        const selectedSource = scoped[activeServerId] ?? params.activeData;
        if (selectedSource === params.activeData) {
            return params.activeData;
        }
    }

    const merged: SessionListViewItem[] = [];

    for (const serverId of selectedServerIds) {
        const fromCache = scoped[serverId];
        const source = fromCache ?? (serverId === activeServerId ? params.activeData : null);
        if (!source || source.length === 0) continue;
        if (source !== params.activeData) {
            usedOnlyActiveDataSource = false;
        }
        merged.push(...source);
    }

    if (merged.length > 0) {
        if (
            usedOnlyActiveDataSource
            && params.activeData
            && merged.length === params.activeData.length
        ) {
            let matchesActiveData = true;
            for (let index = 0; index < merged.length; index++) {
                if (merged[index] !== params.activeData[index]) {
                    matchesActiveData = false;
                    break;
                }
            }

            if (matchesActiveData) {
                return params.activeData;
            }
        }
        return merged;
    }

    return params.activeData;
}

export function resolveVisibleSessionListSummary(
    params: ResolveVisibleSessionListSummaryParams,
    storageFilter: SessionListStorageFilter = 'all',
): VisibleSessionListSummary {
    const countForSource = (source: ReadonlyArray<SessionListViewItem> | null): VisibleSessionListSummary => {
        if (source === null) {
            return LOADING_VISIBLE_SESSION_LIST_SUMMARY;
        }
        const sessionCount = countSessionItemsByStorageFilter(source, storageFilter);
        if (sessionCount === 0) {
            return EMPTY_VISIBLE_SESSION_LIST_SUMMARY;
        }
        return {
            sessionsReady: true,
            sessionCount,
        };
    };

    if (!params.enabled) {
        return countForSource(params.activeData);
    }

    const selectedServerIds = Array.isArray(params.selectedServerIds)
        ? params.selectedServerIds.map((id) => String(id ?? '').trim()).filter(Boolean)
        : [];
    if (selectedServerIds.length === 0) {
        return countForSource(params.activeData);
    }

    const activeServerId = String(params.activeServerId ?? '').trim();
    const scoped = params.byServerId ?? {};
    let sessionCount = 0;
    let hasResolvedSelectedSource = false;

    for (const serverId of selectedServerIds) {
        const fromCache = scoped[serverId];
        const source = fromCache ?? (serverId === activeServerId ? params.activeData : null);
        if (!source || source.length === 0) continue;
        hasResolvedSelectedSource = true;
        sessionCount += countSessionItemsByStorageFilter(source, storageFilter);
    }

    if (hasResolvedSelectedSource) {
        if (sessionCount === 0) {
            return EMPTY_VISIBLE_SESSION_LIST_SUMMARY;
        }
        return { sessionsReady: true, sessionCount };
    }

    return countForSource(params.activeData);
}

export function applySessionListPresentation(
    data: ReadonlyArray<SessionListViewItem>,
    params: ApplySessionListPresentationParams,
): ReadonlyArray<SessionListViewItem> {
    if (!params.enabled) {
        return data;
    }

    const selectedServerIds = Array.isArray(params.selectedServerIds)
        ? params.selectedServerIds.map((id) => String(id ?? '').trim()).filter(Boolean)
        : [];
    const selectedServerSet = new Set(selectedServerIds);

    if (selectedServerSet.size === 0 && !hasSyntheticServerHeaders(data)) {
        if (params.presentation === 'flat-with-badge') {
            return data;
        }
        if (countDistinctServerIds(data) <= 1) {
            return data;
        }
    }

    if (
        params.presentation === 'flat-with-badge'
        && selectedServerSet.size > 0
        && !hasSyntheticServerHeaders(data)
        && selectionCoversAllVisibleServerIds(data, selectedServerSet)
    ) {
        return data;
    }

    const withoutServerHeaders = hasSyntheticServerHeaders(data)
        ? stripSyntheticServerHeaders(data)
        : data;
    const filteredBySelection = selectedServerSet.size > 0
        ? (() => {
            const filtered: SessionListViewItem[] = [];
            const pendingUnscoped: SessionListViewItem[] = [];
            for (const item of withoutServerHeaders) {
                const serverId = String(item.serverId ?? '').trim();
                if (!serverId) {
                    pendingUnscoped.push(item);
                    continue;
                }
                if (!selectedServerSet.has(serverId)) {
                    pendingUnscoped.length = 0;
                    continue;
                }
                if (pendingUnscoped.length > 0) {
                    filtered.push(...pendingUnscoped);
                    pendingUnscoped.length = 0;
                }
                filtered.push(item);
            }
            return filtered;
        })()
        : withoutServerHeaders;

    if (params.presentation === 'flat-with-badge') {
        return filteredBySelection;
    }

    if (selectedServerSet.size === 0 && isAlreadyCanonicalGroupedServerPresentation(data)) {
        return data;
    }

    if (countDistinctServerIds(filteredBySelection) <= 1) {
        return filteredBySelection;
    }

    const serverOrder: string[] = [];
    const groups = new Map<string, SessionListViewItem[]>();
    const unknownServerKey = '__unknown_server__';
    const pendingUnscopedItems: SessionListViewItem[] = [];

    for (const item of filteredBySelection) {
        const scopedId = String(item.serverId ?? '').trim();
        if (!scopedId) {
            pendingUnscopedItems.push(item);
            continue;
        }
        const id = scopedId;
        if (!groups.has(id)) {
            groups.set(id, []);
            serverOrder.push(id);
        }
        if (pendingUnscopedItems.length > 0) {
            groups.get(id)!.push(...pendingUnscopedItems);
            pendingUnscopedItems.length = 0;
        }
        groups.get(id)!.push(item);
    }

    if (pendingUnscopedItems.length > 0) {
        if (!groups.has(unknownServerKey)) {
            groups.set(unknownServerKey, []);
            serverOrder.push(unknownServerKey);
        }
        groups.get(unknownServerKey)!.push(...pendingUnscopedItems);
    }

    const grouped: SessionListViewItem[] = [];
    for (const serverId of serverOrder) {
        const items = groups.get(serverId);
        if (!items || items.length === 0) continue;
        const scopedItem = items.find((item) => String(item.serverId ?? '').trim()) ?? items[0];
        grouped.push({
            type: 'header',
            title: toServerLabel(scopedItem),
            headerKind: 'server',
            serverId: serverId === unknownServerKey ? undefined : scopedItem.serverId,
            serverName: scopedItem.serverName,
        });
        grouped.push(...items);
    }

    return grouped;
}
