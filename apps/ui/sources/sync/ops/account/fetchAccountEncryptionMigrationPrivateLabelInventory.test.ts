import { describe, expect, it } from 'vitest';
import {
    ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
    AccountApiTokenSummaryV1Schema,
} from '@happier-dev/protocol/auth/accountApiTokens';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import {
    ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1,
    AccountDirectoryHomesResponseV1Schema,
} from '@happier-dev/protocol/auth/accountDirectory';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { MachinePoolListOutputV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import {
    projectPrivateLabelForRecipientV1,
    sealPrivateLabelV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';

import {
    fetchAccountEncryptionMigrationPrivateLabelInventory,
} from './fetchAccountEncryptionMigrationPrivateLabelInventory';

const accountId = 'account-a';
const scope = {
    scope: { serverId: 'home-a', accountId },
    isCurrent: () => true,
};

function projectedLabel(
    entity: 'account_api_token' | 'account_directory_home' | 'machine_pool',
    field: 'label' | 'name' | 'description',
    id: string,
    value: string,
) {
    return projectPrivateLabelForRecipientV1({
        stored: sealPrivateLabelV1({
            mode: 'plain',
            binding: { entity, field, id },
            value,
        }),
        recipientAccountId: accountId,
    });
}

function token(tokenId: string, label: string) {
    return AccountApiTokenSummaryV1Schema.parse({
        tokenId,
        label: projectedLabel('account_api_token', 'label', tokenId, label),
        displayPrefix: `hap_v1_${tokenId.slice(0, 8)}`,
        createdAt: '2026-11-11T10:00:00.000Z',
        lastUsedAt: null,
        expiresAt: null,
        hasEncryptionAccess: false,
        hasUnattendedTeamAccess: false,
        grant: API_TOKEN_FULL_GRANT_V1,
        parentTokenId: null,
        activeChildCount: 0,
        embedConfig: null,
    });
}

function homes() {
    const homeId = 'srv_home-a';
    return AccountDirectoryHomesResponseV1Schema.parse({
        v: 1,
        homes: [
            {
                v: 1,
                homeServerIdentityId: homeId,
                canonicalServerUrl: 'https://home-a.test',
                label: projectedLabel('account_directory_home', 'label', homeId, 'Private Home'),
                connectionDescriptor: {
                    v: 1,
                    homeServerIdentityId: homeId,
                    canonicalServerUrl: 'https://home-a.test',
                    revision: 1,
                    endpoints: [{ kind: 'https', url: 'https://home-a.test' }],
                },
                createdAtMs: 1,
                updatedAtMs: 1,
                preferred: true,
            },
            {
                v: 1,
                homeServerIdentityId: 'srv_bootstrap',
                canonicalServerUrl: 'https://bootstrap.test',
                label: null,
                connectionDescriptor: {
                    v: 1,
                    homeServerIdentityId: 'srv_bootstrap',
                    canonicalServerUrl: 'https://bootstrap.test',
                    revision: 1,
                    endpoints: [{ kind: 'https', url: 'https://bootstrap.test' }],
                },
                createdAtMs: 2,
                updatedAtMs: 2,
                preferred: false,
            },
        ],
        preferredHomeServerIdentityId: homeId,
    });
}

function pools() {
    const personalPoolId = '33333333-3333-4333-8333-333333333333';
    const teamPoolId = '44444444-4444-4444-8444-444444444444';
    return MachinePoolListOutputV1Schema.parse({
        pools: [
            {
                pool: {
                    id: personalPoolId,
                    name: {
                        kind: 'available',
                        label: projectedLabel('machine_pool', 'name', personalPoolId, 'Personal Pool'),
                    },
                    description: {
                        kind: 'available',
                        label: projectedLabel('machine_pool', 'description', personalPoolId, 'Personal description'),
                    },
                    revision: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    audience: { kind: 'private' },
                    members: [],
                },
                availability: { state: 'unknown' },
            },
            {
                pool: {
                    id: teamPoolId,
                    name: {
                        kind: 'available',
                        label: projectedLabel('machine_pool', 'name', teamPoolId, 'Team Pool'),
                    },
                    description: null,
                    revision: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    audience: { kind: 'team', teamId: 'team-a' },
                    members: [],
                },
                availability: { state: 'unknown' },
            },
        ],
    });
}

describe('fetchAccountEncryptionMigrationPrivateLabelInventory', () => {
    it('reads the complete token list and non-bootstrap Home labels through their ordinary owner routes', async () => {
        const root = token('11111111-1111-4111-8111-111111111111', 'Deploy root');
        const child = token('22222222-2222-4222-8222-222222222222', 'Deploy child');
        const poolInventory = pools();
        const calls: Array<Readonly<{ path: string; init: RequestInit | undefined }>> = [];

        const result = await fetchAccountEncryptionMigrationPrivateLabelInventory({
            request: async (path, init) => {
                calls.push({ path, init });
                if (path === ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1) {
                    return Response.json({ tokens: [root, child] });
                }
                if (path === ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1) {
                    return Response.json(homes());
                }
                if (path === machinePoolActionEndpointPathV1('machines.pools.list')) {
                    return Response.json(poolInventory);
                }
                throw new Error(`Unexpected path ${path}`);
            },
            scope,
        });

        expect(calls).toHaveLength(3);
        const tokenRequest = calls.find(call => call.path === ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1);
        expect(tokenRequest?.init?.method).toBe('POST');
        expect(new Headers(tokenRequest?.init?.headers).get('Content-Type')).toBe('application/json');
        expect(JSON.parse(String(tokenRequest?.init?.body))).toEqual({ includeChildren: true });
        expect(calls.find(call => call.path === ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1)?.init?.method).toBe('GET');
        const poolRequest = calls.find(call => call.path === machinePoolActionEndpointPathV1('machines.pools.list'));
        expect(poolRequest?.init?.method).toBe('POST');
        expect(JSON.parse(String(poolRequest?.init?.body))).toEqual({});
        expect(result).toEqual([
            { entity: 'account_api_token', field: 'label', id: root.tokenId, label: root.label },
            { entity: 'account_api_token', field: 'label', id: child.tokenId, label: child.label },
            { entity: 'account_directory_home', field: 'label', id: 'srv_home-a', label: homes().homes[0]!.label },
            {
                entity: 'machine_pool',
                field: 'name',
                id: '33333333-3333-4333-8333-333333333333',
                label: projectedLabel('machine_pool', 'name', '33333333-3333-4333-8333-333333333333', 'Personal Pool'),
            },
            {
                entity: 'machine_pool',
                field: 'description',
                id: '33333333-3333-4333-8333-333333333333',
                label: projectedLabel('machine_pool', 'description', '33333333-3333-4333-8333-333333333333', 'Personal description'),
            },
        ]);
    });

    it('does not return a partial migration inventory after its captured Account scope retires', async () => {
        let current = true;
        await expect(fetchAccountEncryptionMigrationPrivateLabelInventory({
            request: async (path) => {
                if (path === ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1) {
                    current = false;
                    return Response.json({ tokens: [] });
                }
                if (path === machinePoolActionEndpointPathV1('machines.pools.list')) {
                    return Response.json(pools());
                }
                return Response.json(homes());
            },
            scope: { ...scope, isCurrent: () => current },
        })).rejects.toThrow('Account Settings request scope changed');
    });
});
