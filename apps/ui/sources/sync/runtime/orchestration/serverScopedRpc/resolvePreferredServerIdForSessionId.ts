import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    resolveSessionListLookupSessionServerScopeFromState,
    resolveSessionListPreferredServerIdFromState,
} from '@/sync/domains/session/listing/sessionListLookupState';
import { storage } from '@/sync/domains/state/storage';

export function resolvePreferredServerIdForSessionId(sessionId: string): string | undefined {
    const state = storage.getState();
    const activeServerId = getActiveServerSnapshot().serverId;

    // Only return a server id when we have evidence that the session can be mapped to a server
    // (direct session record or session-list lookup rows). Otherwise return `undefined` so
    // call sites can apply an explicit fallback (e.g. active server, route server id, etc.).
    const cachedScope = resolveSessionListLookupSessionServerScopeFromState(state, sessionId);
    if (!cachedScope?.serverId) {
        return undefined;
    }
    return (
        resolveSessionListPreferredServerIdFromState(state, sessionId, activeServerId)
        ?? undefined
    );
}
