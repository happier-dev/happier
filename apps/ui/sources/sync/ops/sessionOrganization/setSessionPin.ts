import { SESSION_ORGANIZATION_MAX_PINNED_SESSIONS } from '@happier-dev/protocol/sessions/organization/constants';
import type { SetSessionPinRequest, SetSessionPinResponse } from '@happier-dev/protocol/sessions/organization/mutations';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { setSessionPin as setSessionPinApi } from '@/sync/api/session/sessionOrganizationApi';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import { getStorage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

export async function setSessionPin(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
    sessionId: string;
    pinned: boolean;
    surface?: SetSessionPinRequest['surface'];
    sortKey?: string | null;
}>): Promise<SetSessionPinResponse> {
    params.assertCurrent?.();
    const previous = getStorage().getState().sessionOrganizationPinsBySessionKey[
        buildSessionOrganizationSessionKey(params.serverId, params.sessionId)
    ];
    const listPinned = params.surface !== 'rail' ? params.pinned : previous?.listPinned === true;
    const railPinned = params.surface === 'rail' ? params.pinned : previous?.railPinned === true;
    const optimisticPin = listPinned || railPinned ? {
        sessionId: params.sessionId,
        sortKey: params.sortKey === undefined ? previous?.sortKey ?? null : params.sortKey,
        pinnedAt: previous?.pinnedAt ?? Date.now(),
        listPinned,
        railPinned,
    } : null;
    const recordId = getStorage().getState().setSessionPinOptimistic(params.serverId, params.sessionId, optimisticPin);
    try {
        const response = await setSessionPinApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            requestAtEndpoint: params.requestAtEndpoint,
            sessionId: params.sessionId,
            request: { pinned: params.pinned, surface: params.surface, sortKey: params.sortKey },
        });
        params.assertCurrent?.();
        // Same rule as every other organization write: confirm this response's own key instead
        // of republishing it over a newer pin change that is still in flight.
        getStorage().getState().confirmSessionOrganizationOptimistic(
            recordId,
            'sessionOrganizationPinsBySessionKey',
            buildSessionOrganizationSessionKey(params.serverId, params.sessionId),
            response.pin,
        );
        return response;
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        if (error instanceof HappyError && error.message === 'session-pin-limit-exceeded') {
            throw new HappyError(
                t('sessionInfo.pinLimitExceeded', { count: SESSION_ORGANIZATION_MAX_PINNED_SESSIONS }),
                false,
                { status: error.status, kind: error.kind, code: 'session-pin-limit-exceeded' },
            );
        }
        throw error;
    }
}
