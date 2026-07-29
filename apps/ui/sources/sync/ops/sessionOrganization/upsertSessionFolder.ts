import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { upsertSessionOrganizationFolder as upsertSessionOrganizationFolderApi } from '@/sync/api/session/sessionOrganizationApi';
import { readSessionOrganizationServerScopedId } from '@/sync/domains/session/organization';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { CreateOrUpdateSessionOrganizationFolderRequest } from '@happier-dev/protocol';
import { createSessionOrganizationOpaqueId } from './sessionOrganizationIdAllocation';
import {
    openSessionOrganizationFolderDisplay,
    prepareSessionOrganizationDisplayEnvelopeForWrite,
} from './sessionOrganizationDisplayEnvelope';

type ConcreteSessionOrganizationFolderRequest = CreateOrUpdateSessionOrganizationFolderRequest & {
    folderId: string;
};

function readCurrentFolderIds(serverId: string): Set<string> {
    const state = getStorage().getState();
    const ids = new Set<string>();
    for (const key of Object.keys(state.sessionOrganizationFoldersByFolderKey)) {
        const id = readSessionOrganizationServerScopedId(key, serverId);
        if (id) ids.add(id);
    }
    return ids;
}

export async function upsertSessionFolder(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    request: CreateOrUpdateSessionOrganizationFolderRequest;
}>): Promise<void> {
    const request: ConcreteSessionOrganizationFolderRequest = {
        ...params.request,
        folderId: params.request.folderId ?? createSessionOrganizationOpaqueId({
            prefix: 'folder',
            usedIds: readCurrentFolderIds(params.serverId),
        }),
        display: await prepareSessionOrganizationDisplayEnvelopeForWrite({
            credentials: params.credentials,
            envelope: params.request.display,
        }),
    };
    const response = await upsertSessionOrganizationFolderApi({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        request,
    });
    const folder = await openSessionOrganizationFolderDisplay({
        credentials: params.credentials,
        folder: response.folder,
    });
    const recordId = getStorage().getState().upsertSessionOrganizationFolderOptimistic(params.serverId, folder);
    getStorage().getState().commitSessionOrganizationOptimistic(recordId);
}
