import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { importLegacySessionOrganization as importLegacySessionOrganizationApi } from '@/sync/api/session/sessionOrganizationApi';
import type { ImportLegacySessionOrganizationRequest } from '@happier-dev/protocol';

import { fetchAndApplySessionOrganizationSnapshot } from './fetchSessionOrganizationSnapshot';
import { prepareSessionOrganizationDisplayEnvelopeForWrite } from './sessionOrganizationDisplayEnvelope';

export type LegacySessionTagAssignmentImport = Readonly<{
    sessionId: string;
    tagIds: readonly string[];
}>;

export async function importLegacySessionOrganization(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    request: ImportLegacySessionOrganizationRequest;
}>): Promise<void> {
    const request: ImportLegacySessionOrganizationRequest = {
        ...params.request,
        folders: await Promise.all(params.request.folders.map(async (folder) => ({
            ...folder,
            display: await prepareSessionOrganizationDisplayEnvelopeForWrite({
                credentials: params.credentials,
                envelope: folder.display,
            }),
        }))),
        tags: await Promise.all(params.request.tags.map(async (tag) => ({
            ...tag,
            display: await prepareSessionOrganizationDisplayEnvelopeForWrite({
                credentials: params.credentials,
                envelope: tag.display,
            }),
        }))),
        labels: await Promise.all(params.request.labels.map(async (label) => ({
            ...label,
            display: await prepareSessionOrganizationDisplayEnvelopeForWrite({
                credentials: params.credentials,
                envelope: label.display,
            }),
        }))),
    };
    await importLegacySessionOrganizationApi({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        request,
    });

    await fetchAndApplySessionOrganizationSnapshot({
        credentials: params.credentials,
        serverId: params.serverId,
        serverUrl: params.serverUrl,
        request: {
            includeFolders: true,
            includeTags: true,
            includeLabels: true,
            includeAllTagAssignments: true,
        },
    });
}
