import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionListViewItem } from './sessionListViewData';
import { normalizeSessionListServerScope } from './normalizeSessionListServerScope';
import {
    findSessionListViewItemByNormalizedId,
    listSessionListViewItems,
} from './sessionListViewItemAccess';

export type SessionListViewDataSessionEntry = Readonly<{
    serverId: string | null;
    serverName: string | null;
    session: SessionListRenderableSession;
}>;

const EMPTY_SESSION_LIST_VIEW_DATA_VALUES: never[] = [];
const EMPTY_SESSION_LIST_VIEW_DATA_SESSION_IDS = EMPTY_SESSION_LIST_VIEW_DATA_VALUES as string[];
const EMPTY_SESSION_LIST_VIEW_DATA_SESSIONS = EMPTY_SESSION_LIST_VIEW_DATA_VALUES as SessionListViewDataSessionEntry[];
const NORMALIZED_SESSION_LIST_VIEW_DATA_SESSION_ENTRY_CACHE = new WeakMap<object, Map<string, SessionListViewDataSessionEntry>>();

export function normalizeSessionListViewDataSessionEntry(
    item: Extract<SessionListViewItem, { type: 'session' }>,
    fallbackServerId?: string | null | undefined,
): SessionListViewDataSessionEntry {
    const scope = normalizeSessionListServerScope(item.serverId ?? fallbackServerId, item.serverName);
    const cacheKey = `${scope.serverId ?? ''}\u0000${scope.serverName ?? ''}`;
    const cachedEntries = NORMALIZED_SESSION_LIST_VIEW_DATA_SESSION_ENTRY_CACHE.get(item);
    const cachedEntry = cachedEntries?.get(cacheKey);
    if (cachedEntry) {
        return cachedEntry;
    }

    const normalizedEntry = {
        serverId: scope.serverId,
        serverName: scope.serverName,
        session: item.session,
    };
    if (!cachedEntries) {
        NORMALIZED_SESSION_LIST_VIEW_DATA_SESSION_ENTRY_CACHE.set(item, new Map([[cacheKey, normalizedEntry]]));
    } else {
        cachedEntries.set(cacheKey, normalizedEntry);
    }
    return normalizedEntry;
}

export function listSessionListViewDataSessions(
    items: ReadonlyArray<SessionListViewItem> | null | undefined | unknown,
): SessionListViewDataSessionEntry[] {
    let entries: SessionListViewDataSessionEntry[] | null = null;
    for (const item of listSessionListViewItems(items)) {
        entries ??= [];
        entries.push(normalizeSessionListViewDataSessionEntry(item));
    }

    return entries ?? EMPTY_SESSION_LIST_VIEW_DATA_SESSIONS;
}

export function findSessionListViewDataSession(
    items: ReadonlyArray<SessionListViewItem> | null | undefined | unknown,
    sessionIdRaw: string,
): SessionListViewDataSessionEntry | null {
    const item = findSessionListViewItemByNormalizedId(items, sessionIdRaw);
    if (!item) return null;

    return normalizeSessionListViewDataSessionEntry(item);
}

export function listSessionListViewDataSessionIds(
    items: ReadonlyArray<SessionListViewItem> | null | undefined | unknown,
    limit?: number,
): string[] {
    const max = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : null;
    if (max === 0) return EMPTY_SESSION_LIST_VIEW_DATA_SESSION_IDS;

    let ids: string[] | null = null;
    for (const item of listSessionListViewItems(items)) {
        ids ??= [];
        ids.push(item.session.id);
        if (max !== null && ids.length >= max) {
            break;
        }
    }
    return ids ?? EMPTY_SESSION_LIST_VIEW_DATA_SESSION_IDS;
}
