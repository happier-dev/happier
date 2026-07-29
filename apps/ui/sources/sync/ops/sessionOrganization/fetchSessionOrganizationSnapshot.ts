import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchSessionOrganizationSnapshot } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { SessionOrganizationSnapshotRequest } from '@happier-dev/protocol';
import { openSessionOrganizationSnapshotDisplayEnvelopes } from './sessionOrganizationDisplayEnvelope';

export async function fetchAndApplySessionOrganizationSnapshot(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    request?: Partial<SessionOrganizationSnapshotRequest>;
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const store = getStorage().getState();
    store.setSessionOrganizationLoading(params.serverId, true);
    store.setSessionOrganizationError(params.serverId, null);
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
        getStorage().getState().applySessionOrganizationSnapshot(
            params.serverId,
            snapshot,
            params.request,
        );
    } catch (error) {
        getStorage().getState().setSessionOrganizationError(
            params.serverId,
            error instanceof Error ? error.message : 'Failed to fetch session organization snapshot',
        );
        throw error;
    } finally {
        if (!params.shouldContinue || params.shouldContinue()) {
            getStorage().getState().setSessionOrganizationLoading(params.serverId, false);
        }
    }
}
