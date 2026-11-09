import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { upsertSessionOrganizationTag as upsertSessionOrganizationTagApi } from '@/sync/api/session/sessionOrganizationApi';
import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization';
import type { UiSessionOrganizationTag } from '@/sync/domains/session/organization';
import { getStorage } from '@/sync/domains/state/storageStore';
import { sessionOrganizationStoreFor } from './sessionOrganizationAccountStore';
import type { CreateOrUpdateSessionOrganizationTagRequest } from '@happier-dev/protocol/sessions/organization/mutations';
import { createSessionOrganizationOpaqueId } from './sessionOrganizationIdAllocation';
import { CreateOrUpdateSessionOrganizationTagResponseSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { parseToken } from '@/utils/auth/parseToken';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
    openSessionOrganizationTagDisplay,
    prepareSessionOrganizationDisplayEnvelopeForWrite,
} from './sessionOrganizationDisplayEnvelope';

const executeTagAction = createFrontDoorActionExecute();
export type SessionTagActionExecute = (actionId: 'session.tags.create' | 'session.tags.set', input: unknown) => Promise<ActionExecuteResult>;

type ConcreteSessionOrganizationTagRequest = CreateOrUpdateSessionOrganizationTagRequest & {
    tagId: string;
};

function readCurrentTagIds(serverId: string): Set<string> {
    const state = getStorage().getState();
    const ids = new Set<string>();
    for (const [key, tag] of Object.entries(state.sessionOrganizationTagsByTagKey)) {
        if (key === buildSessionOrganizationServerKey(serverId, tag.tagId)) ids.add(tag.tagId);
    }
    return ids;
}

export async function upsertSessionTag(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
    request: CreateOrUpdateSessionOrganizationTagRequest;
}>): Promise<UiSessionOrganizationTag> {
    params.assertCurrent?.();
    const request: ConcreteSessionOrganizationTagRequest = {
        ...params.request,
        tagId: params.request.tagId ?? createSessionOrganizationOpaqueId({
            prefix: 'tag',
            usedIds: readCurrentTagIds(params.serverId),
        }),
        display: await prepareSessionOrganizationDisplayEnvelopeForWrite({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            envelope: params.request.display,
            request: params.requestAtEndpoint,
        }),
    };
    params.assertCurrent?.();
    const response = await upsertSessionOrganizationTagApi({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        requestAtEndpoint: params.requestAtEndpoint,
        request,
    });
    const tag = await openSessionOrganizationTagDisplay({
        credentials: params.credentials,
        tag: response.tag,
    });
    params.assertCurrent?.();
    const recordId = sessionOrganizationStoreFor(params).upsertSessionOrganizationTagOptimistic(params.serverId, tag);
    sessionOrganizationStoreFor(params).commitSessionOrganizationOptimistic(recordId);
    return tag;
}

export async function createSessionOrganizationTagWithLabel(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    label: string;
    usedIds?: ReadonlySet<string>;
    executeAction?: SessionTagActionExecute;
}>): Promise<UiSessionOrganizationTag> {
    const label = params.label.trim();
    if (!label) throw new Error('Session organization tag label is required');
    const tagId = createSessionOrganizationOpaqueId({
        prefix: 'tag',
        usedIds: params.usedIds ?? readCurrentTagIds(params.serverId),
    });
    const request = {
        tagId, tagKey: tagId, sortKey: null, display: { t: 'plain', v: { label } },
    };
    const result = params.executeAction ? await params.executeAction('session.tags.create', request)
        : await executeTagAction('session.tags.create', request, { surface: 'ui', authority: 'present_user',
            actionCaller: { kind: 'host' }, serverId: params.serverId, expectedAccountId: parseToken(params.credentials.token) });
    requireActionSuccess(result);
    const response = CreateOrUpdateSessionOrganizationTagResponseSchema.parse(result.result);
    const created = sessionOrganizationStoreFor(params).sessionOrganizationTagsByTagKey[
        buildSessionOrganizationServerKey(params.serverId, response.tag.tagId)];
    if (!created) throw new Error('invalid_action_output');
    return created;
}
