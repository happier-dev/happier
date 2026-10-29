import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machine resources ops server-scoped routing', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('routes daemon resources get through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            snapshot: {
                sampledAt: 1,
                cpu: { usagePercent: 12 },
                memory: { totalBytes: 8, usedBytes: 4, usagePercent: 50 },
                disk: { path: '/', totalBytes: 8, availableBytes: 4, usedBytes: 4, usagePercent: 50 },
            },
        });
        const { machineResourcesGet } = await import('./machineResources');

        const result = await machineResourcesGet('machine-1', { serverId: 'server-a' });

        expect(result).toEqual({
            ok: true,
            snapshot: {
                sampledAt: 1,
                cpu: { usagePercent: 12 },
                memory: { totalBytes: 8, usedBytes: 4, usagePercent: 50 },
                disk: { path: '/', totalBytes: 8, availableBytes: 4, usedBytes: 4, usagePercent: 50 },
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.resources.get',
            payload: {},
        }));
    });

    it('propagates daemon-side failures with their error code', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            error: 'sampling unavailable',
            errorCode: 'resources_unsupported',
        });
        const { machineResourcesGet } = await import('./machineResources');

        const result = await machineResourcesGet('machine-1');

        expect(result).toEqual({ ok: false, error: 'sampling unavailable', errorCode: 'resources_unsupported' });
    });

    it('rejects malformed responses instead of trusting the shape', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, snapshot: { sampledAt: 'nope' } });
        const { machineResourcesGet } = await import('./machineResources');

        const result = await machineResourcesGet('machine-1');

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toBe('Unsupported response from machine RPC');
        }
    });

    it('surfaces transport errors as failures with the rpc error code', async () => {
        const error = new Error('Machine RPC failed');
        Object.assign(error, { rpcErrorCode: 'machine_rpc_timeout' });
        machineRpcWithServerScopeMock.mockRejectedValueOnce(error);
        const { machineResourcesGet } = await import('./machineResources');

        const result = await machineResourcesGet('machine-1');

        expect(result).toEqual({ ok: false, error: 'Machine RPC failed', errorCode: 'machine_rpc_timeout' });
    });
});
