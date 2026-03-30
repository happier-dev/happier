import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
}));

describe('probeMachineRpcDirectRouteAvailability', () => {
    beforeEach(() => {
        vi.resetModules();
        machineRpcWithServerScopeMock.mockReset();
        delete process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_ROUTE_CACHE_POSITIVE_TTL_MS;
        delete process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_ROUTE_CACHE_NEGATIVE_TTL_MS;
        delete process.env.EXPO_PUBLIC_HAPPIER_MACHINE_RPC_DIRECT_ROUTE_PROBE_TIMEOUT_MS;
    });

    it('returns viable when the runtime probe succeeds even if the shared direct-route cache remains unknown', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({ ok: true });

        const { probeMachineRpcDirectRouteAvailability } = await import('./probeMachineRpcDirectRouteAvailability');
        const { readCachedMachineRpcDirectRoute } = await import('./transferRouteCache');

        expect(readCachedMachineRpcDirectRoute({
            serverId: 'server-a',
            remoteMachineId: 'machine-1',
        })).toEqual({ status: 'unknown' });

        await expect(probeMachineRpcDirectRouteAvailability({
            serverId: 'server-a',
            remoteMachineId: 'machine-1',
        })).resolves.toBe('viable');

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.CAPABILITIES_DESCRIBE,
            payload: {},
            timeoutMs: 2_500,
        });
        expect(readCachedMachineRpcDirectRoute({
            serverId: 'server-a',
            remoteMachineId: 'machine-1',
        })).toEqual({ status: 'unknown' });
    });

    it('records unavailable when the runtime probe rpc fails', async () => {
        machineRpcWithServerScopeMock.mockRejectedValue(new Error('Socket not connected'));

        const { probeMachineRpcDirectRouteAvailability } = await import('./probeMachineRpcDirectRouteAvailability');
        const { readCachedMachineRpcDirectRoute } = await import('./transferRouteCache');

        await expect(probeMachineRpcDirectRouteAvailability({
            serverId: 'server-a',
            remoteMachineId: 'machine-2',
        })).resolves.toBe('unavailable');

        expect(readCachedMachineRpcDirectRoute({
            serverId: 'server-a',
            remoteMachineId: 'machine-2',
        })).toEqual(expect.objectContaining({
            status: 'unavailable',
            failureReason: 'Socket not connected',
        }));
    });
});
