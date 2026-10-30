import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { upsertSessionOrganizationFolder as upsertSessionOrganizationFolderApi } from '@/sync/api/session/sessionOrganizationApi';
import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { UiSessionOrganizationFolder } from '@/sync/domains/session/organization';
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
    for (const [key, folder] of Object.entries(state.sessionOrganizationFoldersByFolderKey)) {
        if (key === buildSessionOrganizationServerKey(serverId, folder.folderId)) ids.add(folder.folderId);
    }
    return ids;
}

export function allocateSessionOrganizationFolderId(serverId: string): string {
    return createSessionOrganizationOpaqueId({ prefix: 'folder', usedIds: readCurrentFolderIds(serverId) });
}

export async function upsertSessionFolder(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
    request: CreateOrUpdateSessionOrganizationFolderRequest;
}>): Promise<UiSessionOrganizationFolder> {
    params.assertCurrent?.();
    const request: ConcreteSessionOrganizationFolderRequest = {
        ...params.request,
        folderId: params.request.folderId ?? allocateSessionOrganizationFolderId(params.serverId),
        display: await prepareSessionOrganizationDisplayEnvelopeForWrite({
            credentials: params.credentials,
            envelope: params.request.display,
            request: params.requestAtEndpoint,
        }),
    };
    params.assertCurrent?.();
    const response = await upsertSessionOrganizationFolderApi({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        requestAtEndpoint: params.requestAtEndpoint,
        request,
    });
    const folder = await openSessionOrganizationFolderDisplay({
        credentials: params.credentials,
        folder: response.folder,
    });
    params.assertCurrent?.();
    const recordId = getStorage().getState().upsertSessionOrganizationFolderOptimistic(params.serverId, folder);
    getStorage().getState().commitSessionOrganizationOptimistic(recordId);
    return folder;
}
