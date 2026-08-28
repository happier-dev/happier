import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { upsertSessionOrganizationTag as upsertSessionOrganizationTagApi } from '@/sync/api/session/sessionOrganizationApi';
import { readSessionOrganizationServerScopedId } from '@/sync/domains/session/organization';
import type { UiSessionOrganizationTag } from '@/sync/domains/session/organization';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { CreateOrUpdateSessionOrganizationTagRequest } from '@happier-dev/protocol';
import { createSessionOrganizationOpaqueId } from './sessionOrganizationIdAllocation';
import {
    openSessionOrganizationTagDisplay,
    prepareSessionOrganizationDisplayEnvelopeForWrite,
} from './sessionOrganizationDisplayEnvelope';

type ConcreteSessionOrganizationTagRequest = CreateOrUpdateSessionOrganizationTagRequest & {
    tagId: string;
};

function readCurrentTagIds(serverId: string): Set<string> {
    const state = getStorage().getState();
    const ids = new Set<string>();
    for (const key of Object.keys(state.sessionOrganizationTagsByTagKey)) {
        const id = readSessionOrganizationServerScopedId(key, serverId);
        if (id) ids.add(id);
    }
    return ids;
}

export async function upsertSessionTag(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    request: CreateOrUpdateSessionOrganizationTagRequest;
}>): Promise<UiSessionOrganizationTag> {
    const request: ConcreteSessionOrganizationTagRequest = {
        ...params.request,
        tagId: params.request.tagId ?? createSessionOrganizationOpaqueId({
            prefix: 'tag',
            usedIds: readCurrentTagIds(params.serverId),
        }),
        display: await prepareSessionOrganizationDisplayEnvelopeForWrite({
            credentials: params.credentials,
            envelope: params.request.display,
        }),
    };
    const response = await upsertSessionOrganizationTagApi({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        request,
    });
    const tag = await openSessionOrganizationTagDisplay({
        credentials: params.credentials,
        tag: response.tag,
    });
    const recordId = getStorage().getState().upsertSessionOrganizationTagOptimistic(params.serverId, tag);
    getStorage().getState().commitSessionOrganizationOptimistic(recordId);
    return tag;
}

export async function createSessionOrganizationTagWithLabel(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    label: string;
    usedIds?: ReadonlySet<string>;
}>): Promise<UiSessionOrganizationTag> {
    const label = params.label.trim();
    if (!label) throw new Error('Session organization tag label is required');
    const tagId = createSessionOrganizationOpaqueId({
        prefix: 'tag',
        usedIds: params.usedIds ?? readCurrentTagIds(params.serverId),
    });
    return upsertSessionTag({
        credentials: params.credentials,
        serverId: params.serverId,
        serverUrl: params.serverUrl,
        request: {
            tagId,
            tagKey: tagId,
            sortKey: null,
            display: { t: 'plain', v: { label } },
        },
    });
}
