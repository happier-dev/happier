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
import { normalizeTrimmedString } from './normalizeTrimmedString';
import { normalizeSessionListServerScope } from './normalizeSessionListServerScope';

export type SessionListCacheStateLike = Readonly<{
    sessionListViewData?: ReadonlyArray<SessionListViewItem> | null | undefined;
    sessionListViewDataByServerId?: ServerScopedSessionListCache | null | undefined;
}> | null | undefined;

type SessionServerLookupStateBase = Readonly<{
    sessionListViewData?: ReadonlyArray<SessionListViewItem> | null | undefined;
    sessionListViewDataByServerId?: ServerScopedSessionListCache | null | undefined;
    sessions?: Readonly<Record<string, { serverId?: unknown; metadata?: unknown } | null>> | null | undefined;
}>;

export type SessionServerLookupStateLike = SessionServerLookupStateBase | null | undefined;

export type SessionMetadataLike = Readonly<{
    summary?: Readonly<{ text?: unknown }> | null | undefined;
    summaryText?: unknown;
    name?: unknown;
    path?: unknown;
    homeDir?: unknown;
    machineId?: unknown;
    permissionMode?: unknown;
}> | null | undefined;

type CachedSessionLookup = Readonly<{
    sessionId: string;
    directSession: Readonly<{ serverId?: unknown; metadata?: unknown }> | null | undefined;
    cachedSession: SessionListViewDataSessionEntry | null;
}>;

export type SessionListCachedSessionServerScope = Readonly<{
    serverId: string | null;
    serverName: string | null;
}>;

function resolveCachedSessionLookupFromState(
    state: SessionServerLookupStateLike,
    sessionIdRaw: string,
): CachedSessionLookup | null {
    const sessionId = normalizeTrimmedString(sessionIdRaw);
    if (!sessionId) return null;

    const directSession = state?.sessions?.[sessionId];
    return {
        sessionId,
        directSession,
        cachedSession: findSessionListCachedSession(state, sessionId),
    };
}

export function resolveSessionListCachedSessionServerScopeFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
): SessionListCachedSessionServerScope | null {
    const lookup = resolveCachedSessionLookupFromState(state, sessionId);
    if (!lookup) return null;

    const serverScope = normalizeSessionListServerScope(
        normalizeTrimmedString(lookup.directSession?.serverId) || lookup.cachedSession?.serverId || null,
        lookup.cachedSession?.serverName ?? null,
    );

    return serverScope.serverId === null && serverScope.serverName === null ? null : serverScope;
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
    return scopedMatch ?? null;
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
    return resolveSessionListCachedSessionServerScopeFromState(state, sessionId)?.serverId ?? null;
}

export function resolveSessionListPreferredServerIdFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
    fallbackServerId?: string | null | undefined,
): string | null {
    const resolvedServerId = resolveSessionListCachedSessionServerScopeFromState(state, sessionId)?.serverId ?? null;
    const preferredServerId = resolvedServerId || normalizeTrimmedString(fallbackServerId);
    return preferredServerId || null;
}

export function resolveSessionListCachedSessionMetadataFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
): SessionMetadataLike {
    const lookup = resolveCachedSessionLookupFromState(state, sessionId);
    if (!lookup) return null;

    const cachedMetadata = lookup.cachedSession?.session?.metadata;
    if (cachedMetadata && typeof cachedMetadata === 'object') {
        return cachedMetadata as SessionMetadataLike;
    }

    const directMetadata = lookup.directSession && typeof lookup.directSession === 'object'
        && typeof lookup.directSession.metadata === 'object'
        ? lookup.directSession.metadata
        : null;
    return directMetadata && typeof directMetadata === 'object' ? (directMetadata as SessionMetadataLike) : null;
}

export function resolveSessionListPreferredSessionMetadataFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
): SessionMetadataLike {
    return resolveSessionListCachedSessionMetadataFromState(state, sessionId);
}

export function resolveSessionListCachedSessionServerName(
    state: SessionServerLookupStateLike,
    sessionId: string,
): string | null {
    return resolveSessionListCachedSessionServerScopeFromState(state, sessionId)?.serverName ?? null;
}
