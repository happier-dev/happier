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
    request: UpsertSessionOrganizationLabelRequest;
}>): Promise<void> {
    const request: UpsertSessionOrganizationLabelRequest = {
        ...params.request,
        display: await prepareSessionOrganizationDisplayEnvelopeForWrite({
            credentials: params.credentials,
            envelope: params.request.display,
        }),
    };
    const openedDisplay = await openSessionOrganizationDisplayEnvelope({
        credentials: params.credentials,
        envelope: request.display,
    });
    const recordId = getStorage().getState().upsertSessionOrganizationLabelOptimistic(params.serverId, {
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
            request,
        });
        getStorage().getState().commitSessionOrganizationOptimistic(recordId);
        const label = await openSessionOrganizationLabelDisplay({
            credentials: params.credentials,
            label: response.label,
        });
        const reconcileRecordId = getStorage().getState().upsertSessionOrganizationLabelOptimistic(params.serverId, label);
        getStorage().getState().commitSessionOrganizationOptimistic(reconcileRecordId);
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}
