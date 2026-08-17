import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());

// The socket transport is the boundary; everything below it stays real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScope(params),
}));

const { inspectSessionContinuationOnMachine } = await import('./sessionContinuationInspection');

const AVAILABLE = {
    type: 'available',
    protocolVersion: 1,
    sameSessionTransition: true,
    nativeReturn: false,
} as const;

function inspect() {
    return inspectSessionContinuationOnMachine({
        machineId: 'machine-1',
        serverId: 'server-1',
        sessionId: 'session-1',
        selection: { v: 1, agentId: 'codex' },
    });
}

describe('inspectSessionContinuationOnMachine', () => {
    beforeEach(() => {
        machineRpcWithServerScope.mockReset();
    });

    it('asks the exact machine hosting the Session about one exact target', async () => {
        machineRpcWithServerScope.mockResolvedValue(AVAILABLE);

        await expect(inspect()).resolves.toEqual({ status: 'answered', inspection: AVAILABLE });
        expect(machineRpcWithServerScope).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: 'session.continuation.inspect',
            payload: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'codex' } },
        });
    });

    it('reports the machine’s own unavailable reason unchanged', async () => {
        machineRpcWithServerScope.mockResolvedValue({ type: 'unavailable', reason: 'target_unavailable' });

        await expect(inspect()).resolves.toEqual({
            status: 'answered',
            inspection: { type: 'unavailable', reason: 'target_unavailable' },
        });
    });

    it('treats a missing method as the collapsed old-daemon-or-unreachable outcome', async () => {
        machineRpcWithServerScope.mockRejectedValue(Object.assign(
            new Error('RPC method not available'),
            { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' },
        ));

        await expect(inspect()).resolves.toEqual({
            status: 'answered',
            inspection: { type: 'unavailable', reason: 'operation_unavailable' },
        });
    });

    it('refuses to blame the daemon for a failure that proves nothing about it', async () => {
        // A timeout, an aborted call or a dropped socket is not evidence that the
        // CLI predates the operation. Reporting `operation_unavailable` here would
        // make an online machine tell its owner to update, which is simply false.
        for (const failure of [
            Object.assign(new Error('Machine RPC timed out after 30000ms'), { code: 'MACHINE_RPC_TIMEOUT' }),
            Object.assign(new Error('aborted'), { code: 'MACHINE_RPC_ABORTED' }),
            new Error('Socket not connected'),
            Object.assign(new Error('nope'), { rpcErrorCode: 'RPC_INTERNAL_ERROR' }),
        ]) {
            machineRpcWithServerScope.mockRejectedValueOnce(failure);
            await expect(inspect()).resolves.toEqual({ status: 'indeterminate' });
        }
    });

    it('does not read an unparseable answer as a verdict', async () => {
        for (const answer of [null, {}, { type: 'available' }, { type: 'unavailable', reason: 'nope' }]) {
            machineRpcWithServerScope.mockResolvedValueOnce(answer);
            await expect(inspect()).resolves.toEqual({ status: 'indeterminate' });
        }
    });
});
