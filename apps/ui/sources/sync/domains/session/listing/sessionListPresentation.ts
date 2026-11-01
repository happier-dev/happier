import type { ServerSelectionPresentation } from '@/sync/domains/server/selection/serverSelectionTypes';
import type { SessionListViewItem } from './sessionListViewData';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

/** Prefer current identity data, falling back to a snapshot produced before identity discovery. */
export function resolveSessionListCacheServerId(
    dataByServerId: Readonly<Record<string, SessionListViewItem[] | null | undefined>>,
    requestedServerId: string,
): string | null {
    const canonicalServerId = resolveServerProfileScopeIdForIdentifier(requestedServerId);
    if (Object.prototype.hasOwnProperty.call(dataByServerId, canonicalServerId)) return canonicalServerId;
    if (Object.prototype.hasOwnProperty.call(dataByServerId, requestedServerId)) return requestedServerId;
    for (const cachedServerId of Object.keys(dataByServerId)) {
        if (areServerProfileIdentifiersEquivalent(cachedServerId, canonicalServerId)) return cachedServerId;
    }
    return null;
}

// Immutable snapshots may outlive Home identity discovery. Preserve each unchanged row's
// projected identity when another Home publishes or archive progress recomputes the list.
const scopedSessionListItems = new WeakMap<SessionListViewItem, Map<string, SessionListViewItem>>();

export function bindSessionListItemToServerScope(item: SessionListViewItem, serverId: string): SessionListViewItem {
    if ((!item.serverId || item.serverId === serverId)
        && (item.type !== 'header' || !item.workspaceScopeHint || item.workspaceScopeHint.serverId === serverId)) {
        return item;
    }
    let byServer = scopedSessionListItems.get(item);
    if (!byServer) {
        byServer = new Map();
        scopedSessionListItems.set(item, byServer);
    }
    const existing = byServer.get(serverId);
    if (existing) return existing;
    const scoped = item.type === 'header' && item.workspaceScopeHint
        ? { ...item, serverId, workspaceScopeHint: { ...item.workspaceScopeHint, serverId } }
        : { ...item, serverId };
    byServer.set(serverId, scoped);
    return scoped;
}

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
    let hasResolvedSelectedSource = false;

    for (const serverId of selectedServerIds) {
        const cacheServerId = resolveSessionListCacheServerId(scoped, serverId);
        const fromCache = cacheServerId ? scoped[cacheServerId] : null;
        const source = fromCache ?? (serverId === activeServerId ? params.activeData : null);
        if (!source) continue;
        hasResolvedSelectedSource = true;
        if (source.length === 0) continue;
        // Cached rows can predate identity discovery; presentation consumes current selected scopes.
        for (const item of source) {
            merged.push(bindSessionListItemToServerScope(item, serverId));
        }
    }

    if (merged.length > 0) {
        return merged;
    }

    return hasResolvedSelectedSource ? [] : null;
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
