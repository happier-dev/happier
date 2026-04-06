import { normalizeTrimmedString } from './normalizeTrimmedString';

export type NormalizedSessionListServerScope = Readonly<{
    serverId: string | null;
    serverName: string | null;
}>;

const EMPTY_NORMALIZED_SESSION_LIST_SERVER_SCOPE: NormalizedSessionListServerScope = {
    serverId: null,
    serverName: null,
};

const NORMALIZED_SESSION_LIST_SERVER_SCOPE_BY_KEY = new Map<string, NormalizedSessionListServerScope>();

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
