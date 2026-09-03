import { SESSION_ORGANIZATION_MAX_PINNED_SESSIONS } from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { setSessionPin as setSessionPinApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

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
