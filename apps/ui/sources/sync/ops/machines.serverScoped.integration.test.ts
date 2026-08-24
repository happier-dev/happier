import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPersistenceStorage } from '@/sync/domains/state/persistence';
import { storage } from '@/sync/domains/state/storage';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machines ops server-scoped routing', () => {
    const initialStorageState = storage.getState();

    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        storage.setState({
            ...initialStorageState,
            profileScope: { serverId: 'server-b', accountId: 'account-a' },
            machines: {
                'machine-1': {
                    id: 'machine-1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: {
                        host: 'test-machine',
                        platform: 'darwin',
                        happyCliVersion: '0.2.0',
                        happyHomeDir: '/Users/alice/.happier',
                        homeDir: '/Users/alice',
                    },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 1,
                },
            },
        }, true);
        getPersistenceStorage().clearAll();
    });

    afterEach(() => {
        storage.setState(initialStorageState, true);
        getPersistenceStorage().clearAll();
    });

    it('routes spawn requests through server-scoped rpc with the requested server id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { machineSpawnNewSession } = await import('./machines');

        const result = await machineSpawnNewSession({
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: 'server-b',
            accountSettingsVersionHint: 0,
        });

        expect(result).toMatchObject({ type: 'success', sessionId: 'sess-1' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-b',
        }));
    });

    it('routes preview env through server-scoped rpc with the requested server id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            policy: 'none',
            values: {},
        });
        const { machinePreviewEnv } = await import('./machines');

        const result = await machinePreviewEnv(
            'machine-2',
            { keys: ['FOO'] },
            { serverId: 'server-c' },
        );

        expect(result).toEqual({
            supported: true,
            response: {
                policy: 'none',
                values: {},
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-2',
            serverId: 'server-c',
        }));
    });

    it('routes bash through server-scoped rpc with the requested server id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            success: true,
            stdout: 'ok',
            stderr: '',
            exitCode: 0,
        });
        const { machineBash } = await import('./machines');

        const result = await machineBash(
            'machine-3',
            'echo ok',
            '/',
            { serverId: 'server-d' },
        );

        expect(result).toEqual({
            success: true,
            stdout: 'ok',
            stderr: '',
            exitCode: 0,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-3',
            serverId: 'server-d',
            method: 'bash',
        }));
    });
});
