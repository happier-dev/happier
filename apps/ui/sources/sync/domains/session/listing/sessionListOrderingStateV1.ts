import type { SessionListViewItem } from './sessionListViewData';
import { normalizeTrimmedStringArrayWithSharedEmpty } from './normalizeTrimmedStringArrayWithSharedEmpty';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionWorkspaceFallbackOrderScope, readSessionWorkspaceFallbackIdentity } from './sessionWorkspaceOrderKeys';
import { buildSessionSectionGroupKey, readLegacySessionSectionGroupAddress } from '../organization/sections';
import {
    compareSessionListSessionOrderingKeys,
    readSessionListUpdatedOrderingKey,
    type SessionListOrderingModeV1,
    type SessionListSessionOrderingKey,
} from './sessionListOrderingRules';

export type { SessionListOrderingModeV1 } from './sessionListOrderingRules';

export const PINNED_GROUP_KEY_V1 = 'pinned-v1';

const SESSION_LIST_FOLDER_ORDER_ITEM_KIND = 'folder';

/**
 * The one order-item key for a folder, qualified by the exact Home that stores it.
 *
 * Session order items already use the opaque {@link normalizeSessionListKeyParts} key; folders now
 * use the same shape for the same reason: two Homes routinely hold the same Home-local folder id,
 * and one merged order map, index lookup, drag key or reorder write must never conflate them.
 * Like every key in this corridor it is opaque — build it here and compare it, never parse it.
 */
export function buildSessionListFolderOrderItemKey(params: Readonly<{
    serverId: string | null | undefined;
    folderId: string | null | undefined;
}>): string | null {
    const folderId = normalizeTrimmedString(params.folderId);
    if (!folderId) return null;
    return JSON.stringify([
        SESSION_LIST_FOLDER_ORDER_ITEM_KIND,
        normalizeTrimmedString(params.serverId) || null,
        folderId,
    ]);
}

/** Whether an opaque order-item key names a folder rather than a Session. */
export function isSessionListFolderOrderItemKey(key: unknown): boolean {
    if (typeof key !== 'string' || !key.startsWith(`["${SESSION_LIST_FOLDER_ORDER_ITEM_KIND}",`)) return false;
    try {
        const parsed: unknown = JSON.parse(key);
        return Array.isArray(parsed)
            && parsed.length === 3
            && parsed[0] === SESSION_LIST_FOLDER_ORDER_ITEM_KIND;
    } catch {
        return false;
    }
}

const EMPTY_SESSION_LIST_GROUP_ORDER_V1: Record<string, string[]> = {};
const SORTED_SESSION_LIST_VIEW_ITEMS_BY_SOURCE = new WeakMap<
    ReadonlyArray<SessionListViewItem>,
    Map<SessionListOrderingModeV1, SessionListViewItem[]>
>();
const SESSION_LIST_GROUP_ORDER_V1_CACHE = new WeakMap<
    ReadonlyArray<SessionListViewItem>,
    WeakMap<
        ReadonlyArray<string>,
        WeakMap<Readonly<Record<string, ReadonlyArray<string> | undefined>>, Record<string, string[]>>
    >
>();
const SESSION_LIST_GROUP_ORDER_V1_INDEX_CACHE = new WeakMap<
    ReadonlyArray<SessionListIndexItem>,
    WeakMap<
        ReadonlyArray<string>,
        WeakMap<Readonly<Record<string, ReadonlyArray<string> | undefined>>, Record<string, string[]>>
    >
>();

function hasAnyOwnEntries(
    record: Readonly<Record<string, ReadonlyArray<string> | undefined>> | null | undefined,
): boolean {
    const source = record ?? {};
    for (const key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            return true;
        }
    }
    return false;
}

function compareSessionItemsByOrderingMode(
    a: Extract<SessionListViewItem, { type: 'session' }>,
    b: Extract<SessionListViewItem, { type: 'session' }>,
    orderingMode: SessionListOrderingModeV1,
    keyCache: ReadonlyMap<Extract<SessionListViewItem, { type: 'session' }>, SessionListSessionOrderingKey>,
): number {
    const keyA = keyCache.get(a);
    const keyB = keyCache.get(b);
    if (!keyA || !keyB) return 0;
    return compareSessionListSessionOrderingKeys(keyA, keyB, orderingMode);
}

function buildSessionListViewItemOrderingKey(
    item: Extract<SessionListViewItem, { type: 'session' }>,
): SessionListSessionOrderingKey {
    const createdAt = typeof item.session.createdAt === 'number' ? item.session.createdAt : 0;
    return {
        updated: readSessionListUpdatedOrderingKey({
            createdAt,
            meaningfulActivityAt: item.session.meaningfulActivityAt,
        }),
        createdAt,
        stableId: normalizeSessionListKeyParts(item.serverId, item.session?.id).sessionKey
            || normalizeTrimmedString(item.session?.id),
    };
}

function isSessionListViewItemsAlreadyOrderedByOrderingMode(
    source: ReadonlyArray<SessionListViewItem>,
    orderingMode: SessionListOrderingModeV1,
): boolean {
    const lastSessionByGroupKey = new Map<string, Extract<SessionListViewItem, { type: 'session' }>>();
    const keyCache = new Map<Extract<SessionListViewItem, { type: 'session' }>, SessionListSessionOrderingKey>();

    for (const item of source) {
        if (item.type !== 'session') continue;

        const groupKey = normalizeTrimmedString(item.groupKey);
        if (!groupKey) continue;
        keyCache.set(item, buildSessionListViewItemOrderingKey(item));

        const previous = lastSessionByGroupKey.get(groupKey);
        if (previous && compareSessionItemsByOrderingMode(previous, item, orderingMode, keyCache) > 0) {
            return false;
        }

        lastSessionByGroupKey.set(groupKey, item);
    }

    return lastSessionByGroupKey.size > 0;
}

export function sortSessionListViewItemsByOrderingMode(
    source: ReadonlyArray<SessionListViewItem>,
    orderingMode: SessionListOrderingModeV1,
): SessionListViewItem[] {
    if (orderingMode === 'custom') {
        return source as SessionListViewItem[];
    }

    const cachedByMode = SORTED_SESSION_LIST_VIEW_ITEMS_BY_SOURCE.get(source);
    const cachedSorted = cachedByMode?.get(orderingMode);
    if (cachedSorted) {
        return cachedSorted;
    }

    if (isSessionListViewItemsAlreadyOrderedByOrderingMode(source, orderingMode)) {
        return source as SessionListViewItem[];
    }

    const sessionsByGroupKey = new Map<string, Array<Extract<SessionListViewItem, { type: 'session' }>>>();
    for (const item of source) {
        if (item.type !== 'session') continue;
        const groupKey = normalizeTrimmedString(item.groupKey);
        if (!groupKey) continue;
        if (!sessionsByGroupKey.has(groupKey)) {
            sessionsByGroupKey.set(groupKey, []);
        }
        sessionsByGroupKey.get(groupKey)!.push(item);
    }

    const sortedByGroupKey = new Map<string, Array<Extract<SessionListViewItem, { type: 'session' }>>>();
    for (const [groupKey, sessions] of sessionsByGroupKey.entries()) {
        if (sessions.length < 2) continue;
        const keyCache = new Map<Extract<SessionListViewItem, { type: 'session' }>, SessionListSessionOrderingKey>();
        for (const item of sessions) {
            keyCache.set(item, buildSessionListViewItemOrderingKey(item));
        }
        const next = [...sessions].sort((a, b) => compareSessionItemsByOrderingMode(a, b, orderingMode, keyCache));
        sortedByGroupKey.set(groupKey, next);
    }

    if (sortedByGroupKey.size === 0) {
        return source as SessionListViewItem[];
    }

    const indicesByGroupKey = new Map<string, number>();
    const out: SessionListViewItem[] = [];
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

    if (!didChange) {
        return source as SessionListViewItem[];
    }

    if (!cachedByMode) {
        SORTED_SESSION_LIST_VIEW_ITEMS_BY_SOURCE.set(source, new Map([[orderingMode, out]]));
    } else {
        cachedByMode.set(orderingMode, out);
    }

    return out;
}

function readCachedSessionListGroupOrderV1ForSource(params: Readonly<{
    source: ReadonlyArray<SessionListViewItem>;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>): Record<string, string[]> | null {
    const byPinned = SESSION_LIST_GROUP_ORDER_V1_CACHE.get(params.source);
    const byGroupOrder = byPinned?.get(params.pinnedSessionKeysV1);
    return byGroupOrder?.get(params.sessionListGroupOrderV1) ?? null;
}

function readCachedSessionListGroupOrderV1ForIndexSource(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>): Record<string, string[]> | null {
    const byPinned = SESSION_LIST_GROUP_ORDER_V1_INDEX_CACHE.get(params.source);
    const byGroupOrder = byPinned?.get(params.pinnedSessionKeysV1);
    return byGroupOrder?.get(params.sessionListGroupOrderV1) ?? null;
}

function cacheSessionListGroupOrderV1ForSource(params: Readonly<{
    source: ReadonlyArray<SessionListViewItem>;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>, normalized: Record<string, string[]>): Record<string, string[]> {
    let byPinned = SESSION_LIST_GROUP_ORDER_V1_CACHE.get(params.source);
    if (!byPinned) {
        byPinned = new WeakMap();
        SESSION_LIST_GROUP_ORDER_V1_CACHE.set(params.source, byPinned);
    }

    let byGroupOrder = byPinned.get(params.pinnedSessionKeysV1);
    if (!byGroupOrder) {
        byGroupOrder = new WeakMap();
        byPinned.set(params.pinnedSessionKeysV1, byGroupOrder);
    }

    byGroupOrder.set(params.sessionListGroupOrderV1, normalized);
    return normalized;
}

function cacheSessionListGroupOrderV1ForIndexSource(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>, normalized: Record<string, string[]>): Record<string, string[]> {
    let byPinned = SESSION_LIST_GROUP_ORDER_V1_INDEX_CACHE.get(params.source);
    if (!byPinned) {
        byPinned = new WeakMap();
        SESSION_LIST_GROUP_ORDER_V1_INDEX_CACHE.set(params.source, byPinned);
    }

    let byGroupOrder = byPinned.get(params.pinnedSessionKeysV1);
    if (!byGroupOrder) {
        byGroupOrder = new WeakMap();
        byPinned.set(params.pinnedSessionKeysV1, byGroupOrder);
    }

    byGroupOrder.set(params.sessionListGroupOrderV1, normalized);
    return normalized;
}

/** One ingress for persisted Project/Section aliases; this never publishes a migration write. */
export function normalizeSessionOrganizationGroupOrder(
    source: ReadonlyArray<SessionListIndexItem | SessionListViewItem>,
    order: Readonly<Record<string, ReadonlyArray<string>>>,
): Readonly<Record<string, ReadonlyArray<string>>>;
export function normalizeSessionOrganizationGroupOrder(
    source: ReadonlyArray<SessionListIndexItem | SessionListViewItem>,
    order: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
): Readonly<Record<string, ReadonlyArray<string> | undefined>>;
export function normalizeSessionOrganizationGroupOrder(
    source: ReadonlyArray<SessionListIndexItem | SessionListViewItem>,
    order: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
): Readonly<Record<string, ReadonlyArray<string> | undefined>> {
    const internalKeyByScope = new Map<string, string | null>();
    for (const item of source) {
        if (item.type !== 'header' || item.headerKind !== 'project' || !item.groupKey) continue;
        const identity = readSessionWorkspaceFallbackIdentity(item.groupKey);
        if (!identity || identity[0] !== (item.serverId ?? null)) continue;
        const scope = buildSessionWorkspaceFallbackOrderScope(identity);
        const previous = internalKeyByScope.get(scope);
        internalKeyByScope.set(scope, previous === undefined || previous === item.groupKey ? item.groupKey : null);
    }
    const selected = new Map<string, { keys: readonly string[] | undefined; canonical: boolean }>();
    let changed = false;
    for (const [key, keys] of Object.entries(order)) {
        const section = readLegacySessionSectionGroupAddress(key);
        const identity = readSessionWorkspaceFallbackIdentity(key);
        const scope = section ? buildSessionSectionGroupKey(section)
            : identity ? buildSessionWorkspaceFallbackOrderScope(identity) : key;
        const target = internalKeyByScope.get(scope) ?? (section ? scope : key);
        const canonical = key === scope;
        const previous = selected.get(target);
        if (!previous || canonical || !previous.canonical) selected.set(target, { keys, canonical });
        changed ||= target !== key || previous !== undefined;
    }
    return changed ? Object.fromEntries([...selected].map(([key, value]) => [key, value.keys])) : order;
}

function isSessionListGroupOrderV1AlreadyNormalized(params: Readonly<{
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>): boolean {
    const pinnedSet = new Set(normalizeTrimmedStringArrayWithSharedEmpty(params.pinnedSessionKeysV1));

    for (const [groupKeyRaw, keysRaw] of Object.entries(params.sessionListGroupOrderV1 ?? {})) {
        const groupKey = normalizeTrimmedString(groupKeyRaw);
        if (!groupKey) return false;
        if (!Array.isArray(keysRaw)) return false;

        const normalizedKeys = normalizeTrimmedStringArrayWithSharedEmpty(keysRaw);

        if (normalizedKeys.length !== keysRaw.length) return false;
        for (let i = 0; i < normalizedKeys.length; i++) {
            if (normalizedKeys[i] !== keysRaw[i]) return false;
        }

        if (groupKey === PINNED_GROUP_KEY_V1) {
            for (const key of normalizedKeys) {
                if (!pinnedSet.has(key)) return false;
            }
        }
    }

    return true;
}

/** A page/filter is not a deletion signal for saved ordinary ordering. Pins retain their membership rule. */
function normalizeSessionListGroupOrderV1(params: Readonly<{
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>): Record<string, string[]> {
    if (!hasAnyOwnEntries(params.sessionListGroupOrderV1)) return EMPTY_SESSION_LIST_GROUP_ORDER_V1;
    if (isSessionListGroupOrderV1AlreadyNormalized(params)) return params.sessionListGroupOrderV1 as Record<string, string[]>;

    const pinnedSet = new Set(normalizeTrimmedStringArrayWithSharedEmpty(params.pinnedSessionKeysV1));
    const out: Record<string, string[]> = {};

    for (const [groupKeyRaw, keysRaw] of Object.entries(params.sessionListGroupOrderV1 ?? {})) {
        const groupKey = normalizeTrimmedString(groupKeyRaw);
        if (!groupKey) continue;
        if (!Array.isArray(keysRaw)) continue;

        const normalizedKeys = normalizeTrimmedStringArrayWithSharedEmpty(keysRaw);

        if (groupKey === PINNED_GROUP_KEY_V1) {
            const filtered = normalizedKeys.filter((k) => pinnedSet.has(k));
            if (filtered.length > 0) {
                out[groupKey] = filtered.length === normalizedKeys.length ? normalizedKeys as string[] : filtered;
            }
            continue;
        }

        out[groupKey] = normalizedKeys as string[];
    }

    return Object.keys(out).length === 0 ? EMPTY_SESSION_LIST_GROUP_ORDER_V1 : out;
}

export function normalizeSessionListGroupOrderV1ForSource(params: Readonly<{
    source: ReadonlyArray<SessionListViewItem>;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>): Record<string, string[]> {
    const cached = readCachedSessionListGroupOrderV1ForSource(params);
    if (cached) return cached;
    const aliased = normalizeSessionOrganizationGroupOrder(params.source, params.sessionListGroupOrderV1);
    return cacheSessionListGroupOrderV1ForSource(params,
        normalizeSessionListGroupOrderV1({ ...params, sessionListGroupOrderV1: aliased }));
}

export function normalizeSessionListGroupOrderV1ForIndexSource(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>): Record<string, string[]> {
    if (!hasAnyOwnEntries(params.sessionListGroupOrderV1)) {
        return EMPTY_SESSION_LIST_GROUP_ORDER_V1;
    }

    const cached = readCachedSessionListGroupOrderV1ForIndexSource(params);
    if (cached) {
        return cached;
    }

    const aliased = normalizeSessionOrganizationGroupOrder(params.source, params.sessionListGroupOrderV1);
    return cacheSessionListGroupOrderV1ForIndexSource(params,
        normalizeSessionListGroupOrderV1({ ...params, sessionListGroupOrderV1: aliased }));
}

export function areSessionListGroupOrderMapsEqual(
    a: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
    b: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
): boolean {
    const aKeys = Object.keys(a ?? {}).sort();
    const bKeys = Object.keys(b ?? {}).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
        if (aKeys[i] !== bKeys[i]) return false;
        const ak = aKeys[i];
        const av = a[ak] ?? [];
        const bv = b[ak] ?? [];
        if (av.length !== bv.length) return false;
        for (let j = 0; j < av.length; j++) {
            if (av[j] !== bv[j]) return false;
        }
    }
    return true;
}
