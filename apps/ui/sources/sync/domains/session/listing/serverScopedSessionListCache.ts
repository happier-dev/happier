import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionListViewItem } from './sessionListViewData';

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

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function normalizeOptionalName(raw: unknown): string | null {
    const name = normalizeId(raw);
    return name || null;
}

export function listServerScopedSessionListCacheSessions(
    cacheByServerId: ServerScopedSessionListCache | null | undefined,
): ServerScopedSessionListCacheSessionEntry[] {
    const entries: ServerScopedSessionListCacheSessionEntry[] = [];
    const byServerId = cacheByServerId ?? {};

    for (const serverIdRaw in byServerId) {
        const serverId = normalizeId(serverIdRaw);
        const items = byServerId[serverIdRaw];
        if (!serverId || !Array.isArray(items)) continue;

        for (const item of items) {
            if (!item || item.type !== 'session') continue;
            entries.push({
                serverId,
                serverName: normalizeOptionalName(item.serverName),
                session: item.session,
            });
        }
    }

    return entries;
}

export function findServerScopedSessionListCacheSession(
    cacheByServerId: ServerScopedSessionListCache | null | undefined,
    sessionIdRaw: string,
): ServerScopedSessionListCacheSessionEntry | null {
    const sessionId = normalizeId(sessionIdRaw);
    if (!sessionId) return null;

    const byServerId = cacheByServerId ?? {};
    for (const serverIdRaw in byServerId) {
        const serverId = normalizeId(serverIdRaw);
        const items = byServerId[serverIdRaw];
        if (!serverId || !Array.isArray(items)) continue;

        for (const item of items) {
            if (!item || item.type !== 'session') continue;
            if (normalizeId(item.session.id) === sessionId) {
                return {
                    serverId,
                    serverName: normalizeOptionalName(item.serverName),
                    session: item.session,
                };
            }
        }
    }

    return null;
}

export function listServerScopedSessionListCacheServers(
    cacheByServerId: ServerScopedSessionListCache | null | undefined,
): ServerScopedSessionListCacheServerEntry[] {
    const entriesByServerId = new Map<string, ServerScopedSessionListCacheServerEntry>();
    const byServerId = cacheByServerId ?? {};

    for (const serverIdRaw in byServerId) {
        const serverId = normalizeId(serverIdRaw);
        const items = byServerId[serverIdRaw];
        if (!serverId || !Array.isArray(items)) continue;

        let serverName: string | null = null;
        let hasSessionRow = false;
        for (const item of items) {
            if (!item || item.type !== 'session') continue;
            hasSessionRow = true;
            const nextName = normalizeOptionalName(item.serverName);
            if (!serverName && nextName) {
                serverName = nextName;
            }
        }

        if (hasSessionRow) {
            entriesByServerId.set(serverId, { serverId, serverName });
        }
    }

    return Array.from(entriesByServerId.values());
}
