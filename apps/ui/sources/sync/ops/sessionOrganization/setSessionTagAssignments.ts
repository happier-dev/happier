import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { setSessionTagAssignments as setSessionTagAssignmentsApi } from '@/sync/api/session/sessionOrganizationApi';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { MutateSessionTagAssignmentsRequest, SetSessionTagAssignmentsResponse } from '@happier-dev/protocol/sessions/organization/mutations';

export async function setSessionTagAssignments(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
    sessionId: string;
} & (Readonly<{ tagIds: readonly string[] }> | Readonly<{ addTagIds: readonly string[]; removeTagIds: readonly string[] }> )>): Promise<SetSessionTagAssignmentsResponse> {
    params.assertCurrent?.();
    const request: MutateSessionTagAssignmentsRequest = 'tagIds' in params ? { tagIds: [...params.tagIds] }
        : { addTagIds: [...params.addTagIds], removeTagIds: [...params.removeTagIds] };
    const current = getStorage().getState().sessionOrganizationTagAssignmentsBySessionKey[
        buildSessionOrganizationSessionKey(params.serverId, params.sessionId)]?.tagIds ?? [];
    const optimisticIds = 'tagIds' in request ? request.tagIds
        : [...new Set([...current.filter(id => !request.removeTagIds.includes(id)), ...request.addTagIds])];
    const recordId = getStorage().getState().setSessionTagAssignmentsOptimistic(params.serverId, params.sessionId, optimisticIds);
    try {
        const response = await setSessionTagAssignmentsApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            requestAtEndpoint: params.requestAtEndpoint,
            sessionId: params.sessionId,
            request,
        });
        params.assertCurrent?.();
        // Same rule as the pin and reminder writes: confirm this response's own key instead of
        // republishing it over a newer tag change that is still in flight for this Session.
        getStorage().getState().confirmSessionOrganizationOptimistic(
            recordId,
            'sessionOrganizationTagAssignmentsBySessionKey',
            buildSessionOrganizationSessionKey(params.serverId, params.sessionId),
            { sessionId: response.sessionId, tagIds: [...response.tagIds] },
        );
        return response;
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}
