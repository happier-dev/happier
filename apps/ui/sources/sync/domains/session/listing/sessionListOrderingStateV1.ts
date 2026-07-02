import type { SessionListViewItem } from './sessionListViewData';
import { normalizeTrimmedStringArrayWithSharedEmpty } from './normalizeTrimmedStringArrayWithSharedEmpty';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionFolderWorkspaceRefKey } from '@/sync/domains/session/folders/workspaceRefs';
import {
    compareSessionListSessionOrderingKeys,
    readSessionListUpdatedOrderingKey,
    type SessionListOrderingModeV1,
    type SessionListSessionOrderingKey,
} from './sessionListOrderingRules';

export type { SessionListOrderingModeV1 } from './sessionListOrderingRules';

export const PINNED_GROUP_KEY_V1 = 'pinned-v1';

export const SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP = 100;

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

function addKey(map: Map<string, Set<string>>, groupKey: string, key: string): void {
    const bucket = map.get(groupKey);
    if (!bucket) {
        map.set(groupKey, new Set([key]));
    } else {
        bucket.add(key);
    }
}

function buildFolderKey(folderIdRaw: unknown): string | null {
    const folderId = normalizeTrimmedString(folderIdRaw);
    return folderId ? `folder:${folderId}` : null;
}

function readFolderDepth(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function buildFolderRootGroupKey(item: Pick<Extract<SessionListIndexItem, { type: 'header' }>, 'serverId' | 'workspace'>): string | null {
    if (!item.workspace) return null;
    const serverId = String(item.serverId ?? item.workspace.serverId ?? 'local').trim() || 'local';
    return `folder:${serverId}:${buildSessionFolderWorkspaceRefKey(item.workspace)}:root`;
}

function resolveParentFolderGroupKeyFromOwnGroupKey(groupKeyRaw: unknown, depth: number): string | null {
    const groupKey = normalizeTrimmedString(groupKeyRaw);
    if (!groupKey) return null;
    const remoteMarker = ':folder:';
    const remoteMarkerIndex = groupKey.indexOf(remoteMarker);
    if (remoteMarkerIndex >= 0) {
        return depth <= 0 ? groupKey.slice(0, remoteMarkerIndex) : null;
    }
    if (groupKey.startsWith('folder:')) {
        const lastSeparator = groupKey.lastIndexOf(':');
        if (lastSeparator > 'folder:'.length && depth <= 0) {
            return `${groupKey.slice(0, lastSeparator)}:root`;
        }
    }
    return null;
}

function resolveFolderParentGroupKeyFromViewSource(params: Readonly<{
    source: ReadonlyArray<SessionListViewItem>;
    itemIndex: number;
    folder: Extract<SessionListViewItem, { type: 'header' }>;
}>): string | null {
    const depth = readFolderDepth(params.folder.folderDepth);
    if (depth <= 0) {
        return resolveParentFolderGroupKeyFromOwnGroupKey(params.folder.groupKey, depth);
    }
    for (let index = params.itemIndex - 1; index >= 0; index -= 1) {
        const candidate = params.source[index];
        if (candidate?.type !== 'header' || candidate.headerKind !== 'folder') continue;
        if (readFolderDepth(candidate.folderDepth) < depth) {
            return normalizeTrimmedString(candidate.groupKey) || null;
        }
    }
    return resolveParentFolderGroupKeyFromOwnGroupKey(params.folder.groupKey, depth);
}

function resolveFolderParentGroupKeyFromIndexSource(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    itemIndex: number;
    folder: Extract<SessionListIndexItem, { type: 'header' }>;
}>): string | null {
    const depth = readFolderDepth(params.folder.folderDepth);
    if (depth <= 0) return buildFolderRootGroupKey(params.folder);
    for (let index = params.itemIndex - 1; index >= 0; index -= 1) {
        const candidate = params.source[index];
        if (candidate?.type !== 'header' || candidate.headerKind !== 'folder') continue;
        if (readFolderDepth(candidate.folderDepth) < depth) {
            return normalizeTrimmedString(candidate.groupKey) || null;
        }
    }
    return buildFolderRootGroupKey(params.folder);
}

function buildChildKeySetByGroupKey(source: ReadonlyArray<SessionListViewItem>): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (let index = 0; index < source.length; index += 1) {
        const item = source[index]!;
        if (item.type === 'session') {
            const groupKey = normalizeTrimmedString(item.groupKey);
            if (!groupKey) continue;
            const sessionKey = normalizeSessionListKeyParts(item.serverId, item.session?.id).sessionKey;
            if (sessionKey) addKey(map, groupKey, sessionKey);
            continue;
        }
        if (item.headerKind !== 'folder') continue;
        const groupKey = resolveFolderParentGroupKeyFromViewSource({ source, itemIndex: index, folder: item });
        const folderKey = buildFolderKey(item.folderId);
        if (groupKey && folderKey) addKey(map, groupKey, folderKey);
    }
    return map;
}

function buildChildKeySetByGroupKeyFromIndex(source: ReadonlyArray<SessionListIndexItem>): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (let index = 0; index < source.length; index += 1) {
        const item = source[index]!;
        if (item.type === 'session') {
            const groupKey = normalizeTrimmedString(item.groupKey);
            if (!groupKey) continue;
            const sessionKey = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
            if (sessionKey) addKey(map, groupKey, sessionKey);
            continue;
        }
        if (item.headerKind !== 'folder') continue;
        const groupKey = resolveFolderParentGroupKeyFromIndexSource({ source, itemIndex: index, folder: item });
        const folderKey = buildFolderKey(item.folderId);
        if (groupKey && folderKey) addKey(map, groupKey, folderKey);
    }
    return map;
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

function isSessionListGroupOrderV1AlreadyNormalizedForSource(params: Readonly<{
    source: ReadonlyArray<SessionListViewItem>;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>, sessionsByGroupKey?: Map<string, Set<string>>): boolean {
    const pinnedSet = new Set(normalizeTrimmedStringArrayWithSharedEmpty(params.pinnedSessionKeysV1));
    const sourceSessionKeys = sessionsByGroupKey ?? buildChildKeySetByGroupKey(params.source);

    for (const [groupKeyRaw, keysRaw] of Object.entries(params.sessionListGroupOrderV1 ?? {})) {
        const groupKey = normalizeTrimmedString(groupKeyRaw);
        if (!groupKey) return false;
        if (!Array.isArray(keysRaw)) return false;

        const normalizedKeys = normalizeTrimmedStringArrayWithSharedEmpty(keysRaw);

        if (normalizedKeys.length !== keysRaw.length) return false;
        for (let i = 0; i < normalizedKeys.length; i++) {
            if (normalizedKeys[i] !== keysRaw[i]) return false;
        }

        const capped =
            normalizedKeys.length <= SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP
                ? normalizedKeys as string[]
                : normalizedKeys.slice(0, SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP);
        if (capped.length !== normalizedKeys.length) return false;

        if (groupKey === PINNED_GROUP_KEY_V1) {
            for (const key of capped) {
                if (!pinnedSet.has(key)) return false;
            }
            continue;
        }

        const allowedKeys = sourceSessionKeys.get(groupKey);
        if (!allowedKeys) continue;

        for (const key of capped) {
            if (!allowedKeys.has(key)) return false;
        }
    }

    return true;
}

function isSessionListGroupOrderV1AlreadyNormalizedForIndexSource(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>, sessionsByGroupKey?: Map<string, Set<string>>): boolean {
    const pinnedSet = new Set(normalizeTrimmedStringArrayWithSharedEmpty(params.pinnedSessionKeysV1));
    const sourceSessionKeys = sessionsByGroupKey ?? buildChildKeySetByGroupKeyFromIndex(params.source);

    for (const [groupKeyRaw, keysRaw] of Object.entries(params.sessionListGroupOrderV1 ?? {})) {
        const groupKey = normalizeTrimmedString(groupKeyRaw);
        if (!groupKey) return false;
        if (!Array.isArray(keysRaw)) return false;

        const normalizedKeys = normalizeTrimmedStringArrayWithSharedEmpty(keysRaw);

        if (normalizedKeys.length !== keysRaw.length) return false;
        for (let i = 0; i < normalizedKeys.length; i++) {
            if (normalizedKeys[i] !== keysRaw[i]) return false;
        }

        const capped =
            normalizedKeys.length <= SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP
                ? normalizedKeys as string[]
                : normalizedKeys.slice(0, SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP);
        if (capped.length !== normalizedKeys.length) return false;

        if (groupKey === PINNED_GROUP_KEY_V1) {
            for (const key of capped) {
                if (!pinnedSet.has(key)) return false;
            }
            continue;
        }

        const allowedKeys = sourceSessionKeys.get(groupKey);
        if (!allowedKeys) continue;

        for (const key of capped) {
            if (!allowedKeys.has(key)) return false;
        }
    }

    return true;
}

export function normalizeSessionListGroupOrderV1ForSource(params: Readonly<{
    source: ReadonlyArray<SessionListViewItem>;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>): Record<string, string[]> {
    const cached = readCachedSessionListGroupOrderV1ForSource(params);
    if (cached) {
        return cached;
    }

    if (
        normalizeTrimmedStringArrayWithSharedEmpty(params.pinnedSessionKeysV1).length === 0
        && !hasAnyOwnEntries(params.sessionListGroupOrderV1)
    ) {
        return cacheSessionListGroupOrderV1ForSource(params, EMPTY_SESSION_LIST_GROUP_ORDER_V1);
    }

    const sourceSessionKeys = buildChildKeySetByGroupKey(params.source);

    if (isSessionListGroupOrderV1AlreadyNormalizedForSource(params, sourceSessionKeys)) {
        return cacheSessionListGroupOrderV1ForSource(
            params,
            !hasAnyOwnEntries(params.sessionListGroupOrderV1)
                ? EMPTY_SESSION_LIST_GROUP_ORDER_V1
                : params.sessionListGroupOrderV1 as Record<string, string[]>,
        );
    }

    const pinnedSet = new Set(normalizeTrimmedStringArrayWithSharedEmpty(params.pinnedSessionKeysV1));
    const out: Record<string, string[]> = {};

    for (const [groupKeyRaw, keysRaw] of Object.entries(params.sessionListGroupOrderV1 ?? {})) {
        const groupKey = normalizeTrimmedString(groupKeyRaw);
        if (!groupKey) continue;

        const normalizedKeys = normalizeTrimmedStringArrayWithSharedEmpty(keysRaw);

        const capped =
            normalizedKeys.length <= SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP
                ? normalizedKeys as string[]
                : normalizedKeys.slice(0, SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP);

        if (groupKey === PINNED_GROUP_KEY_V1) {
            const filtered = capped.filter((k) => pinnedSet.has(k));
            if (filtered.length > 0) {
                out[groupKey] = filtered.length === capped.length ? capped : filtered;
            }
            continue;
        }

        const allowedKeys = sourceSessionKeys.get(groupKey);
        if (!allowedKeys) {
            if (capped.length > 0) {
                out[groupKey] = capped;
            }
            continue;
        }

        const filtered = capped.filter((k) => allowedKeys.has(k));
        const finalKeys = filtered.length === capped.length ? capped : filtered;

        if (finalKeys.length > 0) {
            out[groupKey] = finalKeys;
        }
    }

    return cacheSessionListGroupOrderV1ForSource(
        params,
        Object.keys(out).length === 0 ? EMPTY_SESSION_LIST_GROUP_ORDER_V1 : out,
    );
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

    if (isSessionListGroupOrderV1AlreadyNormalizedForIndexSource(params)) {
        return cacheSessionListGroupOrderV1ForIndexSource(params, params.sessionListGroupOrderV1 as Record<string, string[]>);
    }

    const pinnedSet = new Set(normalizeTrimmedStringArrayWithSharedEmpty(params.pinnedSessionKeysV1));
    const sessionsByGroupKey = buildChildKeySetByGroupKeyFromIndex(params.source);

    const normalized: Record<string, string[]> = {};
    for (const [groupKeyRaw, keysRaw] of Object.entries(params.sessionListGroupOrderV1 ?? {})) {
        const groupKey = normalizeTrimmedString(groupKeyRaw);
        if (!groupKey) continue;
        if (!Array.isArray(keysRaw)) continue;

        const normalizedKeys = normalizeTrimmedStringArrayWithSharedEmpty(keysRaw);
        const capped =
            normalizedKeys.length <= SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP
                ? normalizedKeys as string[]
                : normalizedKeys.slice(0, SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP);

        if (groupKey === PINNED_GROUP_KEY_V1) {
            const filtered = capped.filter((key) => pinnedSet.has(key));
            if (filtered.length > 0) {
                normalized[groupKey] = filtered;
            }
            continue;
        }

        const allowedKeys = sessionsByGroupKey.get(groupKey);
        if (!allowedKeys) continue;
        const filtered = capped.filter((key) => allowedKeys.has(key));
        if (filtered.length > 0) {
            normalized[groupKey] = filtered;
        }
    }

    return cacheSessionListGroupOrderV1ForIndexSource(params, normalized);
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
