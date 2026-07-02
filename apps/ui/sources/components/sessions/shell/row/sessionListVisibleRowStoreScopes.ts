import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { sessionTagKey } from '../sessionTagUtils';

export type SessionListRowStoreSubscriptionScope = Readonly<{
    sessionId: string;
    serverId?: string | null;
}>;

export type SessionListRowStorePriorityOptions = Readonly<{
    selectedSessionId?: string | null;
}>;

export function resolveSessionListRowStoreScopeKey(scope: SessionListRowStoreSubscriptionScope): string {
    const sessionId = String(scope.sessionId ?? '').trim();
    const serverId = typeof scope.serverId === 'string' ? scope.serverId.trim() : '';
    return serverId && sessionId ? sessionTagKey(serverId, sessionId) : sessionId;
}

export function isSessionListRowStorePriorityItem(
    item: SessionListIndexItem,
    options: SessionListRowStorePriorityOptions = {},
): item is Extract<SessionListIndexItem, { type: 'session' }> {
    if (item.type !== 'session') return false;
    return item.workingPlacementReason === 'working'
        || item.groupKind === 'working'
        || item.attentionPlacementReason != null
        || item.groupKind === 'attention'
        || (typeof options.selectedSessionId === 'string' && options.selectedSessionId.trim() === item.sessionId);
}

export function buildSessionListRowStorePriorityKeys(
    items: ReadonlyArray<SessionListIndexItem> | null | undefined,
    options: SessionListRowStorePriorityOptions = {},
): ReadonlySet<string> {
    if (!items || items.length === 0) return new Set();
    const keys = new Set<string>();
    for (const item of items) {
        if (!isSessionListRowStorePriorityItem(item, options)) continue;
        keys.add(resolveSessionListRowStoreScopeKey({
            sessionId: item.sessionId,
            serverId: item.serverId ?? null,
        }));
    }
    return keys;
}

export function resolveSessionListRowStoreSubscriptionKeys(
    visibleRowKeys: ReadonlySet<string> | null,
    priorityRowKeys: ReadonlySet<string> | null = null,
): ReadonlySet<string> | null {
    if (visibleRowKeys === null) return null;
    if (!priorityRowKeys || priorityRowKeys.size === 0) return visibleRowKeys;
    if (visibleRowKeys.size === 0) return priorityRowKeys;
    const next = new Set(visibleRowKeys);
    for (const key of priorityRowKeys) {
        next.add(key);
    }
    return next;
}

export function resolveSessionListRowStoreSubscriptionScopes(
    scopes: ReadonlyArray<SessionListRowStoreSubscriptionScope>,
    visibleRowKeys: ReadonlySet<string> | null,
    priorityRowKeys: ReadonlySet<string> | null = null,
): ReadonlyArray<SessionListRowStoreSubscriptionScope> {
    if (visibleRowKeys === null) return scopes;
    if (scopes.length === 0) return [];
    const subscriptionKeys = resolveSessionListRowStoreSubscriptionKeys(visibleRowKeys, priorityRowKeys);
    if (subscriptionKeys === null) return scopes;
    if (subscriptionKeys.size === 0) return [];
    return scopes.filter((scope) => subscriptionKeys.has(resolveSessionListRowStoreScopeKey(scope)));
}

export function resolveSessionListRowStoreSubscriptionItems(
    items: ReadonlyArray<SessionListIndexItem>,
    visibleRowKeys: ReadonlySet<string> | null,
    priorityRowKeys: ReadonlySet<string> | null = null,
): ReadonlyArray<SessionListIndexItem> {
    if (visibleRowKeys === null) return items;
    if (items.length === 0) return [];
    const subscriptionKeys = resolveSessionListRowStoreSubscriptionKeys(visibleRowKeys, priorityRowKeys);
    if (subscriptionKeys === null) return items;
    if (subscriptionKeys.size === 0) return [];
    return items.filter((item) => {
        if (item.type !== 'session') return false;
        const key = resolveSessionListRowStoreScopeKey({
            sessionId: item.sessionId,
            serverId: item.serverId ?? null,
        });
        return subscriptionKeys.has(key);
    });
}
