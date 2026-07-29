import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { resetScopedMachineDataKeyCacheForTests } from './serverScopedRpcPool';

const machineRpcSpy = vi.hoisted(() => vi.fn());
const createEphemeralSocketSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const resolveDirectRouteSpy = vi.hoisted(() => vi.fn());
const postDirectSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: (...args: unknown[]) => createEphemeralSocketSpy(...args),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: (...args: unknown[]) => machineRpcSpy(...args),
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

// Mock only the direct-route transport boundary so the peer-mediation DIRECT
// route is exercised end-to-end through the real wiring + real client.
vi.mock('@/sync/domains/machines/peer/mediation/rpc/productionRoute', () => ({
    resolveProductionMachineRpcDirectRoute: (...args: unknown[]) => resolveDirectRouteSpy(...args),
    postProductionMachineRpcDirect: (...args: unknown[]) => postDirectSpy(...args),
}));

function createSelectedRoute() {
    return {
        kind: 'selected' as const,
        receipt: 'peer.route.selected',
        endpoint: {
            url: 'http://127.0.0.1:3000/peer-mediation/v1/probe',
            endpointFingerprint: 'endpoint_1',
        },
        grant: {
            payload: {
                v: 1,
                grantId: 'grant_1',
                grantFamilyId: 'family_1',
                accountId: 'account_1',
                machineId: 'machine_1',
                flowKind: 'machine_rpc',
                routeKind: 'loopback_direct',
                scope: {
                    kind: 'machine_rpc',
                    rpcScopeId: 'rpc_scope_1',
                    allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
                    maxCalls: 1,
                    maxIdleMs: 10_000,
                },
                iat: 1_000,
                exp: 601_000,
                aud: 'happier-daemon-route-grant',
                endpointFingerprint: 'endpoint_1',
            },
            signature: { keyId: 'key_1', alg: 'Ed25519', valueBase64Url: 'AbCdEf012_-' },
        },
        nonceProof: {
            v: 1,
            grantId: 'grant_1',
            routeKind: 'loopback_direct',
            flowKind: 'machine_rpc',
            endpointFingerprint: 'endpoint_1',
            nonceBase64Url: 'nonce_1',
            signatureBase64Url: 'AbCdEf012_-',
        },
    };
}

describe('machineRpcWithServerScope signal (direct peer route)', () => {
    beforeEach(() => {
        resolveDirectRouteSpy.mockResolvedValue(createSelectedRoute());
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
        resolveDirectRouteSpy.mockReset();
        postDirectSpy.mockReset();
        resetScopedMachineDataKeyCacheForTests();
    });

    it('rejects with an abort error when the signal fires during an in-flight direct call', async () => {
        let resolveStarted: () => void = () => {};
        const started = new Promise<void>((resolve) => {
            resolveStarted = resolve;
        });
        postDirectSpy.mockImplementation(() => {
            resolveStarted();
            return new Promise(() => {});
        });
        const controller = new AbortController();

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const rpcPromise = machineRpcWithServerScope({
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true },
            signal: controller.signal,
        });
        const captured = rpcPromise.catch((error: unknown) => error);

        await started;
        controller.abort();

        const error = await captured;
        expect((error as { name?: string })?.name).toBe('AbortError');
        expect((error as { code?: string })?.code).toBe('MACHINE_RPC_ABORTED');
        // The server-fallback route must not be reached for a selected direct route.
        expect(machineRpcSpy).not.toHaveBeenCalled();
        expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
    });

    it('rejects immediately without dispatching the direct request when already aborted', async () => {
        postDirectSpy.mockImplementation(() => new Promise(() => {}));
        const controller = new AbortController();
        controller.abort();

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        await expect(
            machineRpcWithServerScope({
                machineId: 'machine_1',
                method: RPC_METHODS.DAEMON_MEMORY_STATUS,
                payload: { includeWorkers: true },
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ code: 'MACHINE_RPC_ABORTED' });
        expect(postDirectSpy).not.toHaveBeenCalled();
    });
});
