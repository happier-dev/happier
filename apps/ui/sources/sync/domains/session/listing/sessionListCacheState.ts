import {
    findServerScopedSessionListCacheSession,
    listServerScopedSessionListCacheServers,
    listServerScopedSessionListCacheSessions,
} from './serverScopedSessionListCache';
import {
    findSessionListViewDataSession,
    listSessionListViewDataSessionIds,
    listSessionListViewDataSessions,
    type SessionListViewDataSessionEntry,
} from './sessionListViewDataAccess';
import type { ServerScopedSessionListCache } from './serverScopedSessionListCache';
import type { SessionListViewItem } from './sessionListViewData';

export type SessionListCacheStateLike = Readonly<{
    sessionListViewData?: ReadonlyArray<SessionListViewItem> | null | undefined;
    sessionListViewDataByServerId?: ServerScopedSessionListCache | null | undefined;
}> | null | undefined;

export type SessionServerLookupStateLike = SessionListCacheStateLike & Readonly<{
    sessions?: Readonly<Record<string, { serverId?: unknown } | null>> | null | undefined;
}>;

function normalizeSessionId(raw: unknown): string {
    return String(raw ?? '').trim();
}

export function findSessionListCachedSession(
    state: SessionListCacheStateLike,
    sessionId: string,
): SessionListViewDataSessionEntry | null {
    const activeMatch = findSessionListViewDataSession(state?.sessionListViewData, sessionId);
    if (activeMatch) {
        return activeMatch;
    }

    const scopedMatch = findServerScopedSessionListCacheSession(state?.sessionListViewDataByServerId, sessionId);
    if (!scopedMatch) {
        return null;
    }

    return {
        serverId: scopedMatch.serverId,
        serverName: scopedMatch.serverName,
        session: scopedMatch.session,
    };
}

export function listSessionListCachedActiveSessions(
    state: SessionListCacheStateLike,
): SessionListViewDataSessionEntry[] {
    return listSessionListViewDataSessions(state?.sessionListViewData);
}

export function listSessionListCachedServerSessions(
    state: SessionListCacheStateLike,
): ReturnType<typeof listServerScopedSessionListCacheSessions> {
    return listServerScopedSessionListCacheSessions(state?.sessionListViewDataByServerId);
}

export function listSessionListCachedServers(
    state: SessionListCacheStateLike,
): ReturnType<typeof listServerScopedSessionListCacheServers> {
    return listServerScopedSessionListCacheServers(state?.sessionListViewDataByServerId);
}

export function listSessionListCachedActiveSessionIds(
    state: SessionListCacheStateLike,
    limit?: number,
): string[] {
    return listSessionListViewDataSessionIds(state?.sessionListViewData, limit);
}

export function resolveSessionListCachedSessionServerId(
    state: SessionListCacheStateLike,
    sessionId: string,
): string | null {
    return findSessionListCachedSession(state, sessionId)?.serverId ?? null;
}

export function resolveSessionListCachedSessionServerIdFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
): string | null {
    const sid = normalizeSessionId(sessionId);
    if (!sid) return null;

    const direct = state?.sessions?.[sid];
    const serverId = typeof direct?.serverId === 'string' ? normalizeSessionId(direct.serverId) : '';
    if (serverId) return serverId;

    return resolveSessionListCachedSessionServerId(state, sid);
}

export function resolveSessionListCachedSessionServerName(
    state: SessionListCacheStateLike,
    sessionId: string,
): string | null {
    return findSessionListCachedSession(state, sessionId)?.serverName ?? null;
}
