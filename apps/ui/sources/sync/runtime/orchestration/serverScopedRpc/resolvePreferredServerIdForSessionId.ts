import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveSessionListPreferredServerIdFromState } from '@/sync/domains/session/listing/sessionListCacheState';
import { storage } from '@/sync/domains/state/storage';

export function resolvePreferredServerIdForSessionId(sessionId: string): string | undefined {
    const state = storage.getState();
    return (
        resolveSessionListPreferredServerIdFromState(state, sessionId, getActiveServerSnapshot().serverId)
        ?? undefined
    );
}
