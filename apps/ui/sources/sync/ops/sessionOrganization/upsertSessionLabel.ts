import { sessionOrganizationStoreFor } from './sessionOrganizationAccountStore';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { upsertSessionOrganizationLabel as upsertSessionOrganizationLabelApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { UpsertSessionOrganizationLabelRequest } from '@happier-dev/protocol';
import {
    openSessionOrganizationDisplayEnvelope,
    openSessionOrganizationLabelDisplay,
    prepareSessionOrganizationDisplayEnvelopeForWrite,
} from './sessionOrganizationDisplayEnvelope';

export async function upsertSessionLabel(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
    request: UpsertSessionOrganizationLabelRequest;
}>): Promise<void> {
    params.assertCurrent?.();
    const request: UpsertSessionOrganizationLabelRequest = {
        ...params.request,
        display: await prepareSessionOrganizationDisplayEnvelopeForWrite({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            request: params.requestAtEndpoint,
            envelope: params.request.display,
        }),
    };
    const openedDisplay = await openSessionOrganizationDisplayEnvelope({
        credentials: params.credentials,
        envelope: request.display,
    });
    params.assertCurrent?.();
    const recordId = sessionOrganizationStoreFor(params).upsertSessionOrganizationLabelOptimistic(params.serverId, {
        labelKind: request.labelKind,
        scopeKey: request.scopeKey,
        display: openedDisplay.envelope,
        displayState: openedDisplay.displayState,
        archivedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });
    try {
        const response = await upsertSessionOrganizationLabelApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            requestAtEndpoint: params.requestAtEndpoint,
            request,
        });
        const label = await openSessionOrganizationLabelDisplay({
            credentials: params.credentials,
            label: response.label,
        });
        params.assertCurrent?.();
        sessionOrganizationStoreFor(params).commitSessionOrganizationOptimistic(recordId);
        const reconcileRecordId = sessionOrganizationStoreFor(params).upsertSessionOrganizationLabelOptimistic(params.serverId, label);
        sessionOrganizationStoreFor(params).commitSessionOrganizationOptimistic(reconcileRecordId);
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}
