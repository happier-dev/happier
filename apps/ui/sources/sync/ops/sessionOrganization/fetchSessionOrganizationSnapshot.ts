import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchSessionOrganizationSnapshot } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { UiSessionOrganizationSnapshot } from '@/sync/domains/session/organization';
import type { SessionOrganizationSnapshotRequest } from '@happier-dev/protocol';
import { openSessionOrganizationSnapshotDisplayEnvelopes } from './sessionOrganizationDisplayEnvelope';

export async function fetchAndApplySessionOrganizationSnapshot(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    request?: Partial<SessionOrganizationSnapshotRequest>;
    shouldContinue?: () => boolean;
    /** Runs only after a real response was admitted for the still-current Account. */
    onSnapshotReceived?: () => void;
}>): Promise<UiSessionOrganizationSnapshot | null> {
    const store = getStorage().getState();
    store.setSessionOrganizationLoading(params.serverId, true);
    store.setSessionOrganizationError(params.serverId, null);
    try {
        let snapshotReceived = false;
        const response = await fetchSessionOrganizationSnapshot({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            requestAtEndpoint: params.requestAtEndpoint,
            request: params.request,
            onSnapshotReceived: () => { snapshotReceived = true; },
        });
        if (params.shouldContinue && !params.shouldContinue()) return null;
        const snapshot = await openSessionOrganizationSnapshotDisplayEnvelopes({
            credentials: params.credentials,
            snapshot: response.snapshot,
        });
        if (params.shouldContinue && !params.shouldContinue()) return null;
        // Older route compatibility may return a synthetic empty body. It proves neither
        // membership nor absence, and must not clear retained values or seed known-null entries.
        if (snapshotReceived) {
            getStorage().getState().applySessionOrganizationSnapshot(params.serverId, snapshot, params.request);
            params.onSnapshotReceived?.();
        }
        return snapshot;
    } catch (error) {
        // A superseded request's failure belongs to the Account that sent it, not to
        // whichever Account now owns this Home's organization state.
        if (params.shouldContinue && !params.shouldContinue()) throw error;
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
