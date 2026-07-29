import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machine npm registry profile ops', () => {
    beforeEach(() => machineRpcWithServerScopeMock.mockReset());

    it('gets a strict secret-free snapshot through server-scoped machine RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'success', snapshot: { protocolVersion: 1, revision: 0, profiles: [], pausedSources: [] },
        });
        const { machineNpmRegistryProfilesGet } = await import('./machineNpmRegistryProfiles');
        await expect(machineNpmRegistryProfilesGet('machine-a', { serverId: 'server-a' }))
            .resolves.toMatchObject({ status: 'success', snapshot: { revision: 0 } });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET,
            payload: { machineId: 'machine-a' },
        }));
    });

    it('validates and forwards mutations without retaining credentials', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'success', snapshot: { protocolVersion: 1, revision: 1, profiles: [], pausedSources: [] },
        });
        const { machineNpmRegistryProfilesMutate } = await import('./machineNpmRegistryProfiles');
        const request = {
            action: 'login' as const, machineId: 'machine-a', profileId: 'registry_acme', expectedRevision: 0,
            mutationId: 'mutation-login-acme', credential: { kind: 'bearer_token' as const, secret: 'boundary-secret' },
        };
        const result = await machineNpmRegistryProfilesMutate('machine-a', request, { serverId: 'server-a' });
        expect(result.status).toBe('success');
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_MUTATE,
            payload: request,
        }));
        expect(JSON.stringify(result)).not.toContain('boundary-secret');
    });
});
