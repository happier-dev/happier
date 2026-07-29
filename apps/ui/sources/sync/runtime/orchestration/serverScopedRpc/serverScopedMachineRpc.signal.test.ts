import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetScopedMachineDataKeyCacheForTests } from './serverScopedRpcPool';

type MachineRpcSpy = (machineId: string, method: string, params: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;

const machineRpcSpy = vi.hoisted(() => vi.fn<MachineRpcSpy>());
const createEphemeralSocketSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const machineRpcWithPeerMediationRouteSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: (...args: unknown[]) => createEphemeralSocketSpy(...args),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: (...args: Parameters<MachineRpcSpy>) => machineRpcSpy(...args),
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

vi.mock('@/sync/domains/machines/peer/mediation/rpc/client', () => ({
    machineRpcWithPeerMediationRoute: (...args: unknown[]) => machineRpcWithPeerMediationRouteSpy(...args),
}));

describe('machineRpcWithServerScope signal', () => {
    beforeEach(() => {
        machineRpcWithPeerMediationRouteSpy.mockImplementation(async (params: {
            serverId?: string | null;
            machineId: string;
            method: string;
            payload: unknown;
            timeoutMs?: number;
            serverFallback: (input: {
                serverId?: string | null;
                machineId: string;
                method: string;
                payload: unknown;
                timeoutMs?: number;
                reasonCode: string;
            }) => Promise<unknown>;
        }) => await params.serverFallback({
            serverId: params.serverId,
            machineId: params.machineId,
            method: params.method,
            payload: params.payload,
            timeoutMs: params.timeoutMs,
            reasonCode: 'server_required',
        }));
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
    });

    afterEach(() => {
        machineRpcSpy.mockReset();
        createEphemeralSocketSpy.mockReset();
        getActiveServerSnapshotSpy.mockReset();
        machineRpcWithPeerMediationRouteSpy.mockReset();
        resetScopedMachineDataKeyCacheForTests();
    });

    it('rejects with an abort error when the signal fires during an in-flight attempt', async () => {
        machineRpcSpy.mockImplementation(() => new Promise(() => {}));
        const controller = new AbortController();

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const rpcPromise = machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 1 },
            signal: controller.signal,
        });
        const captured = rpcPromise.catch((error: unknown) => error);

        controller.abort();

        const error = await captured;
        expect((error as { name?: string })?.name).toBe('AbortError');
        expect((error as { code?: string })?.code).toBe('MACHINE_RPC_ABORTED');
    });

    it('rejects immediately when the signal is already aborted', async () => {
        machineRpcSpy.mockResolvedValue({ ok: true });
        const controller = new AbortController();
        controller.abort();

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        await expect(
            machineRpcWithServerScope({
                machineId: 'machine-1',
                method: 'method-test',
                payload: { value: 1 },
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ code: 'MACHINE_RPC_ABORTED' });
        expect(machineRpcSpy).not.toHaveBeenCalled();
    });

    it('resolves normally when no signal is provided', async () => {
        machineRpcSpy.mockResolvedValue({ ok: true });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        await expect(
            machineRpcWithServerScope({
                machineId: 'machine-1',
                method: 'method-test',
                payload: { value: 1 },
            }),
        ).resolves.toEqual({ ok: true });
    });
});
