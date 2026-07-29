import { areServerProfileIdentifiersEquivalent } from '../../server/serverProfiles';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import type { SessionListRenderableSession } from './sessionListRenderable';

export type SessionListRowStateByServerId =
    Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;

export function readSessionListRowsForServerId(
    rowsByServerId: SessionListRowStateByServerId | null | undefined,
    serverIdRaw: string | null | undefined,
): Readonly<Record<string, SessionListRenderableSession>> | null {
    const serverId = normalizeTrimmedString(serverIdRaw);
    if (!rowsByServerId || !serverId) return null;
    const exact = rowsByServerId[serverId];
    if (exact && typeof exact === 'object') return exact;
    for (const candidateServerId of Object.keys(rowsByServerId)) {
        if (!areServerProfileIdentifiersEquivalent(candidateServerId, serverId)) continue;
        const rows = rowsByServerId[candidateServerId];
        return rows && typeof rows === 'object' ? rows : null;
    }
    return null;
}

export function readSessionListRowForServerId(
    rowsByServerId: SessionListRowStateByServerId | null | undefined,
    serverIdRaw: string | null | undefined,
    sessionIdRaw: string | null | undefined,
): SessionListRenderableSession | null {
    const sessionId = normalizeTrimmedString(sessionIdRaw);
    if (!sessionId) return null;
    return readSessionListRowsForServerId(rowsByServerId, serverIdRaw)?.[sessionId] ?? null;
}
