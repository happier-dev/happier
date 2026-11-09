import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { importLegacySessionOrganization as importLegacySessionOrganizationApi } from '@/sync/api/session/sessionOrganizationApi';
import type { ImportLegacySessionOrganizationRequest } from '@happier-dev/protocol/sessions/organization/mutations';

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
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    accountMode?: 'plain' | 'e2ee';
    request: ImportLegacySessionOrganizationRequest;
}>): Promise<void> {
    const request: ImportLegacySessionOrganizationRequest = {
        ...params.request,
        folders: await Promise.all(params.request.folders.map(async (folder) => ({
            ...folder,
            display: await prepareSessionOrganizationDisplayEnvelopeForWrite({
                credentials: params.credentials,
                serverUrl: params.serverUrl,
                envelope: folder.display,
                accountMode: params.accountMode,
                request: params.requestAtEndpoint,
            }),
        }))),
        tags: await Promise.all(params.request.tags.map(async (tag) => ({
            ...tag,
            display: await prepareSessionOrganizationDisplayEnvelopeForWrite({
                credentials: params.credentials,
                serverUrl: params.serverUrl,
                envelope: tag.display,
                accountMode: params.accountMode,
                request: params.requestAtEndpoint,
            }),
        }))),
        labels: await Promise.all(params.request.labels.map(async (label) => ({
            ...label,
            display: await prepareSessionOrganizationDisplayEnvelopeForWrite({
                credentials: params.credentials,
                serverUrl: params.serverUrl,
                envelope: label.display,
                accountMode: params.accountMode,
                request: params.requestAtEndpoint,
            }),
        }))),
    };
    await importLegacySessionOrganizationApi({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        requestAtEndpoint: params.requestAtEndpoint,
        request,
    });

    await fetchAndApplySessionOrganizationSnapshot({
        credentials: params.credentials,
        serverId: params.serverId,
        serverUrl: params.serverUrl,
        requestAtEndpoint: params.requestAtEndpoint,
        request: {
            includeFolders: true,
            includeTags: true,
            includeLabels: true,
            includeAllTagAssignments: true,
        },
    });
}
