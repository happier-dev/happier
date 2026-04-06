import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionListViewItem } from './sessionListViewData';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import {
    findSessionListViewItemByNormalizedId,
    listSessionListViewItems,
} from './sessionListViewItemAccess';
import { normalizeSessionListViewDataSessionEntry } from './sessionListViewDataAccess';

export type ServerScopedSessionListCache = Readonly<
    Record<string, ReadonlyArray<SessionListViewItem> | null | undefined>
>;

export type ServerScopedSessionListCacheSessionEntry = Readonly<{
    serverId: string;
    serverName: string | null;
    session: SessionListRenderableSession;
}>;

export type ServerScopedSessionListCacheServerEntry = Readonly<{
    serverId: string;
    serverName: string | null;
}>;

const EMPTY_SERVER_SCOPED_SESSION_LIST_CACHE_SESSIONS: ServerScopedSessionListCacheSessionEntry[] = [];
const EMPTY_SERVER_SCOPED_SESSION_LIST_CACHE_SERVERS: ServerScopedSessionListCacheServerEntry[] = [];

function forEachServerScopedSessionListCacheServer(
    cacheByServerId: ServerScopedSessionListCache | null | undefined,
    onServer: (serverId: string, items: ReadonlyArray<SessionListViewItem>) => void,
): void {
    const byServerId = cacheByServerId ?? {};
    for (const serverIdRaw in byServerId) {
        const serverId = normalizeTrimmedString(serverIdRaw);
        const items = byServerId[serverIdRaw];
        if (!serverId || !Array.isArray(items)) continue;

        onServer(serverId, items);
    }
}

function normalizeServerScopedSessionListCacheSessionEntry(
    item: Extract<SessionListViewItem, { type: 'session' }>,
    serverId: string,
): ServerScopedSessionListCacheSessionEntry {
    const normalizedEntry = normalizeSessionListViewDataSessionEntry(item, serverId);
    if (normalizedEntry.serverId === item.serverId && normalizedEntry.serverName === item.serverName) {
        return item as ServerScopedSessionListCacheSessionEntry;
    }

    return {
        serverId: normalizedEntry.serverId ?? serverId,
        serverName: normalizedEntry.serverName,
        session: normalizedEntry.session,
    };
}

export function listServerScopedSessionListCacheSessions(
    cacheByServerId: ServerScopedSessionListCache | null | undefined,
): ServerScopedSessionListCacheSessionEntry[] {
    let entries: ServerScopedSessionListCacheSessionEntry[] | null = null;

    forEachServerScopedSessionListCacheServer(cacheByServerId, (serverId, items) => {
        for (const item of listSessionListViewItems(items)) {
            entries ??= [];
            entries.push(normalizeServerScopedSessionListCacheSessionEntry(item, serverId));
        }
    });

    return entries == null ? EMPTY_SERVER_SCOPED_SESSION_LIST_CACHE_SESSIONS : entries;
}

export function findServerScopedSessionListCacheSession(
    cacheByServerId: ServerScopedSessionListCache | null | undefined,
    sessionIdRaw: string,
): ServerScopedSessionListCacheSessionEntry | null {
    const sessionId = normalizeTrimmedString(sessionIdRaw);
    if (!sessionId) return null;

    let match: ServerScopedSessionListCacheSessionEntry | null = null;
    forEachServerScopedSessionListCacheServer(cacheByServerId, (serverId, items) => {
        if (match) return;
        const scopedItem = findSessionListViewItemByNormalizedId(items, sessionId);
        if (!scopedItem) return;
        match = normalizeServerScopedSessionListCacheSessionEntry(scopedItem, serverId);
    });

    return match;
}

export function listServerScopedSessionListCacheServers(
    cacheByServerId: ServerScopedSessionListCache | null | undefined,
): ServerScopedSessionListCacheServerEntry[] {
    let entries: ServerScopedSessionListCacheServerEntry[] | null = null;

    forEachServerScopedSessionListCacheServer(cacheByServerId, (serverId, items) => {
        let serverName: string | null = null;
        let hasSessionRow = false;
        for (const item of listSessionListViewItems(items)) {
            hasSessionRow = true;
            const nextName = normalizeTrimmedString(item.serverName) || null;
            if (!serverName && nextName) {
                serverName = nextName;
            }
        }

        if (hasSessionRow) {
            entries ??= [];
            entries.push({ serverId, serverName });
        }
    });

    return entries == null ? EMPTY_SERVER_SCOPED_SESSION_LIST_CACHE_SERVERS : entries;
}
