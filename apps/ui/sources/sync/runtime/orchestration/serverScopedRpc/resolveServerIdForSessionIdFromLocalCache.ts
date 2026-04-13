import { storage } from '@/sync/domains/state/storage';
import { findConcurrentSessionListCacheSession, type ConcurrentSessionListCacheByServerId } from '@/sync/domains/session/listing/concurrentSessionListCache';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

export function resolveServerIdForSessionIdFromLocalState(
    state: Readonly<{
        sessions?: Record<string, { serverId?: unknown } | null> | null | undefined;
        sessionListIndexByServerId?: Readonly<Record<string, SessionListIndexItem[] | null | undefined>> | null | undefined;
        concurrentSessionListCacheByServerId?: ConcurrentSessionListCacheByServerId | null | undefined;
    }>,
    sessionId: string,
): string | null {
    const sid = normalizeId(sessionId);
    if (!sid) return null;

    const direct = state.sessions?.[sid];
    const serverId = typeof direct?.serverId === 'string' ? normalizeId(direct.serverId) : '';
    if (serverId) return serverId;

    const concurrent = findConcurrentSessionListCacheSession(state.concurrentSessionListCacheByServerId, sid);
    if (concurrent?.serverId) return normalizeId(concurrent.serverId) || null;

    return resolveServerIdForSessionIdFromSessionListCache(state.sessionListIndexByServerId, sid);
}

export function resolveServerIdForSessionIdFromSessionListCache(
    sessionListIndexByServerId: Readonly<Record<string, SessionListIndexItem[] | null | undefined>> | null | undefined,
    sessionId: string,
): string | null {
    const sid = normalizeId(sessionId);
    if (!sid) return null;

    const byServer = sessionListIndexByServerId ?? {};
    for (const [serverId, items] of Object.entries(byServer)) {
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            if (!item || item.type !== 'session') continue;
            if (normalizeId(item.sessionId) === sid) return normalizeId(serverId) || null;
        }
    }
    return null;
}

export function resolveServerIdForSessionIdFromLocalCache(sessionId: string): string | null {
    const state = storage.getState();
    return resolveServerIdForSessionIdFromLocalState(
        {
            sessions: state.sessions,
            sessionListIndexByServerId: state.sessionListIndexByServerId,
            concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
        },
        sessionId,
    );
}
