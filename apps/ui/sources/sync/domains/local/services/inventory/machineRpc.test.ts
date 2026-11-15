import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { afterEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: readonly unknown[]) =>
        machineRpcWithServerScopeMock(...args),
}));

const snapshot = {
    v: 1 as const,
    machineId: 'machine_1',
    generatedAt: 1_000,
    refreshState: 'idle' as const,
    entries: [],
    diagnostics: [],
};

describe('local service inventory machine RPC client', () => {
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it.each(['response', 'exception'] as const)('retains an admitted unavailable inventory scope from a typed %s', async kind => {
        if (kind === 'response') machineRpcWithServerScopeMock.mockResolvedValue({ error: 'Scope unavailable',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        else machineRpcWithServerScopeMock.mockRejectedValue(new RpcError('Scope unavailable', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE));
        const { fetchLocalServiceInventorySnapshotViaMachineRpc } = await import('./machineRpc');
        await expect(fetchLocalServiceInventorySnapshotViaMachineRpc({ machineId: 'machine_1' }))
            .resolves.toEqual({ ok: false, reason: 'unavailable', reasonCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    });

    it('preserves the typed RPC refusal so Refresh can explain the actual cause', async () => {
        machineRpcWithServerScopeMock.mockRejectedValue(new RpcError('private transport detail', RPC_ERROR_CODES.FORBIDDEN));
        const { fetchLocalServiceInventorySnapshotViaMachineRpc } = await import('./machineRpc');
        await expect(fetchLocalServiceInventorySnapshotViaMachineRpc({ machineId: 'machine_1', refresh: true }))
            .resolves.toEqual({ ok: false, reason: 'request_failed', reasonCode: RPC_ERROR_CODES.FORBIDDEN });
    });

    it('fetches and refreshes daemon-owned inventory snapshots through machine RPC', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ protocolVersion: 1, snapshot })
            .mockResolvedValueOnce({ protocolVersion: 1, snapshot: { ...snapshot, generatedAt: 2_000 } });
        const { fetchLocalServiceInventorySnapshotViaMachineRpc } = await import('./machineRpc');

        await expect(fetchLocalServiceInventorySnapshotViaMachineRpc({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
        })).resolves.toEqual({ ok: true, snapshot });
        await expect(fetchLocalServiceInventorySnapshotViaMachineRpc({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
            refresh: true,
        })).resolves.toEqual({ ok: true, snapshot: { ...snapshot, generatedAt: 2_000 } });

        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toEqual([
            RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH,
        ]);
        expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
            payload: { machineId: 'machine_1' },
        }));
    });

    it('fails closed for unavailable and mismatched daemon inventory responses', async () => {
        const failureCause = { phase: 'rpc.discovery', errorClass: 'RpcError',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, httpStatus: null };
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
                error: 'Method not found',
                failureCause,
            })
            .mockResolvedValueOnce({
                protocolVersion: 1,
                snapshot: { ...snapshot, machineId: 'machine_2' },
            });
        const { fetchLocalServiceInventorySnapshotViaMachineRpc } = await import('./machineRpc');

        await expect(fetchLocalServiceInventorySnapshotViaMachineRpc({
            machineId: 'machine_1',
        })).resolves.toEqual({ ok: false, reason: 'unavailable', reasonCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, failureCause });
        await expect(fetchLocalServiceInventorySnapshotViaMachineRpc({
            machineId: 'machine_1',
        })).resolves.toEqual({ ok: false, reason: 'invalid_response' });
    });
});
