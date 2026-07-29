import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { setSessionPin as setSessionPinApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';

export async function setSessionPin(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionId: string;
    pinned: boolean;
    sortKey?: string | null;
}>): Promise<void> {
    const optimisticPin = params.pinned
        ? { sessionId: params.sessionId, sortKey: params.sortKey ?? null, pinnedAt: Date.now() }
        : null;
    const recordId = getStorage().getState().setSessionPinOptimistic(params.serverId, params.sessionId, optimisticPin);
    try {
        const response = await setSessionPinApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            sessionId: params.sessionId,
            request: { pinned: params.pinned, sortKey: params.sortKey },
        });
        getStorage().getState().commitSessionOrganizationOptimistic(recordId);
        const reconcileRecordId = getStorage().getState().setSessionPinOptimistic(params.serverId, params.sessionId, response.pin);
        getStorage().getState().commitSessionOrganizationOptimistic(reconcileRecordId);
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}
