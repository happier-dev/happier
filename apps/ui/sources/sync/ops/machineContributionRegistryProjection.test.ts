import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machine contribution registry projection ops', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('routes projection.describe through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: { v: 1, providersById: {}, backendsById: {} },
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        const res = await machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });

        expect(res).toEqual({
            supported: true,
            projection: expect.objectContaining({
                v: 1,
                providersById: {},
                backendsById: {},
            }),
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            payload: expect.objectContaining({ machineId: 'machine-1' }),
        }));
    });

    it('accepts extension projection v2 responses from the daemon', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: {
                v: 2,
                generation: 3,
                installedPackagesById: {
                    'acme.review': {
                        id: 'acme.review',
                        displayName: 'Acme Review',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/acme-review',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                uiDescriptorsById: {},
                diagnostics: [],
            },
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        const res = await machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });

        expect(res).toEqual({
            supported: true,
            projection: expect.objectContaining({
                v: 2,
                generation: 3,
                installedPackagesById: expect.objectContaining({
                    'acme.review': expect.objectContaining({
                        displayName: 'Acme Review',
                    }),
                }),
            }),
        });
    });

    it('treats method-not-found as unsupported (mixed-version daemon)', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            error: 'Method not found',
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        const res = await machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });

        expect(res).toEqual({ supported: false, reason: 'not-supported' });
    });
});
