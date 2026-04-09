import { normalizeTrimmedString } from './normalizeTrimmedString';

import { LruMap } from '@/utils/cache/lruMap';

export type NormalizedSessionListServerScope = Readonly<{
    serverId: string | null;
    serverName: string | null;
}>;

const EMPTY_NORMALIZED_SESSION_LIST_SERVER_SCOPE: NormalizedSessionListServerScope = {
    serverId: null,
    serverName: null,
};

function readMaxNormalizedSessionListServerScopeCacheEntriesFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_LIST_SERVER_SCOPE_CACHE_MAX ?? '').trim();
    if (!raw) return 1024;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 1024;
    return Math.max(1, Math.min(100_000, parsed));
}

const NORMALIZED_SESSION_LIST_SERVER_SCOPE_BY_KEY = new LruMap<string, NormalizedSessionListServerScope>({
    maxEntries: readMaxNormalizedSessionListServerScopeCacheEntriesFromEnv(),
});

export function normalizeSessionListServerScope(
    serverIdRaw: unknown,
    serverNameRaw: unknown,
): NormalizedSessionListServerScope {
    const serverId = normalizeTrimmedString(serverIdRaw) || null;
    const serverName = normalizeTrimmedString(serverNameRaw) || null;

    if (serverId === null && serverName === null) {
        return EMPTY_NORMALIZED_SESSION_LIST_SERVER_SCOPE;
    }

    const cacheKey = `${serverId ?? ''}\u0000${serverName ?? ''}`;
    const cachedScope = NORMALIZED_SESSION_LIST_SERVER_SCOPE_BY_KEY.get(cacheKey);
    if (cachedScope) {
        return cachedScope;
    }

    const normalizedScope = {
        serverId,
        serverName,
    };
    NORMALIZED_SESSION_LIST_SERVER_SCOPE_BY_KEY.set(cacheKey, normalizedScope);
    return normalizedScope;
}
