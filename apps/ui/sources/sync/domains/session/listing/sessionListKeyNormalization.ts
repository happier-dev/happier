import { normalizeTrimmedString } from './normalizeTrimmedString';

import { LruMap } from '@/utils/cache/lruMap';

export const EMPTY_SESSION_LIST_SERVER_KEY = '__unknown_server__';

export type NormalizedSessionListKeyParts = Readonly<{
    serverId: string;
    sessionId: string;
    serverKey: string;
    sessionKey: string | null;
}>;

const EMPTY_NORMALIZED_SESSION_LIST_KEY_PARTS: NormalizedSessionListKeyParts = {
    serverId: '',
    sessionId: '',
    serverKey: EMPTY_SESSION_LIST_SERVER_KEY,
    sessionKey: null,
};

function readMaxNormalizedSessionListKeyPartsCacheEntriesFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_LIST_KEY_PARTS_CACHE_MAX ?? '').trim();
    if (!raw) return 4096;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 4096;
    return Math.max(1, Math.min(100_000, parsed));
}

const NORMALIZED_SESSION_LIST_KEY_PARTS_CACHE = new LruMap<string, NormalizedSessionListKeyParts>({
    maxEntries: readMaxNormalizedSessionListKeyPartsCacheEntriesFromEnv(),
});

export function normalizeSessionListKeyParts(
    serverIdRaw: unknown,
    sessionIdRaw?: unknown,
): NormalizedSessionListKeyParts {
    const serverId = normalizeTrimmedString(serverIdRaw);
    const sessionId = normalizeTrimmedString(sessionIdRaw);
    if (!serverId && !sessionId) {
        return EMPTY_NORMALIZED_SESSION_LIST_KEY_PARTS;
    }

    const cacheKey = `${serverId}\u0000${sessionId}`;
    const cachedParts = NORMALIZED_SESSION_LIST_KEY_PARTS_CACHE.get(cacheKey);
    if (cachedParts) {
        return cachedParts;
    }

    const normalizedParts = {
        serverId,
        sessionId,
        serverKey: serverId || EMPTY_SESSION_LIST_SERVER_KEY,
        sessionKey: serverId && sessionId ? `${serverId}:${sessionId}` : null,
    };
    NORMALIZED_SESSION_LIST_KEY_PARTS_CACHE.set(cacheKey, normalizedParts);
    return normalizedParts;
}

export function buildSessionListServerScopedRowKey(
    serverIdRaw: unknown,
    sessionIdRaw?: unknown,
): string | null {
    const { serverId, sessionId } = normalizeSessionListKeyParts(serverIdRaw, sessionIdRaw);
    return serverId && sessionId ? `${serverId}\u0000${sessionId}` : null;
}

export function buildSessionListRowScopeKey(
    serverIdRaw: unknown,
    sessionIdRaw?: unknown,
): string | null {
    const { serverId, sessionId } = normalizeSessionListKeyParts(serverIdRaw, sessionIdRaw);
    if (!sessionId) return null;
    return serverId ? `${serverId}\u0000${sessionId}` : sessionId;
}
