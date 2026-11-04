import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { SessionSelectionCandidate } from './projectSessionSelectionRows';

export function isWritableSessionSelectionCandidate(session: SessionSelectionCandidate): boolean {
    return session.access?.capabilities.submitAgentInput === true && isUserFacingSession(session);
}

export function readSessionListIndexSessionItems(
    byServer: Readonly<Record<string, readonly SessionListIndexItem[] | null | undefined>>,
): Extract<SessionListIndexItem, { type: 'session' }>[] {
    const out: Extract<SessionListIndexItem, { type: 'session' }>[] = [];
    for (const [serverId, items] of Object.entries(byServer)) {
        if (!serverId.trim() || !Array.isArray(items)) continue;
        for (const item of items) {
            if (item.type === 'session') out.push(item.serverId ? item : { ...item, serverId });
        }
    }
    return out;
}

export function collectSessionSelectionCandidates(input: Readonly<{
    sessions: readonly Session[];
    sessionListItems: readonly Extract<SessionListIndexItem, { type: 'session' }>[];
    readRow: (serverId: string, sessionId: string) => SessionListRenderableSession | null | undefined;
}>): SessionSelectionCandidate[] {
    const targets: SessionSelectionCandidate[] = [];
    const seen = new Set<string>();
    const append = (session: Session | SessionListRenderableSession, serverId: string | null | undefined) => {
        const normalizedServerId = serverId?.trim();
        if (!session.id.trim() || !normalizedServerId) return;
        const key = sessionAddressKey({ serverId: normalizedServerId, sessionId: session.id });
        if (seen.has(key)) return;
        seen.add(key);
        if (isUserFacingSession(session)) targets.push({ ...session, serverId: normalizedServerId });
    };
    for (const item of input.sessionListItems) {
        if (!item.serverId) continue;
        const row = input.readRow(item.serverId, item.sessionId);
        if (row) append(row, item.serverId);
    }
    for (const session of input.sessions) {
        append(session, session.serverId ?? resolveServerIdForSessionIdFromLocalCache(session.id));
    }
    return targets;
}
