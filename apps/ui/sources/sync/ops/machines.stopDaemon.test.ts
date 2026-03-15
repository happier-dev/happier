import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machineStopDaemon', () => {
    it('routes through machineRpcWithServerScope (server-scoped RPC)', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ message: 'ok' });

        const { machineStopDaemon } = await import('./machines');
        const result = await machineStopDaemon('machine-1', { serverId: 'server-a' });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            method: RPC_METHODS.STOP_DAEMON,
            payload: {},
            serverId: 'server-a',
        });
        expect(result).toEqual({ message: 'ok' });
    });
});
