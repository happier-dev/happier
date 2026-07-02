import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { resetScopedMachineDataKeyCacheForTests } from './serverScopedRpcPool';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

type MachineRpcSpy = (machineId: string, method: string, params: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;

const machineRpcSpy = vi.hoisted(() => vi.fn<MachineRpcSpy>());
const createEphemeralSocketSpy = vi.hoisted(() => vi.fn());
const getReadyServerFeaturesSpy = vi.hoisted(() => vi.fn());
const getCredentialsSpy = vi.hoisted(() => vi.fn());
const createEncryptionSpy = vi.hoisted(() => vi.fn());
const listServerProfilesSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const machineRpcWithPeerMediationRouteSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (...args: unknown[]) => getReadyServerFeaturesSpy(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: (...args: unknown[]) => createEphemeralSocketSpy(...args),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: (...args: Parameters<MachineRpcSpy>) => machineRpcSpy(...args),
    },
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsSpy(...args),
    },
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: (...args: unknown[]) => createEncryptionSpy(...args),
}));

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createServerProfilesModuleMock({
        listServerProfiles: (...args: unknown[]) => listServerProfilesSpy(...args),
    });
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

vi.mock('@/sync/domains/machines/peer/mediation/rpc/client', () => ({
    machineRpcWithPeerMediationRoute: (...args: unknown[]) => machineRpcWithPeerMediationRouteSpy(...args),
}));

function findTelemetryEvent(name: string) {
    return syncPerformanceTelemetry.snapshot().events.find((event) => event.name === name);
}

function installDefaultPeerMediationFallback(): void {
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
}

describe('machineRpcWithServerScope', () => {
    beforeEach(() => {
        installDefaultPeerMediationFallback();
    });

    afterEach(() => {
        machineRpcSpy.mockReset();
        createEphemeralSocketSpy.mockReset();
        getReadyServerFeaturesSpy.mockReset();
        getCredentialsSpy.mockReset();
        createEncryptionSpy.mockReset();
        listServerProfilesSpy.mockReset();
        getActiveServerSnapshotSpy.mockReset();
        machineRpcWithPeerMediationRouteSpy.mockReset();
        vi.unstubAllGlobals();
        resetScopedMachineDataKeyCacheForTests();
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('attempts the peer mediation direct route before server RPC for direct-eligible same-machine methods', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcWithPeerMediationRouteSpy.mockResolvedValueOnce({ direct: true });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true },
        });

        expect(result).toEqual({ direct: true });
        expect(machineRpcWithPeerMediationRouteSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true },
            resolveDirectRoute: expect.any(Function),
            postDirect: expect.any(Function),
            serverFallback: expect.any(Function),
            recordReceipt: expect.any(Function),
        }));
        expect(machineRpcSpy).not.toHaveBeenCalled();
        expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
    });

    it('preserves server fallback when the peer mediation direct route is unavailable', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockResolvedValue({ routed: 'server' });
        machineRpcWithPeerMediationRouteSpy.mockImplementationOnce(async (params: {
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
            reasonCode: 'topology_unavailable',
        }));

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true },
        });

        expect(result).toEqual({ routed: 'server' });
        expect(machineRpcWithPeerMediationRouteSpy).toHaveBeenCalledOnce();
        expect(machineRpcSpy).toHaveBeenCalledWith(
            'machine-1',
            RPC_METHODS.DAEMON_MEMORY_STATUS,
            { includeWorkers: true },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
    });

    it('delegates to apiSocket.machineRPC when target server is omitted', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockResolvedValue({ ok: true });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const { readCachedMachineRpcDirectRoute } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 1 },
        });

        expect(result).toEqual({ ok: true });
        expect(machineRpcSpy).toHaveBeenCalledWith(
            'machine-1',
            'method-test',
            { value: 1 },
            expect.objectContaining({
                timeoutMs: expect.any(Number),
            }),
        );
        expect(machineRpcSpy.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
            timeoutMs: expect.any(Number),
        }));
        expect((machineRpcSpy.mock.calls[0]?.[3] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0);
        expect((machineRpcSpy.mock.calls[0]?.[3] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(30_000);
        expect(readCachedMachineRpcDirectRoute({
            serverId: 'server-a',
            remoteMachineId: 'machine-1',
        })).toEqual({ status: 'unknown' });
        expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
    });

    it('fails closed: forces scoped route for guarded methods when transfer feature payload is unavailable', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        getReadyServerFeaturesSpy.mockResolvedValueOnce(null);
        machineRpcSpy.mockResolvedValueOnce({ ok: true });
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

        const machineEncryption = {
            encryptRaw: vi.fn(async () => 'encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: true })),
        };
        createEncryptionSpy.mockResolvedValue({
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        })));

        const emitWithAck = vi.fn(async (_event: string, _payload: unknown, _opts?: { timeoutMs?: number }) => ({
            ok: true,
            result: 'encrypted-result',
        }));
        const fakeSocket = {
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        };
        createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
            payload: { kind: 'prompt-assets', id: 'asset-a' },
        });

        expect(result).toEqual({ decoded: true });
        expect(machineRpcSpy).not.toHaveBeenCalled();
        expect(createEphemeralSocketSpy).toHaveBeenCalled();
    });

    it('routes RPC through a scoped socket when target server differs from active server', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 1_000_000,
        });
        syncPerformanceTelemetry.reset();

        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
        ]);
        getCredentialsSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });

        const machineEncryption = {
            encryptRaw: vi.fn(async () => 'encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: true })),
        };
        createEncryptionSpy.mockResolvedValue({
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        })));

        const emitWithAck = vi.fn(async () => ({ ok: true, result: 'encrypted-result' }));
        const fakeSocket = {
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        };
        createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const { readCachedMachineRpcDirectRoute } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 2 },
            serverId: 'server-b',
            timeoutMs: 5000,
        });

        expect(result).toEqual({ decoded: true });
        expect(machineRpcSpy).not.toHaveBeenCalled();
        expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            timeoutMs: expect.any(Number),
        }));
        const createEphemeralSocketCalls = createEphemeralSocketSpy.mock.calls as unknown as Array<
            [{ timeoutMs: number; serverUrl?: string; token?: string }]
        >;
        const createEphemeralSocketCall = createEphemeralSocketCalls[0];
        if (!createEphemeralSocketCall) throw new Error('expected createEphemeralSocketClient call');
        const createEphemeralSocketParams = createEphemeralSocketCall[0];
        expect(createEphemeralSocketParams.timeoutMs).toBeGreaterThan(0);
        expect(createEphemeralSocketParams.timeoutMs).toBeLessThanOrEqual(5_000);
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ value: 2 });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect(findTelemetryEvent('sync.encryption.machine.encryptRaw.scopedRpc.other')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, expect.objectContaining({
            method: 'machine-1:method-test',
            params: 'encrypted-payload',
            timeoutMs: expect.any(Number),
        }));
        const emitWithAckCalls = emitWithAck.mock.calls as unknown as Array<
            [string, { method: string; params: string; timeoutMs: number }]
        >;
        const emitWithAckCall = emitWithAckCalls[0];
        if (!emitWithAckCall) throw new Error('expected socket emitWithAck call');
        const emitWithAckParams = emitWithAckCall[1];
        expect(emitWithAckParams.timeoutMs).toBeGreaterThan(0);
        expect(emitWithAckParams.timeoutMs).toBeLessThanOrEqual(5_000);
        expect(readCachedMachineRpcDirectRoute({
            serverId: 'server-b',
            remoteMachineId: 'machine-1',
        })).toEqual({ status: 'unknown' });
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('falls back to a scoped socket on the active server when active machine encryption is unavailable', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockRejectedValue(new Error('Machine encryption not found for machine-1'));
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

        const machineEncryption = {
            encryptRaw: vi.fn(async () => 'encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: true })),
        };
        createEncryptionSpy.mockResolvedValue({
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        })));

        const emitWithAck = vi.fn(async () => ({ ok: true, result: 'encrypted-result' }));
        const fakeSocket = {
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        };
        createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 3 },
        });

        expect(result).toEqual({ decoded: true });
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-a.example.test',
            token: 'token-a',
            timeoutMs: expect.any(Number),
        }));
        expect((createEphemeralSocketSpy.mock.calls[0]?.[0] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0);
        expect((createEphemeralSocketSpy.mock.calls[0]?.[0] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(30_000);
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ value: 3 });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('falls back to a scoped socket when the active rpc path hits an uninitialized encryption dereference', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockRejectedValue(new Error("Cannot read properties of null (reading 'getMachineEncryption')"));
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

        const machineEncryption = {
            encryptRaw: vi.fn(async () => 'encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: true })),
        };
        createEncryptionSpy.mockResolvedValue({
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        })));

        const emitWithAck = vi.fn(async () => ({ ok: true, result: 'encrypted-result' }));
        const fakeSocket = {
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        };
        createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 5 },
        });

        expect(result).toEqual({ decoded: true });
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-a.example.test',
            token: 'token-a',
            timeoutMs: expect.any(Number),
        }));
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ value: 5 });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('falls back to a scoped socket on the active server when the active machine rpc reports method not available', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 1_000_000,
        });
        syncPerformanceTelemetry.reset();

        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockRejectedValue(Object.assign(new Error('RPC method not available'), {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        }));
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

        const machineEncryption = {
            encryptRaw: vi.fn(async () => 'encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: true })),
        };
        createEncryptionSpy.mockResolvedValue({
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        })));

        const emitWithAck = vi.fn(async () => ({ ok: true, result: 'encrypted-result' }));
        const fakeSocket = {
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        };
        createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'spawn-happy-session',
            payload: { directory: '/tmp/repo' },
        });

        expect(result).toEqual({ decoded: true });
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-a.example.test',
            token: 'token-a',
            timeoutMs: expect.any(Number),
        }));
        expect((createEphemeralSocketSpy.mock.calls[0]?.[0] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0);
        expect((createEphemeralSocketSpy.mock.calls[0]?.[0] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(30_000);
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ directory: '/tmp/repo' });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect(findTelemetryEvent('sync.encryption.machine.encryptRaw.scopedRpc.sessionWrite')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('falls back to a scoped socket when the active machine rpc call hangs past the timeout', async () => {
        vi.useFakeTimers();
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockImplementation(() => new Promise(() => {}));
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

        const machineEncryption = {
            encryptRaw: vi.fn(async () => 'encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: true })),
        };
        createEncryptionSpy.mockResolvedValue({
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        })));

        const emitWithAck = vi.fn(async () => ({ ok: true, result: 'encrypted-result' }));
        const fakeSocket = {
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        };
        createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const rpcPromise = machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: { handoffId: 'handoff_1' },
            timeoutMs: 1_000,
        });
        const assertion = expect(rpcPromise).resolves.toEqual({ decoded: true });

        await vi.advanceTimersByTimeAsync(1_000);

        await assertion;
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-a.example.test',
            token: 'token-a',
            timeoutMs: 1,
        }));
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ handoffId: 'handoff_1' });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
            method: 'machine-1:daemon.sessionHandoff.prepareTarget',
            params: 'encrypted-payload',
            timeoutMs: 1,
        });
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('times out when scoped context setup hangs before the daemon sees the rpc', async () => {
        vi.useFakeTimers();
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });
        createEncryptionSpy.mockImplementation(() => new Promise(() => {}));

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const rpcPromise = machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: { handoffId: 'handoff_1' },
            timeoutMs: 1_000,
            preferScoped: true,
        });
        const assertion = expect(rpcPromise).rejects.toMatchObject({
            code: 'MACHINE_RPC_TIMEOUT',
        });

        await vi.advanceTimersByTimeAsync(1_000);

        await assertion;
        expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('times out when scoped socket acquisition hangs before the rpc emit', async () => {
        vi.useFakeTimers();
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

        const machineEncryption = {
            encryptRaw: vi.fn(async () => 'encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: true })),
        };
        createEncryptionSpy.mockResolvedValue({
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        })));
        createEphemeralSocketSpy.mockImplementation(() => new Promise(() => {}));

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const rpcPromise = machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: { handoffId: 'handoff_1' },
            timeoutMs: 1_000,
            preferScoped: true,
        });
        const assertion = expect(rpcPromise).rejects.toMatchObject({
            code: 'MACHINE_RPC_TIMEOUT',
        });

        await vi.advanceTimersByTimeAsync(1_000);

        await assertion;
        expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-a.example.test',
            token: 'token-a',
            timeoutMs: 1_000,
        }));
        expect(machineEncryption.encryptRaw).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('routes directly through a scoped socket when preferScoped is requested on the active server', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

        const machineEncryption = {
            encryptRaw: vi.fn(async () => 'encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: true })),
        };
        createEncryptionSpy.mockResolvedValue({
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        })));

        const emitWithAck = vi.fn(async () => ({ ok: true, result: 'encrypted-result' }));
        const fakeSocket = {
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        };
        createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: { handoffId: 'handoff_1' },
            timeoutMs: 1_000,
            preferScoped: true,
        });

        expect(result).toEqual({ decoded: true });
        expect(machineRpcSpy).not.toHaveBeenCalled();
        expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-a.example.test',
            token: 'token-a',
            timeoutMs: expect.any(Number),
        }));
        expect((createEphemeralSocketSpy.mock.calls[0]?.[0] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0);
        expect((createEphemeralSocketSpy.mock.calls[0]?.[0] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(1_000);
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ handoffId: 'handoff_1' });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    });
});
