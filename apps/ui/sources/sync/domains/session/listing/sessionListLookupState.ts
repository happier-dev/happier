import {
    findConcurrentSessionListCacheSession,
    listConcurrentSessionListCacheServers,
    listConcurrentSessionListCacheSessions,
    type ConcurrentSessionListCacheByServerId,
} from './concurrentSessionListCache';
import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionListIndexItem } from '../../sessionList/sessionListIndex';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import { normalizeSessionListServerScope } from './normalizeSessionListServerScope';
import { getActiveServerSnapshot } from '../../server/serverRuntime';
import { resolveSessionMachineId } from '../directSessions/resolveSessionMachineId';

export type SessionListLookupStateLike = Readonly<{
    sessionListIndexByServerId?: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>> | null | undefined;
    sessionListRenderables?: Readonly<Record<string, SessionListRenderableSession>> | null | undefined;
    concurrentSessionListCacheByServerId?: ConcurrentSessionListCacheByServerId | null | undefined;
}> | null | undefined;

type SessionServerLookupStateBase = Readonly<{
    sessionListIndexByServerId?: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>> | null | undefined;
    sessionListRenderables?: Readonly<Record<string, SessionListRenderableSession>> | null | undefined;
    concurrentSessionListCacheByServerId?: ConcurrentSessionListCacheByServerId | null | undefined;
    sessions?: Readonly<Record<string, { serverId?: unknown; metadata?: unknown } | null>> | null | undefined;
}>;

export type SessionServerLookupStateLike = SessionServerLookupStateBase | null | undefined;

export type SessionMetadataLike = Readonly<{
    summary?: Readonly<{ text?: unknown }> | null | undefined;
    summaryText?: unknown;
    name?: unknown;
    path?: unknown;
    host?: unknown;
    homeDir?: unknown;
    machineId?: unknown;
    permissionMode?: unknown;
    directSessionV1?: unknown;
}> | null | undefined;

export type SessionListLookupSessionServerScope = Readonly<{
    serverId: string | null;
    serverName: string | null;
}>;

export type SessionListLookupSessionEntry = Readonly<{
    serverId: string;
    serverName: string | null;
    session: SessionListRenderableSession;
}>;

const PREFERRED_SESSION_LIST_SERVER_ID_MEMO_BY_STATE = new WeakMap<
    object,
    Map<string, Map<string, string | null>>
>();
const SESSION_LIST_LOOKUP_SESSION_MEMO_BY_STATE = new WeakMap<
    object,
    Map<string, SessionListLookupSessionEntry | null>
>();
const SESSION_LIST_LOOKUP_SESSION_SERVER_ID_MEMO_BY_STATE = new WeakMap<
    object,
    Map<string, string | null>
>();
const PREFERRED_SESSION_LIST_METADATA_MEMO_BY_STATE = new WeakMap<
    object,
    Map<string, SessionMetadataLike>
>();
const SESSION_LIST_LOOKUP_SESSION_SERVER_SCOPE_MEMO_BY_STATE = new WeakMap<
    object,
    Map<string, SessionListLookupSessionServerScope | null>
>();

const EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSIONS: SessionListLookupSessionEntry[] = [];
const EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSION_IDS: string[] = [];

function resolvePreferredSessionListIndexServerIdFromIndex(
    indexByServerId: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>,
): string | null {
    const activeServerId = normalizeTrimmedString(getActiveServerSnapshot().serverId);
    if (activeServerId && Array.isArray(indexByServerId[activeServerId]) && (indexByServerId[activeServerId]?.length ?? 0) > 0) {
        return activeServerId;
    }

    const nonEmptyServerIds: string[] = [];
    for (const serverIdRaw in indexByServerId) {
        const serverId = normalizeTrimmedString(serverIdRaw);
        const items = indexByServerId[serverIdRaw];
        if (!serverId || !Array.isArray(items) || items.length === 0) continue;
        nonEmptyServerIds.push(serverId);
    }

    if (nonEmptyServerIds.length === 1) {
        return nonEmptyServerIds[0] ?? null;
    }

    if (activeServerId && activeServerId in indexByServerId) {
        return activeServerId;
    }

    return nonEmptyServerIds[0] || null;
}

function resolvePreferredSessionListIndexServerIdFromState(
    state: SessionListLookupStateLike,
): string | null {
    if (!state || typeof state !== 'object') return null;

    return resolvePreferredSessionListIndexServerIdFromIndex(state.sessionListIndexByServerId ?? {});
}

function findSessionListIndexSessionScopeFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
): SessionListLookupSessionServerScope | null {
    if (!state || typeof state !== 'object') return null;

    const normalizedSessionId = normalizeTrimmedString(sessionId);
    if (!normalizedSessionId) return null;

    const directServerId = normalizeTrimmedString(state.sessions?.[normalizedSessionId]?.serverId);
    if (directServerId) {
        const directIndex = state.sessionListIndexByServerId?.[directServerId];
        if (Array.isArray(directIndex)) {
            for (const item of directIndex) {
                if (item.type !== 'session') continue;
                if (normalizeTrimmedString(item.sessionId) !== normalizedSessionId) continue;
                return normalizeSessionListServerScope(
                    directServerId || normalizeTrimmedString(item.serverId) || null,
                    normalizeTrimmedString(item.serverName) || null,
                );
            }
        }
    }

    const indexByServerId = state.sessionListIndexByServerId ?? {};
    const preferredServerId = resolvePreferredSessionListIndexServerIdFromIndex(indexByServerId);
    const serverIdsToCheck: string[] = [];
    const pushServerId = (serverIdRaw: string | null | undefined) => {
        const serverId = normalizeTrimmedString(serverIdRaw);
        if (!serverId || serverIdsToCheck.includes(serverId)) return;
        serverIdsToCheck.push(serverId);
    };

    pushServerId(preferredServerId);
    pushServerId(directServerId);

    for (const serverIdRaw in indexByServerId) {
        pushServerId(serverIdRaw);
    }

    for (const serverId of serverIdsToCheck) {
        const items = indexByServerId[serverId];
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            if (item.type !== 'session') continue;
            if (normalizeTrimmedString(item.sessionId) !== normalizedSessionId) continue;
            return normalizeSessionListServerScope(
                normalizeTrimmedString(item.serverId) || serverId,
                normalizeTrimmedString(item.serverName) || null,
            );
        }
    }

    const concurrentMatch = findConcurrentSessionListCacheSession(state.concurrentSessionListCacheByServerId, normalizedSessionId);
    if (concurrentMatch) {
        return normalizeSessionListServerScope(concurrentMatch.serverId, concurrentMatch.serverName);
    }

    if (directServerId) {
        return normalizeSessionListServerScope(directServerId, null);
    }

    return null;
}

function resolveSessionListLookupSessionEntryFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
): SessionListLookupSessionEntry | null {
    const normalizedSessionId = normalizeTrimmedString(sessionId);
    if (!normalizedSessionId) return null;

    const serverScope = findSessionListIndexSessionScopeFromState(state, normalizedSessionId);
    if (!serverScope) return null;

    const renderableSession = state?.sessionListRenderables?.[normalizedSessionId];
    if (renderableSession) {
        return {
            serverId: serverScope.serverId ?? '',
            serverName: serverScope.serverName,
            session: renderableSession,
        };
    }

    const directSession = state?.sessions?.[normalizedSessionId];
    if (directSession) {
        const directServerId = normalizeTrimmedString(directSession.serverId);
        return {
            serverId: serverScope.serverId ?? directServerId ?? '',
            serverName: serverScope.serverName,
            session: directSession as unknown as SessionListRenderableSession,
        };
    }

    const concurrentMatch = findConcurrentSessionListCacheSession(state?.concurrentSessionListCacheByServerId, normalizedSessionId);
    if (concurrentMatch) {
        return {
            serverId: serverScope.serverId ?? concurrentMatch.serverId ?? '',
            serverName: serverScope.serverName ?? concurrentMatch.serverName ?? null,
            session: concurrentMatch.session,
        };
    }

    return null;
}

function readMemoizedPreferredSessionListServerIdFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
    fallbackServerId: string | null,
): string | null | undefined {
    if (!state || typeof state !== 'object') return undefined;

    const cachedBySessionId = PREFERRED_SESSION_LIST_SERVER_ID_MEMO_BY_STATE.get(state);
    const cachedByFallback = cachedBySessionId?.get(sessionId);
    if (!cachedByFallback) return undefined;

    return cachedByFallback.get(fallbackServerId ?? '') as string | null | undefined;
}

function writeMemoizedPreferredSessionListServerIdToState(
    state: SessionServerLookupStateLike,
    sessionId: string,
    fallbackServerId: string | null,
    resolvedServerId: string | null,
): string | null {
    if (!state || typeof state !== 'object') return resolvedServerId;

    let cachedBySessionId = PREFERRED_SESSION_LIST_SERVER_ID_MEMO_BY_STATE.get(state);
    if (!cachedBySessionId) {
        cachedBySessionId = new Map();
        PREFERRED_SESSION_LIST_SERVER_ID_MEMO_BY_STATE.set(state, cachedBySessionId);
    }

    let cachedByFallback = cachedBySessionId.get(sessionId);
    if (!cachedByFallback) {
        cachedByFallback = new Map();
        cachedBySessionId.set(sessionId, cachedByFallback);
    }

    cachedByFallback.set(fallbackServerId ?? '', resolvedServerId);
    return resolvedServerId;
}

function readMemoizedPreferredSessionListMetadataFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
): SessionMetadataLike | undefined {
    if (!state || typeof state !== 'object') return undefined;
    return PREFERRED_SESSION_LIST_METADATA_MEMO_BY_STATE.get(state)?.get(sessionId);
}

function writeMemoizedPreferredSessionListMetadataToState(
    state: SessionServerLookupStateLike,
    sessionId: string,
    metadata: SessionMetadataLike,
): SessionMetadataLike {
    if (!state || typeof state !== 'object') return metadata;

    let cachedBySessionId = PREFERRED_SESSION_LIST_METADATA_MEMO_BY_STATE.get(state);
    if (!cachedBySessionId) {
        cachedBySessionId = new Map();
        PREFERRED_SESSION_LIST_METADATA_MEMO_BY_STATE.set(state, cachedBySessionId);
    }

    cachedBySessionId.set(sessionId, metadata);
    return metadata;
}

function mergeCachedSessionMetadataWithCanonicalMachineId(
    cachedMetadata: SessionMetadataLike,
    directMetadata: SessionMetadataLike,
): SessionMetadataLike {
    if (!cachedMetadata || typeof cachedMetadata !== 'object') {
        return cachedMetadata;
    }

    if (resolveSessionMachineId(cachedMetadata)) {
        return cachedMetadata;
    }

    const canonicalMachineId = resolveSessionMachineId(directMetadata);
    if (!canonicalMachineId) {
        return cachedMetadata;
    }

    return {
        ...cachedMetadata,
        machineId: canonicalMachineId,
    };
}

function readCachedSessionListLookupSessionServerScopeFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
): SessionListLookupSessionServerScope | null | undefined {
    if (!state || typeof state !== 'object') return undefined;
    return SESSION_LIST_LOOKUP_SESSION_SERVER_SCOPE_MEMO_BY_STATE.get(state)?.get(sessionId);
}

function writeCachedSessionListLookupSessionServerScopeToState(
    state: SessionServerLookupStateLike,
    sessionId: string,
    serverScope: SessionListLookupSessionServerScope | null,
): SessionListLookupSessionServerScope | null {
    if (!state || typeof state !== 'object') return serverScope;

    let cachedBySessionId = SESSION_LIST_LOOKUP_SESSION_SERVER_SCOPE_MEMO_BY_STATE.get(state);
    if (!cachedBySessionId) {
        cachedBySessionId = new Map();
        SESSION_LIST_LOOKUP_SESSION_SERVER_SCOPE_MEMO_BY_STATE.set(state, cachedBySessionId);
    }

    cachedBySessionId.set(sessionId, serverScope);
    return serverScope;
}

function readCachedSessionListLookupSessionFromState(
    state: SessionListLookupStateLike,
    sessionId: string,
): SessionListLookupSessionEntry | null | undefined {
    if (!state || typeof state !== 'object') return undefined;
    return SESSION_LIST_LOOKUP_SESSION_MEMO_BY_STATE.get(state)?.get(sessionId);
}

function writeCachedSessionListLookupSessionToState(
    state: SessionListLookupStateLike,
    sessionId: string,
    lookupSession: SessionListLookupSessionEntry | null,
): SessionListLookupSessionEntry | null {
    if (!state || typeof state !== 'object') return lookupSession;

    let cachedBySessionId = SESSION_LIST_LOOKUP_SESSION_MEMO_BY_STATE.get(state);
    if (!cachedBySessionId) {
        if (!lookupSession) {
            return lookupSession;
        }

        cachedBySessionId = new Map();
        SESSION_LIST_LOOKUP_SESSION_MEMO_BY_STATE.set(state, cachedBySessionId);
    }

    if (!lookupSession) {
        cachedBySessionId.delete(sessionId);
        return lookupSession;
    }

    cachedBySessionId.set(sessionId, lookupSession);
    return lookupSession;
}

function readCachedSessionListLookupSessionServerIdFromState(
    state: SessionListLookupStateLike,
    sessionId: string,
): string | null | undefined {
    if (!state || typeof state !== 'object') return undefined;
    return SESSION_LIST_LOOKUP_SESSION_SERVER_ID_MEMO_BY_STATE.get(state)?.get(sessionId);
}

function writeCachedSessionListLookupSessionServerIdToState(
    state: SessionListLookupStateLike,
    sessionId: string,
    serverId: string | null,
): string | null {
    if (!state || typeof state !== 'object') return serverId;

    let cachedBySessionId = SESSION_LIST_LOOKUP_SESSION_SERVER_ID_MEMO_BY_STATE.get(state);
    if (!cachedBySessionId) {
        cachedBySessionId = new Map();
        SESSION_LIST_LOOKUP_SESSION_SERVER_ID_MEMO_BY_STATE.set(state, cachedBySessionId);
    }

    cachedBySessionId.set(sessionId, serverId);
    return serverId;
}

export function resolveSessionListLookupSessionServerScopeFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
): SessionListLookupSessionServerScope | null {
    const normalizedSessionId = normalizeTrimmedString(sessionId);
    if (!normalizedSessionId) return null;

    const cached = readCachedSessionListLookupSessionServerScopeFromState(state, normalizedSessionId);
    if (cached !== undefined) {
        return cached;
    }

    const indexedScope = findSessionListIndexSessionScopeFromState(state, normalizedSessionId);
    if (indexedScope) {
        return writeCachedSessionListLookupSessionServerScopeToState(
            state,
            normalizedSessionId,
            indexedScope.serverId === null && indexedScope.serverName === null ? null : indexedScope,
        );
    }

    const directServerId = normalizeTrimmedString(state?.sessions?.[normalizedSessionId]?.serverId);
    if (!directServerId) return null;

    const serverScope = normalizeSessionListServerScope(directServerId, null);

    return writeCachedSessionListLookupSessionServerScopeToState(
        state,
        normalizedSessionId,
        serverScope.serverId === null && serverScope.serverName === null ? null : serverScope,
    );
}

export function findSessionListLookupSession(
    state: SessionListLookupStateLike,
    sessionId: string,
): SessionListLookupSessionEntry | null {
    const normalizedSessionId = normalizeTrimmedString(sessionId);
    if (!normalizedSessionId) return null;

    const cached = readCachedSessionListLookupSessionFromState(state, normalizedSessionId);
    if (cached !== undefined) {
        return cached;
    }

    const entry = resolveSessionListLookupSessionEntryFromState(state, normalizedSessionId);
    return writeCachedSessionListLookupSessionToState(state, normalizedSessionId, entry);
}

export function listSessionListLookupActiveSessions(
    state: SessionListLookupStateLike,
): SessionListLookupSessionEntry[] {
    const indexByServerId = state?.sessionListIndexByServerId ?? {};
    const activeServerId = resolvePreferredSessionListIndexServerIdFromIndex(indexByServerId);
    if (!activeServerId) return EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSIONS;

    const items = indexByServerId[activeServerId];
    if (!Array.isArray(items) || items.length === 0) return EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSIONS;

    const out: SessionListLookupSessionEntry[] = [];
    for (const item of items) {
        if (item.type !== 'session') continue;
        const sessionId = normalizeTrimmedString(item.sessionId);
        if (!sessionId) continue;
        const session = state?.sessionListRenderables?.[sessionId]
            ?? findConcurrentSessionListCacheSession(state?.concurrentSessionListCacheByServerId, sessionId)?.session
            ?? null;
        if (!session) continue;
        out.push({
            serverId: normalizeTrimmedString(item.serverId) || activeServerId,
            serverName: normalizeTrimmedString(item.serverName) || null,
            session,
        });
    }

    return out.length === 0 ? EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSIONS : out;
}

export function listSessionListLookupServerSessions(
    state: SessionListLookupStateLike,
): ReturnType<typeof listConcurrentSessionListCacheSessions> {
    return listConcurrentSessionListCacheSessions(state?.concurrentSessionListCacheByServerId);
}

export function listSessionListLookupServers(
    state: SessionListLookupStateLike,
): ReturnType<typeof listConcurrentSessionListCacheServers> {
    return listConcurrentSessionListCacheServers(state?.concurrentSessionListCacheByServerId);
}

export function listSessionListLookupActiveSessionIds(
    state: SessionListLookupStateLike,
    limit?: number,
): string[] {
    const indexByServerId = state?.sessionListIndexByServerId ?? {};
    const activeServerId = resolvePreferredSessionListIndexServerIdFromIndex(indexByServerId);
    if (!activeServerId) return EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSION_IDS;

    const items = indexByServerId[activeServerId];
    if (!Array.isArray(items) || items.length === 0) return EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSION_IDS;

    const ids: string[] = [];
    for (const item of items) {
        if (item.type !== 'session') continue;
        const sessionId = normalizeTrimmedString(item.sessionId);
        if (!sessionId) continue;
        ids.push(sessionId);
        if (typeof limit === 'number' && limit >= 0 && ids.length >= limit) {
            break;
        }
    }

    return ids.length === 0 ? EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSION_IDS : ids;
}

export function resolveSessionListLookupSessionServerId(
    state: SessionListLookupStateLike,
    sessionId: string,
): string | null {
    const normalizedSessionId = normalizeTrimmedString(sessionId);
    if (!normalizedSessionId) return null;

    const cached = readCachedSessionListLookupSessionServerIdFromState(state, normalizedSessionId);
    if (cached !== undefined) {
        return cached;
    }

    const directServerId = normalizeTrimmedString((state as SessionServerLookupStateLike)?.sessions?.[normalizedSessionId]?.serverId);
    if (directServerId) {
        return writeCachedSessionListLookupSessionServerIdToState(state, normalizedSessionId, directServerId);
    }

    const scopedServerId = resolveSessionListLookupSessionServerScopeFromState(state, normalizedSessionId)?.serverId ?? null;
    return writeCachedSessionListLookupSessionServerIdToState(state, normalizedSessionId, scopedServerId);
}

export function resolveSessionListPreferredServerIdFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
    fallbackServerId?: string | null | undefined,
): string | null {
    const normalizedFallbackServerId = normalizeTrimmedString(fallbackServerId);
    const normalizedSessionId = normalizeTrimmedString(sessionId);
    if (!normalizedSessionId) return null;

    const cached = readMemoizedPreferredSessionListServerIdFromState(state, normalizedSessionId, normalizedFallbackServerId);
    if (cached !== undefined) {
        return cached;
    }

    const concurrentCachedServerId = normalizeTrimmedString(findConcurrentSessionListCacheSession(
        state?.concurrentSessionListCacheByServerId,
        normalizedSessionId,
    )?.serverId);
    const directServerId = normalizeTrimmedString(state?.sessions?.[normalizedSessionId]?.serverId);
    if (directServerId) {
        const directMatchesFallbackServer = directServerId !== null && directServerId === normalizedFallbackServerId;
        if (
            concurrentCachedServerId
            && normalizedFallbackServerId
            && concurrentCachedServerId !== normalizedFallbackServerId
            && directMatchesFallbackServer
        ) {
            return concurrentCachedServerId;
        }

        return writeMemoizedPreferredSessionListServerIdToState(
            state,
            normalizedSessionId,
            normalizedFallbackServerId,
            directServerId,
        );
    }

    const cachedScope = resolveSessionListLookupSessionServerScopeFromState(state, normalizedSessionId);
    const activeCachedServerId = normalizeTrimmedString(cachedScope?.serverId);

    // If the active session record still mirrors the active server but a server-scoped cache row
    // has already converged on a different owner, prefer the owner so route hydration can fetch
    // the exact server-scoped session state that exposes the session page affordances.
    const activeMatchesFallbackServer = activeCachedServerId !== null && activeCachedServerId === normalizedFallbackServerId;
    if (
        concurrentCachedServerId
        && normalizedFallbackServerId
        && concurrentCachedServerId !== normalizedFallbackServerId
        && (!directServerId && activeMatchesFallbackServer)
    ) {
        return concurrentCachedServerId;
    }

    const resolvedServerId = directServerId
        || activeCachedServerId
        || concurrentCachedServerId
        || normalizedFallbackServerId;
    return writeMemoizedPreferredSessionListServerIdToState(
        state,
        normalizedSessionId,
        normalizedFallbackServerId,
        resolvedServerId || null,
    );
}

export function resolveSessionListPreferredSessionMetadataFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
): SessionMetadataLike {
    const normalizedSessionId = normalizeTrimmedString(sessionId);
    if (!normalizedSessionId) return null;

    const cached = readMemoizedPreferredSessionListMetadataFromState(state, normalizedSessionId);
    if (cached !== undefined) {
        return cached;
    }

    const directSession = state?.sessions?.[normalizedSessionId];
    const directMetadataValue = directSession && typeof directSession === 'object'
        ? directSession.metadata
        : null;
    const directMetadata = directMetadataValue && typeof directMetadataValue === 'object'
        ? directMetadataValue
        : null;
    const cachedSession = findSessionListLookupSession(state, normalizedSessionId);

    const cachedMetadata = cachedSession?.session?.metadata;
    if (cachedMetadata && typeof cachedMetadata === 'object') {
        return writeMemoizedPreferredSessionListMetadataToState(
            state,
            normalizedSessionId,
            mergeCachedSessionMetadataWithCanonicalMachineId(
                cachedMetadata as SessionMetadataLike,
                directMetadata as SessionMetadataLike,
            ),
        );
    }

    return writeMemoizedPreferredSessionListMetadataToState(
        state,
        normalizedSessionId,
        directMetadata as SessionMetadataLike,
    );
}
