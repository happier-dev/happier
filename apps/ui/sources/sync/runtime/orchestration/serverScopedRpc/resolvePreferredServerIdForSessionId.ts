import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveSessionListCachedSessionServerIdFromState } from '@/sync/domains/session/listing/sessionListCacheState';
import { storage } from '@/sync/domains/state/storage';
import { normalizeServerId } from './normalizeServerId';

export function resolvePreferredServerIdForSessionId(sessionId: string): string | undefined {
    const state = storage.getState();
    return (
        normalizeServerId(resolveSessionListCachedSessionServerIdFromState({
            sessions: state.sessions,
            sessionListViewData: state.sessionListViewData,
            sessionListViewDataByServerId: state.sessionListViewDataByServerId,
        }, sessionId))
        ?? normalizeServerId(getActiveServerSnapshot().serverId) ?? undefined
    );
}
