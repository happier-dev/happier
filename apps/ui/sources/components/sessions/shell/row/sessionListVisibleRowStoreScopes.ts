import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListRowScopeKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { isSessionListWorkingPlacementReason } from '@/sync/domains/session/listing/sessionListAttentionPlacementTypes';
export {
    buildSessionListRuntimePriorityRowKeys,
    isSessionListRuntimePriorityRow,
    type SessionListRuntimePriorityRow,
    type SessionListRuntimePriorityRowStateByServerId,
} from '@/sync/domains/session/listing/sessionListRuntimePriorityRows';

export type SessionListRowStoreSubscriptionScope = Readonly<{
    sessionId: string;
    serverId?: string | null;
}>;

export type SessionListRowStorePriorityOptions = Readonly<{
    selectedSessionId?: string | null;
}>;

const UNKNOWN_VIEWABILITY_EAGER_SUBSCRIPTION_MAX_ROWS = 50;

export function resolveSessionListRowStoreScopeKey(scope: SessionListRowStoreSubscriptionScope): string {
    return buildSessionListRowScopeKey(scope.serverId, scope.sessionId) ?? '';
}

export function reuseSessionListRowStoreSubscriptionScopes<T extends ReadonlyArray<SessionListRowStoreSubscriptionScope>>(
    previous: T | null | undefined,
    next: T,
): T {
    if (!previous || previous.length !== next.length) return next;
    for (let index = 0; index < next.length; index += 1) {
        const previousScope = previous[index];
        const nextScope = next[index];
        if (!previousScope || !nextScope) return next;
        if (resolveSessionListRowStoreScopeKey(previousScope) !== resolveSessionListRowStoreScopeKey(nextScope)) {
            return next;
        }
    }
    return previous;
}

export function reuseSessionListRowStoreKeySet<T extends ReadonlySet<string>>(
    previous: T | null | undefined,
    next: T,
): T {
    if (!previous || previous.size !== next.size) return next;
    for (const key of next) {
        if (!previous.has(key)) return next;
    }
    return previous;
}

export function isSessionListRowStorePriorityItem(
    item: SessionListIndexItem,
    options: SessionListRowStorePriorityOptions = {},
): item is Extract<SessionListIndexItem, { type: 'session' }> {
    if (item.type !== 'session') return false;
    return isSessionListWorkingPlacementReason(item.workingPlacementReason)
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

    let hasMissingPriorityKey = false;
    for (const key of priorityRowKeys) {
        if (!visibleRowKeys.has(key)) {
            hasMissingPriorityKey = true;
            break;
        }
    }
    if (!hasMissingPriorityKey) return visibleRowKeys;

    const next = new Set(visibleRowKeys);
    for (const key of priorityRowKeys) {
        next.add(key);
    }
    return next;
}

export function resolveSessionListRowStoreSubscriptionKeysForViewport(params: Readonly<{
    nativeAllRenderedMaxRows?: number;
    platformOS: string;
    priorityRowKeys?: ReadonlySet<string> | null;
    renderedSessionRows: number;
    visibleRowKeys: ReadonlySet<string> | null;
}>): ReadonlySet<string> | null {
    const nativeAllRenderedMaxRows = params.nativeAllRenderedMaxRows;
    if (
        params.platformOS !== 'web'
        && typeof nativeAllRenderedMaxRows === 'number'
        && Number.isFinite(nativeAllRenderedMaxRows)
        && params.renderedSessionRows <= Math.max(0, nativeAllRenderedMaxRows)
    ) {
        return null;
    }

    return resolveSessionListRowStoreSubscriptionKeys(
        params.visibleRowKeys,
        params.priorityRowKeys ?? null,
    );
}

export function resolveSessionListRowStoreSubscriptionScopes(
    scopes: ReadonlyArray<SessionListRowStoreSubscriptionScope>,
    visibleRowKeys: ReadonlySet<string> | null,
    priorityRowKeys: ReadonlySet<string> | null = null,
): ReadonlyArray<SessionListRowStoreSubscriptionScope> {
    if (scopes.length === 0) return [];
    if (visibleRowKeys === null) {
        if (scopes.length <= UNKNOWN_VIEWABILITY_EAGER_SUBSCRIPTION_MAX_ROWS) return scopes;
        if (!priorityRowKeys || priorityRowKeys.size === 0) return [];
        return scopes.filter((scope) => priorityRowKeys.has(resolveSessionListRowStoreScopeKey(scope)));
    }
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
    if (items.length === 0) return [];
    if (visibleRowKeys === null) {
        if (items.length <= UNKNOWN_VIEWABILITY_EAGER_SUBSCRIPTION_MAX_ROWS) return items;
        if (!priorityRowKeys || priorityRowKeys.size === 0) return [];
        return items.filter((item) => {
            if (item.type !== 'session') return false;
            const key = resolveSessionListRowStoreScopeKey({
                sessionId: item.sessionId,
                serverId: item.serverId ?? null,
            });
            return priorityRowKeys.has(key);
        });
    }
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

export function resolveSessionListRowStoreSubscriptionItemsWithUncachedRows(
    items: ReadonlyArray<SessionListIndexItem>,
    visibleRowKeys: ReadonlySet<string> | null,
    isRowCached: (key: string) => boolean,
    priorityRowKeys: ReadonlySet<string> | null = null,
): ReadonlyArray<SessionListIndexItem> {
    if (items.length === 0) return items;
    if (visibleRowKeys === null) {
        if (items.length <= UNKNOWN_VIEWABILITY_EAGER_SUBSCRIPTION_MAX_ROWS) return items;
        const next: SessionListIndexItem[] = [];
        for (const item of items) {
            if (item.type !== 'session') continue;
            const key = resolveSessionListRowStoreScopeKey({
                sessionId: item.sessionId,
                serverId: item.serverId ?? null,
            });
            if (!key) continue;
            if (priorityRowKeys?.has(key) === true || !isRowCached(key)) {
                next.push(item);
            }
        }
        return next;
    }
    const subscriptionKeys = resolveSessionListRowStoreSubscriptionKeys(visibleRowKeys, priorityRowKeys);
    if (subscriptionKeys === null) return items;
    if (subscriptionKeys.size === 0) return [];

    const next: SessionListIndexItem[] = [];
    for (const item of items) {
        if (item.type !== 'session') continue;
        const key = resolveSessionListRowStoreScopeKey({
            sessionId: item.sessionId,
            serverId: item.serverId ?? null,
        });
        if (!key) continue;
        if (subscriptionKeys.has(key) || !isRowCached(key)) {
            next.push(item);
        }
    }
    return next;
}
