import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchSessionOrganizationSnapshot } from '@/sync/api/session/sessionOrganizationApi';
import { isHomeCredentialCurrent, readHomeAccountReadRevision } from '@/sync/runtime/orchestration/homeAccountChange';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { UiSessionOrganizationSnapshot } from '@/sync/domains/session/organization';
import type { SessionOrganizationSnapshotRequest } from '@happier-dev/protocol/sessions/organization/snapshot';
import { openSessionOrganizationSnapshotDisplayEnvelopes } from './sessionOrganizationDisplayEnvelope';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';

type SharedSnapshotRead = Readonly<{ snapshot: UiSessionOrganizationSnapshot; received: boolean }>;
/** Concurrent readers of one Account request (Sync's list, reminder inventory) share one settled read. */
const snapshotReads = createScopedResolutionSingleFlight<SharedSnapshotRead>();

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
    // A Home wake advances the read revision, so demand after a change never joins an older read.
    const key = JSON.stringify([resolveServerProfileScopeIdForIdentifier(params.serverId),
        resolveAuthCredentialsScopeKey(params.credentials), readHomeAccountReadRevision(params.serverId), params.request ?? null]);
    if (params.shouldContinue && !params.shouldContinue()) return null;
    const { snapshot, received } = await snapshotReads.run(key, () => readSnapshot(params));
    if (params.shouldContinue && !params.shouldContinue()) return null;
    // Its version is that Account's, so a late answer would also block the next one.
    if (!isHomeCredentialCurrent(params.serverId, params.credentials)) return null;
    // Older route compatibility may return a synthetic empty body. It proves neither
    // membership nor absence, and must not clear retained values or seed known-null entries.
    if (received) {
        // Each still-current caller applies; an equal snapshot publishes nothing new.
        getStorage().getState().applySessionOrganizationSnapshot(params.serverId, snapshot, params.request);
        params.onSnapshotReceived?.();
    }
    return snapshot;
}

async function readSnapshot(params: Parameters<typeof fetchAndApplySessionOrganizationSnapshot>[0]): Promise<SharedSnapshotRead> {
    let snapshotReceived = false;
    const response = await fetchSessionOrganizationSnapshot({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        requestAtEndpoint: params.requestAtEndpoint,
        request: params.request,
        onSnapshotReceived: () => { snapshotReceived = true; },
    });
    const snapshot = await openSessionOrganizationSnapshotDisplayEnvelopes({
        credentials: params.credentials,
        snapshot: response.snapshot,
    });
    return { snapshot, received: snapshotReceived };
}
