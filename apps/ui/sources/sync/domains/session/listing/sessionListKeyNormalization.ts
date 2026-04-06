import { normalizeTrimmedString } from './normalizeTrimmedString';

export const EMPTY_SESSION_LIST_SERVER_KEY = '__unknown_server__';

export type NormalizedSessionListKeyParts = Readonly<{
    serverId: string;
    sessionId: string;
    serverKey: string;
    sessionKey: string | null;
}>;

export function normalizeSessionListKeyParts(
    serverIdRaw: unknown,
    sessionIdRaw?: unknown,
): NormalizedSessionListKeyParts {
    const serverId = normalizeTrimmedString(serverIdRaw);
    const sessionId = normalizeTrimmedString(sessionIdRaw);
    return {
        serverId,
        sessionId,
        serverKey: serverId || EMPTY_SESSION_LIST_SERVER_KEY,
        sessionKey: serverId && sessionId ? `${serverId}:${sessionId}` : null,
    };
}

export function normalizeSessionListServerKey(serverIdRaw: unknown): string {
    return normalizeSessionListKeyParts(serverIdRaw).serverKey;
}

export function normalizeSessionListSessionKey(
    serverIdRaw: unknown,
    sessionIdRaw: unknown,
): string | null {
    return normalizeSessionListKeyParts(serverIdRaw, sessionIdRaw).sessionKey;
}
