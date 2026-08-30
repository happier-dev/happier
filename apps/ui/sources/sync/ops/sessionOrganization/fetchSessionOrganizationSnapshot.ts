import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchSessionOrganizationSnapshot } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { SessionOrganizationSnapshotRequest } from '@happier-dev/protocol';
import { openSessionOrganizationSnapshotDisplayEnvelopes } from './sessionOrganizationDisplayEnvelope';

export async function fetchAndApplySessionOrganizationSnapshot(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    request?: Partial<SessionOrganizationSnapshotRequest>;
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const requestedServerId = params.serverId.trim();
    const resolveCurrentServerId = () => (
        resolveServerProfileScopeIdForIdentifier(requestedServerId) || requestedServerId
    );
    const initialServerId = resolveCurrentServerId();
    let currentServerId = initialServerId;
    const store = getStorage().getState();
    store.setSessionOrganizationLoading(initialServerId, true);
    store.setSessionOrganizationError(initialServerId, null);
    try {
        const response = await fetchSessionOrganizationSnapshot({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            request: params.request,
        });
        if (params.shouldContinue && !params.shouldContinue()) return;
        const snapshot = await openSessionOrganizationSnapshotDisplayEnvelopes({
            credentials: params.credentials,
            snapshot: response.snapshot,
        });
        if (params.shouldContinue && !params.shouldContinue()) return;
        currentServerId = resolveCurrentServerId();
        if (currentServerId !== initialServerId) {
            getStorage().getState().setSessionOrganizationLoading(initialServerId, false);
            getStorage().getState().setSessionOrganizationLoading(currentServerId, true);
            getStorage().getState().setSessionOrganizationError(currentServerId, null);
        }
        getStorage().getState().applySessionOrganizationSnapshot(
            currentServerId,
            snapshot,
            params.request,
        );
    } catch (error) {
        currentServerId = resolveCurrentServerId();
        getStorage().getState().setSessionOrganizationError(
            currentServerId,
            error instanceof Error ? error.message : 'Failed to fetch session organization snapshot',
        );
        throw error;
    } finally {
        if (!params.shouldContinue || params.shouldContinue()) {
            getStorage().getState().setSessionOrganizationLoading(initialServerId, false);
            if (currentServerId !== initialServerId) {
                getStorage().getState().setSessionOrganizationLoading(currentServerId, false);
            }
        }
    }
}
