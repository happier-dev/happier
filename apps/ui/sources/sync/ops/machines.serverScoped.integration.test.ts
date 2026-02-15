import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machines ops server-scoped routing', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('routes spawn requests through server-scoped rpc with the requested server id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { machineSpawnNewSession } = await import('./machines');

        const result = await machineSpawnNewSession({
            machineId: 'machine-1',
            directory: '/tmp',
            serverId: 'server-b',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'sess-1' });
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
