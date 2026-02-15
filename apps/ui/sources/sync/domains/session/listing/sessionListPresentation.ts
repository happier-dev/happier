import type { ServerSelectionPresentation } from '@/sync/domains/server/selection/serverSelectionTypes';
import type { SessionListViewItem } from './sessionListViewData';

type ApplySessionListPresentationParams = Readonly<{
    enabled: boolean;
    presentation: ServerSelectionPresentation;
    selectedServerIds?: ReadonlyArray<string>;
}>;

type ResolveSessionListSourceDataParams = Readonly<{
    enabled: boolean;
    activeServerId: string;
    activeData: SessionListViewItem[] | null;
    byServerId?: Readonly<Record<string, SessionListViewItem[] | null | undefined>>;
    selectedServerIds?: ReadonlyArray<string>;
}>;

function toServerLabel(item: SessionListViewItem): string {
    const name = String(item.serverName ?? '').trim();
    if (name) return name;
    const id = String(item.serverId ?? '').trim();
    if (id) return id;
    return 'Unknown server';
}

function stripSyntheticServerHeaders(data: SessionListViewItem[]): SessionListViewItem[] {
    return data.filter((item) => !(item.type === 'header' && item.headerKind === 'server'));
}

function countDistinctServerIds(data: SessionListViewItem[]): number {
    const ids = new Set<string>();
    for (const item of data) {
        const serverId = String(item.serverId ?? '').trim();
        if (!serverId) continue;
        ids.add(serverId);
    }
    return ids.size;
}

export function resolveSessionListSourceData(
    params: ResolveSessionListSourceDataParams,
): SessionListViewItem[] | null {
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
    const merged: SessionListViewItem[] = [];

    for (const serverId of selectedServerIds) {
        const fromCache = scoped[serverId];
        const source = fromCache ?? (serverId === activeServerId ? params.activeData : null);
        if (!source || source.length === 0) continue;
        merged.push(...source);
    }

    if (merged.length > 0) {
        return merged;
    }

    return params.activeData;
}

export function applySessionListPresentation(
    data: SessionListViewItem[],
    params: ApplySessionListPresentationParams,
): SessionListViewItem[] {
    if (!params.enabled) {
        return data;
    }

    const withoutServerHeaders = stripSyntheticServerHeaders(data);
    const selectedServerIds = Array.isArray(params.selectedServerIds)
        ? params.selectedServerIds.map((id) => String(id ?? '').trim()).filter(Boolean)
        : [];
    const selectedServerSet = new Set(selectedServerIds);
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
