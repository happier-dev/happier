import {
    ConnectedServiceAuthGroupListResponseV1Schema,
    ConnectedServiceAuthGroupResponseV1Schema,
    type ConnectedServiceAuthGroupActiveProfileRequestV1,
    type ConnectedServiceAuthGroupCreateRequestV1,
    type ConnectedServiceAuthGroupListResponseV1,
    type ConnectedServiceAuthGroupMemberCreateRequestV1,
    type ConnectedServiceAuthGroupMemberDeleteRequestV1,
    type ConnectedServiceAuthGroupMemberPatchRequestV1,
    type ConnectedServiceAuthGroupPatchRequestV1,
    type ConnectedServiceAuthGroupResponseV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';
import { throwConnectedServiceApiError } from './connectedServiceApiError';

function connectedServiceGroupsPath(serviceId: ConnectedServiceId): string {
    return `/v3/connect/${encodeURIComponent(serviceId)}/groups`;
}

function connectedServiceGroupPath(serviceId: ConnectedServiceId, groupId: string): string {
    return `${connectedServiceGroupsPath(serviceId)}/${encodeURIComponent(groupId)}`;
}

function connectedServiceGroupMemberPath(serviceId: ConnectedServiceId, groupId: string, profileId: string): string {
    return `${connectedServiceGroupPath(serviceId, groupId)}/members/${encodeURIComponent(profileId)}`;
}

async function assertConnectedServiceAuthGroupOk(response: Response): Promise<void> {
    if (response.ok) return;

    await throwConnectedServiceApiError(response);
}

async function parseGroupResponse(response: Response): Promise<ConnectedServiceAuthGroupResponseV1> {
    const json = await response.json().catch(() => null);
    const parsed = ConnectedServiceAuthGroupResponseV1Schema.safeParse(json);
    if (!parsed.success) {
        throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
    return parsed.data;
}

async function parseGroupListResponse(response: Response): Promise<ConnectedServiceAuthGroupListResponseV1> {
    const json = await response.json().catch(() => null);
    const parsed = ConnectedServiceAuthGroupListResponseV1Schema.safeParse(json);
    if (!parsed.success) {
        throw new HappyError('invalid response', false, { status: response.status, kind: 'server' });
    }
    return parsed.data;
}

function authHeaders(credentials: AuthCredentials): HeadersInit {
    return {
        Authorization: `Bearer ${credentials.token}`,
    };
}

function jsonHeaders(credentials: AuthCredentials): HeadersInit {
    return {
        ...authHeaders(credentials),
        'Content-Type': 'application/json',
    };
}

export async function listConnectedServiceAuthGroupsV3(
    credentials: AuthCredentials,
    params: Readonly<{ serviceId: ConnectedServiceId }>,
): Promise<ConnectedServiceAuthGroupListResponseV1> {
    return await backoff(async () => {
        const response = await serverFetch(
            connectedServiceGroupsPath(params.serviceId),
            { method: 'GET', headers: authHeaders(credentials) },
            { includeAuth: false },
        );
        await assertConnectedServiceAuthGroupOk(response);
        return await parseGroupListResponse(response);
    });
}

export async function getConnectedServiceAuthGroupV3(
    credentials: AuthCredentials,
    params: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>,
): Promise<ConnectedServiceAuthGroupResponseV1> {
    return await backoff(async () => {
        const response = await serverFetch(
            connectedServiceGroupPath(params.serviceId, params.groupId),
            { method: 'GET', headers: authHeaders(credentials) },
            { includeAuth: false },
        );
        await assertConnectedServiceAuthGroupOk(response);
        return await parseGroupResponse(response);
    });
}

export async function createConnectedServiceAuthGroupV3(
    credentials: AuthCredentials,
    params: Readonly<{ serviceId: ConnectedServiceId } & ConnectedServiceAuthGroupCreateRequestV1>,
): Promise<ConnectedServiceAuthGroupResponseV1> {
    return await backoff(async () => {
        const { serviceId, ...body } = params;
        const response = await serverFetch(
            connectedServiceGroupsPath(serviceId),
            {
                method: 'POST',
                headers: jsonHeaders(credentials),
                body: JSON.stringify(body),
            },
            { includeAuth: false },
        );
        await assertConnectedServiceAuthGroupOk(response);
        return await parseGroupResponse(response);
    });
}

export async function patchConnectedServiceAuthGroupV3(
    credentials: AuthCredentials,
    params: Readonly<{ serviceId: ConnectedServiceId; groupId: string; patch: ConnectedServiceAuthGroupPatchRequestV1 }>,
): Promise<ConnectedServiceAuthGroupResponseV1> {
    return await backoff(async () => {
        const response = await serverFetch(
            connectedServiceGroupPath(params.serviceId, params.groupId),
            {
                method: 'PATCH',
                headers: jsonHeaders(credentials),
                body: JSON.stringify(params.patch),
            },
            { includeAuth: false },
        );
        await assertConnectedServiceAuthGroupOk(response);
        return await parseGroupResponse(response);
    });
}

export async function deleteConnectedServiceAuthGroupV3(
    credentials: AuthCredentials,
    params: Readonly<{ serviceId: ConnectedServiceId; groupId: string }>,
): Promise<boolean> {
    return await backoff(async () => {
        const response = await serverFetch(
            connectedServiceGroupPath(params.serviceId, params.groupId),
            { method: 'DELETE', headers: authHeaders(credentials) },
            { includeAuth: false },
        );

        if (response.status === 404) return false;

        await assertConnectedServiceAuthGroupOk(response);
        return true;
    });
}

export async function addConnectedServiceAuthGroupMemberV3(
    credentials: AuthCredentials,
    params: Readonly<{ serviceId: ConnectedServiceId; groupId: string } & ConnectedServiceAuthGroupMemberCreateRequestV1>,
): Promise<ConnectedServiceAuthGroupResponseV1> {
    return await backoff(async () => {
        const { serviceId, groupId, ...body } = params;
        const response = await serverFetch(
            `${connectedServiceGroupPath(serviceId, groupId)}/members`,
            {
                method: 'POST',
                headers: jsonHeaders(credentials),
                body: JSON.stringify(body),
            },
            { includeAuth: false },
        );
        await assertConnectedServiceAuthGroupOk(response);
        return await parseGroupResponse(response);
    });
}

export async function patchConnectedServiceAuthGroupMemberV3(
    credentials: AuthCredentials,
    params: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileId: string;
        patch: ConnectedServiceAuthGroupMemberPatchRequestV1;
    }>,
): Promise<ConnectedServiceAuthGroupResponseV1> {
    return await backoff(async () => {
        const response = await serverFetch(
            connectedServiceGroupMemberPath(params.serviceId, params.groupId, params.profileId),
            {
                method: 'PATCH',
                headers: jsonHeaders(credentials),
                body: JSON.stringify(params.patch),
            },
            { includeAuth: false },
        );
        await assertConnectedServiceAuthGroupOk(response);
        return await parseGroupResponse(response);
    });
}

export async function removeConnectedServiceAuthGroupMemberV3(
    credentials: AuthCredentials,
    params: Readonly<{ serviceId: ConnectedServiceId; groupId: string; profileId: string } & ConnectedServiceAuthGroupMemberDeleteRequestV1>,
): Promise<ConnectedServiceAuthGroupResponseV1> {
    return await backoff(async () => {
        const query = new URLSearchParams({ expectedGeneration: String(params.expectedGeneration) });
        const response = await serverFetch(
            `${connectedServiceGroupMemberPath(params.serviceId, params.groupId, params.profileId)}?${query.toString()}`,
            { method: 'DELETE', headers: authHeaders(credentials) },
            { includeAuth: false },
        );
        await assertConnectedServiceAuthGroupOk(response);
        return await parseGroupResponse(response);
    });
}

export async function setConnectedServiceAuthGroupActiveProfileV3(
    credentials: AuthCredentials,
    params: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
    } & ConnectedServiceAuthGroupActiveProfileRequestV1>,
): Promise<ConnectedServiceAuthGroupResponseV1> {
    return await backoff(async () => {
        const { serviceId, groupId, ...body } = params;
        const response = await serverFetch(
            `${connectedServiceGroupPath(serviceId, groupId)}/active-profile`,
            {
                method: 'POST',
                headers: jsonHeaders(credentials),
                body: JSON.stringify(body),
            },
            { includeAuth: false },
        );
        await assertConnectedServiceAuthGroupOk(response);
        return await parseGroupResponse(response);
    });
}
