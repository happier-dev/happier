import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { connectedServiceFetch } from './connectedServiceNetworkError';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';
import { createConnectedServiceApiError } from './connectedServiceApiError';

import {
    CONNECTED_SERVICE_AUTO_QUOTA_RESET_HEADER,
    CONNECTED_SERVICE_AUTO_QUOTA_RESET_HEADER_VALUE,
    appendConnectedServiceAuthGroupReaderCapabilities,
    ConnectedServiceAuthGroupListResponseV1Schema,
    type ConnectedServiceAuthGroupMemberCreateRequestV1,
    type ConnectedServiceAuthGroupMemberPatchRequestV1,
    type ConnectedServiceAuthGroupPolicyPatchV1,
    type ConnectedServiceAuthGroupPatchRequestV1,
    ConnectedServiceAuthGroupResponseV1Schema,
    type ConnectedServiceAuthGroupV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';

type ConnectedServiceAuthGroupPolicyPatchInput = ConnectedServiceAuthGroupPolicyPatchV1;

type ConnectedServiceAuthGroupMemberInput = Readonly<{
    profileId: string;
    priority: number;
    enabled: boolean;
}>;

type ConnectedServiceAuthGroupPatchInput = ConnectedServiceAuthGroupPatchRequestV1;
type ConnectedServiceAuthGroupMemberCreateInput = ConnectedServiceAuthGroupMemberCreateRequestV1;
type ConnectedServiceAuthGroupMemberPatchInput = ConnectedServiceAuthGroupMemberPatchRequestV1;

async function fetchAuthGroupEnvelope(
    credentials: AuthCredentials,
    path: string,
    init: Readonly<{
        method: 'POST' | 'PATCH' | 'DELETE';
        body?: unknown;
    }>,
): Promise<ConnectedServiceAuthGroupV1> {
    return await backoff(async () => {
        const response = await connectedServiceFetch(
            'fetchAuthGroupEnvelope',
            appendConnectedServiceAuthGroupReaderCapabilities(path),
            {
                method: init.method,
                headers: {
                    [CONNECTED_SERVICE_AUTO_QUOTA_RESET_HEADER]: CONNECTED_SERVICE_AUTO_QUOTA_RESET_HEADER_VALUE,
                    Authorization: `Bearer ${credentials.token}`,
                    // Only declare a JSON body when one is actually sent: Fastify rejects
                    // body-less requests that carry a JSON content-type (FST_ERR_CTP_EMPTY_JSON_BODY).
                    ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
            },
            { includeAuth: false },
        );

        const json = await response.json().catch(() => null);
        if (!response.ok) {
            throw createConnectedServiceApiError(json, {
                status: response.status,
                fallbackCode: 'connect_group_request_failed',
            });
        }

        const parsed = ConnectedServiceAuthGroupResponseV1Schema.safeParse(json);
        if (!parsed.success) {
            throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
        }
        return parsed.data.group;
    });
}

export async function createConnectedServiceAuthGroupV3(
    credentials: AuthCredentials,
    params: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        displayName: string | null;
        members: ReadonlyArray<ConnectedServiceAuthGroupMemberInput>;
        activeProfileId: string | null;
        policy?: ConnectedServiceAuthGroupPolicyPatchInput;
    }>,
): Promise<ConnectedServiceAuthGroupV1> {
    return await fetchAuthGroupEnvelope(
        credentials,
        `/v3/connect/${encodeURIComponent(params.serviceId)}/groups`,
        {
            method: 'POST',
            body: {
                groupId: params.groupId,
                displayName: params.displayName,
                members: params.members,
                activeProfileId: params.activeProfileId,
                ...(params.policy ? { policy: params.policy } : {}),
            },
        },
    );
}

export async function listConnectedServiceAuthGroupsV3(
    credentials: AuthCredentials,
    params: Readonly<{ serviceId: ConnectedServiceId }>,
): Promise<ReadonlyArray<ConnectedServiceAuthGroupV1>> {
    return await backoff(async () => {
        const response = await connectedServiceFetch(
            'listConnectedServiceAuthGroupsV3',
            appendConnectedServiceAuthGroupReaderCapabilities(`/v3/connect/${encodeURIComponent(params.serviceId)}/groups`),
            {
                method: 'GET',
                headers: {
                    [CONNECTED_SERVICE_AUTO_QUOTA_RESET_HEADER]: CONNECTED_SERVICE_AUTO_QUOTA_RESET_HEADER_VALUE,
                    Authorization: `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
            },
            { includeAuth: false },
        );

        const json = await response.json().catch(() => null);
        if (!response.ok) {
            throw createConnectedServiceApiError(json, {
                status: response.status,
                fallbackCode: 'connect_group_request_failed',
            });
        }

        const parsed = ConnectedServiceAuthGroupListResponseV1Schema.safeParse(json);
        if (!parsed.success) {
            throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
        }
        return parsed.data.groups;
    });
}

export async function patchConnectedServiceAuthGroupV3(
    credentials: AuthCredentials,
    params: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        patch: ConnectedServiceAuthGroupPatchInput;
    }>,
): Promise<ConnectedServiceAuthGroupV1> {
    return await fetchAuthGroupEnvelope(
        credentials,
        `/v3/connect/${encodeURIComponent(params.serviceId)}/groups/${encodeURIComponent(params.groupId)}`,
        { method: 'PATCH', body: params.patch },
    );
}

export async function deleteConnectedServiceAuthGroupV3(
    credentials: AuthCredentials,
    params: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>,
): Promise<boolean> {
    return await backoff(async () => {
        const response = await connectedServiceFetch(
            'deleteConnectedServiceAuthGroupV3',
            `/v3/connect/${encodeURIComponent(params.serviceId)}/groups/${encodeURIComponent(params.groupId)}`,
            {
                method: 'DELETE',
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                },
            },
            { includeAuth: false },
        );

        if (response.status === 404) return false;
        if (!response.ok) {
            const json = await response.json().catch(() => null);
            throw createConnectedServiceApiError(json, {
                status: response.status,
                fallbackCode: 'connect_group_request_failed',
            });
        }
        return true;
    });
}

export async function addConnectedServiceAuthGroupMemberV3(
    credentials: AuthCredentials,
    params: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
    } & ConnectedServiceAuthGroupMemberCreateInput>,
): Promise<ConnectedServiceAuthGroupV1> {
    return await fetchAuthGroupEnvelope(
        credentials,
        `/v3/connect/${encodeURIComponent(params.serviceId)}/groups/${encodeURIComponent(params.groupId)}/members`,
        {
            method: 'POST',
            body: {
                profileId: params.profileId,
                priority: params.priority,
                enabled: params.enabled,
                expectedGeneration: params.expectedGeneration,
            },
        },
    );
}

export async function patchConnectedServiceAuthGroupMemberV3(
    credentials: AuthCredentials,
    params: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileId: string;
        patch: ConnectedServiceAuthGroupMemberPatchInput;
    }>,
): Promise<ConnectedServiceAuthGroupV1> {
    return await fetchAuthGroupEnvelope(
        credentials,
        `/v3/connect/${encodeURIComponent(params.serviceId)}/groups/${encodeURIComponent(params.groupId)}/members/${encodeURIComponent(params.profileId)}`,
        { method: 'PATCH', body: params.patch },
    );
}

export async function removeConnectedServiceAuthGroupMemberV3(
    credentials: AuthCredentials,
    params: Readonly<{ serviceId: ConnectedServiceId; groupId: string; profileId: string; expectedGeneration: number }>,
): Promise<ConnectedServiceAuthGroupV1> {
    return await fetchAuthGroupEnvelope(
        credentials,
        `/v3/connect/${encodeURIComponent(params.serviceId)}/groups/${encodeURIComponent(params.groupId)}/members/${encodeURIComponent(params.profileId)}?expectedGeneration=${encodeURIComponent(String(params.expectedGeneration))}`,
        { method: 'DELETE' },
    );
}

export async function setConnectedServiceAuthGroupActiveProfileV3(
    credentials: AuthCredentials,
    params: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileId: string;
        expectedGeneration: number;
        overrideRuntimeCooldown?: boolean;
    }>,
): Promise<ConnectedServiceAuthGroupV1> {
    return await fetchAuthGroupEnvelope(
        credentials,
        `/v3/connect/${encodeURIComponent(params.serviceId)}/groups/${encodeURIComponent(params.groupId)}/active-profile`,
        {
            method: 'POST',
            body: {
                profileId: params.profileId,
                expectedGeneration: params.expectedGeneration,
                ...(params.overrideRuntimeCooldown ? { overrideRuntimeCooldown: true } : {}),
            },
        },
    );
}
