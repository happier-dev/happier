import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machine execution runs ops server-scoped routing', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('routes daemon execution run listing through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ runs: [] });
        const { machineExecutionRunsList } = await import('./machineExecutionRuns');

        const result = await machineExecutionRunsList('machine-1', { serverId: 'server-a' });

        expect(result).toEqual({ ok: true, runs: [] });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.executionRuns.list',
        }));
    });
});

