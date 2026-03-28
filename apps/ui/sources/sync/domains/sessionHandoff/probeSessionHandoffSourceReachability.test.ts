import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
}));

describe('probeSessionHandoffSourceReachability', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('reports reachable when the source daemon answers through server-scoped rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({ ok: true });

        const { probeSessionHandoffSourceReachability } = await import('./probeSessionHandoffSourceReachability');

        await expect(probeSessionHandoffSourceReachability({
            serverId: 'server-a',
            sourceMachineId: 'machine-1',
        })).resolves.toBe('reachable');
    });

    it('reports unavailable when the source daemon probe fails', async () => {
        machineRpcWithServerScopeMock.mockRejectedValue(new Error('probe failed'));

        const { probeSessionHandoffSourceReachability } = await import('./probeSessionHandoffSourceReachability');

        await expect(probeSessionHandoffSourceReachability({
            serverId: 'server-a',
            sourceMachineId: 'machine-1',
        })).resolves.toBe('unavailable');
    });
});
