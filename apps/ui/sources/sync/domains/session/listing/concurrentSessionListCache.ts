import type { SessionListRenderableSession } from './sessionListRenderable';
import { normalizeTrimmedString } from './normalizeTrimmedString';

export type ConcurrentSessionListCacheEntry = Readonly<{
    serverName: string | null;
    sessions: Readonly<Record<string, SessionListRenderableSession>> | null;
}>;

export type ConcurrentSessionListCacheByServerId = Readonly<
    Record<string, ConcurrentSessionListCacheEntry | null | undefined>
>;

export type ConcurrentSessionListCacheSessionEntry = Readonly<{
    serverId: string;
    serverName: string | null;
    session: SessionListRenderableSession;
}>;

export type ConcurrentSessionListCacheServerEntry = Readonly<{
    serverId: string;
    serverName: string | null;
}>;

const EMPTY_CONCURRENT_SESSION_LIST_CACHE_SESSIONS: ConcurrentSessionListCacheSessionEntry[] = [];
const EMPTY_CONCURRENT_SESSION_LIST_CACHE_SERVERS: ConcurrentSessionListCacheServerEntry[] = [];

export function listConcurrentSessionListCacheSessions(
    cacheByServerId: ConcurrentSessionListCacheByServerId | null | undefined,
): ConcurrentSessionListCacheSessionEntry[] {
    const byServerId = cacheByServerId ?? {};
    let entries: ConcurrentSessionListCacheSessionEntry[] | null = null;

    for (const serverIdRaw in byServerId) {
        const serverId = normalizeTrimmedString(serverIdRaw);
        const entry = byServerId[serverIdRaw];
        const sessions = entry && typeof entry === 'object' ? entry.sessions : null;
        if (!serverId || !sessions || typeof sessions !== 'object') continue;

        for (const sessionId in sessions) {
            const session = sessions[sessionId];
            if (!session) continue;
            entries ??= [];
            entries.push({
                serverId,
                serverName: entry?.serverName ?? null,
                session,
            });
        }
    }

    return entries == null ? EMPTY_CONCURRENT_SESSION_LIST_CACHE_SESSIONS : entries;
}

export function findConcurrentSessionListCacheSession(
    cacheByServerId: ConcurrentSessionListCacheByServerId | null | undefined,
    sessionIdRaw: string,
): ConcurrentSessionListCacheSessionEntry | null {
    const sessionId = normalizeTrimmedString(sessionIdRaw);
    if (!sessionId) return null;

    const byServerId = cacheByServerId ?? {};
    for (const serverIdRaw in byServerId) {
        const serverId = normalizeTrimmedString(serverIdRaw);
        const entry = byServerId[serverIdRaw];
        const sessions = entry && typeof entry === 'object' ? entry.sessions : null;
        if (!serverId || !sessions || typeof sessions !== 'object') continue;

        const session = sessions[sessionId];
        if (!session) continue;

        return {
            serverId,
            serverName: entry?.serverName ?? null,
            session,
        };
    }

    return null;
}

export function listConcurrentSessionListCacheServers(
    cacheByServerId: ConcurrentSessionListCacheByServerId | null | undefined,
): ConcurrentSessionListCacheServerEntry[] {
    const byServerId = cacheByServerId ?? {};
    let entries: ConcurrentSessionListCacheServerEntry[] | null = null;

    for (const serverIdRaw in byServerId) {
        const serverId = normalizeTrimmedString(serverIdRaw);
        const entry = byServerId[serverIdRaw];
        const sessions = entry && typeof entry === 'object' ? entry.sessions : null;
        if (!serverId || !sessions || typeof sessions !== 'object') continue;
        if (Object.keys(sessions).length === 0) continue;

        entries ??= [];
        entries.push({
            serverId,
            serverName: entry?.serverName ?? null,
        });
    }

    return entries == null ? EMPTY_CONCURRENT_SESSION_LIST_CACHE_SERVERS : entries;
}
