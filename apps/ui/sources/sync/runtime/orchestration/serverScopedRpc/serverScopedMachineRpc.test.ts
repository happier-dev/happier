import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { resetScopedMachineDataKeyCacheForTests } from './serverScopedRpcPool';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { createServerFetchWithReachabilityProbe } from '@/dev/testkit';

const machineRpcSpy = vi.hoisted(() => vi.fn());
const createEphemeralSocketSpy = vi.hoisted(() => vi.fn());
const getCredentialsSpy = vi.hoisted(() => vi.fn());
const createEncryptionSpy = vi.hoisted(() => vi.fn());
const listServerProfilesSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const activeApiSocketHarness = vi.hoisted(() => ({
    useReal: false,
    real: null as any,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: (...args: unknown[]) => createEphemeralSocketSpy(...args),
}));

vi.mock('@/sync/api/session/apiSocket', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/apiSocket')>();
    activeApiSocketHarness.real = actual.apiSocket;
    return {
        ...actual,
        apiSocket: {
            machineRPC: (...args: unknown[]) => activeApiSocketHarness.useReal
                ? actual.apiSocket.machineRPC(...args as [string, string, unknown, any])
                : machineRpcSpy(...args),
        },
    };
});

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsSpy(...args),
    },
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: (...args: unknown[]) => createEncryptionSpy(...args),
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createServerProfilesModuleMock({
        importOriginal,
        overrides: {
            listServerProfiles: (...args: unknown[]) => listServerProfilesSpy(...args),
        },
    });
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

function findTelemetryEvent(name: string) {
    return syncPerformanceTelemetry.snapshot().events.find((event) => event.name === name);
}

function installRealActiveMachineRpc(params: Readonly<{
    machineEncryption: { encryptRaw: (payload: unknown) => Promise<unknown>; decryptRaw: (payload: unknown) => Promise<unknown> } | null;
    socket: unknown;
}>): void {
    activeApiSocketHarness.useReal = true;
    activeApiSocketHarness.real.encryption = {
        getMachineEncryption: () => params.machineEncryption,
    };
    activeApiSocketHarness.real.socket = params.socket;
    activeApiSocketHarness.real.currentConnectionState = { phase: 'online' };
}

function installScopedFallback(): Readonly<{
    machineEncryption: { encryptRaw: ReturnType<typeof vi.fn>; decryptRaw: ReturnType<typeof vi.fn> };
    emitWithAck: ReturnType<typeof vi.fn>;
}> {
    getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });
    const machineEncryption = {
        encryptRaw: vi.fn(async () => 'scoped-encrypted-payload'),
        decryptRaw: vi.fn(async () => ({ decoded: 'scoped' })),
    };
    createEncryptionSpy.mockResolvedValue({
        decryptEncryptionKey: vi.fn(async () => null),
        initializeMachines: vi.fn(async () => {}),
        getMachineEncryption: vi.fn(() => machineEncryption),
    });
    vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => ({
        ok: true,
        json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
    }))));
    const emitWithAck = vi.fn(async () => ({ ok: true, result: 'scoped-encrypted-result' }));
    createEphemeralSocketSpy.mockResolvedValueOnce({
        timeout: vi.fn(() => ({ emitWithAck })),
        emit: vi.fn(),
        disconnect: vi.fn(),
    });
    return { machineEncryption, emitWithAck };
}

describe('machineRpcWithServerScope', () => {
    afterEach(() => {
        machineRpcSpy.mockReset();
        createEphemeralSocketSpy.mockReset();
        getCredentialsSpy.mockReset();
        createEncryptionSpy.mockReset();
        listServerProfilesSpy.mockReset();
        getActiveServerSnapshotSpy.mockReset();
        vi.unstubAllGlobals();
        resetScopedMachineDataKeyCacheForTests();
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
        vi.useRealTimers();
        activeApiSocketHarness.useReal = false;
        if (activeApiSocketHarness.real) {
            activeApiSocketHarness.real.socket = null;
            activeApiSocketHarness.real.encryption = null;
        }
    });

    it('delegates to apiSocket.machineRPC when target server is omitted', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        const onIssued = vi.fn();
        machineRpcSpy.mockImplementation(async (...args: unknown[]) => {
            const options = args[3] as { onIssued?: () => void } | undefined;
            options?.onIssued?.();
            return { ok: true };
        });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const { readCachedMachineRpcDirectRoute } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 1 },
            onIssued,
        });

        expect(result).toEqual({ ok: true });
        expect(machineRpcSpy).toHaveBeenCalledWith(
            'machine-1',
            'method-test',
            { value: 1 },
            { timeoutMs: 30000, onIssued: expect.any(Function) },
        );
        expect(readCachedMachineRpcDirectRoute({
            serverId: 'server-a',
            remoteMachineId: 'machine-1',
        })).toEqual(expect.objectContaining({
            status: 'viable',
        }));
        expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
        expect(onIssued).toHaveBeenCalledTimes(1);
    });

    it('preserves authorization on active direct machine RPC calls', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockResolvedValue({ ok: true });

        const authorization = { kind: 'session.write', sessionId: 'sess_1' } as const;
        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        await expect(machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'daemon.sessionRunner.restart',
            payload: { reason: 'manual' },
            authorization,
        })).resolves.toEqual({ ok: true });

        expect(machineRpcSpy).toHaveBeenCalledWith(
            'machine-1',
            'daemon.sessionRunner.restart',
            { reason: 'manual' },
            { timeoutMs: 30000, authorization },
        );
        expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
    });

    it('falls back before exact issuance when active machine encryption is missing', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        const activeEmitWithAck = vi.fn();
        installRealActiveMachineRpc({
            machineEncryption: null,
            socket: { timeout: vi.fn(() => ({ emitWithAck: activeEmitWithAck })), emitWithAck: activeEmitWithAck },
        });
        const scoped = installScopedFallback();
        const onIssued = vi.fn(() => {
            expect(scoped.machineEncryption.encryptRaw).toHaveBeenCalledTimes(1);
            expect(activeEmitWithAck).not.toHaveBeenCalled();
        });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        await expect(machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'spawn-happy-session',
            payload: { value: 1 },
            onIssued,
        })).resolves.toEqual({ decoded: 'scoped' });

        expect(onIssued).toHaveBeenCalledTimes(1);
        expect(scoped.emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('falls back before exact issuance when the active socket is missing', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        const activeEncryption = {
            encryptRaw: vi.fn(async () => 'active-encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: 'active' })),
        };
        installRealActiveMachineRpc({ machineEncryption: activeEncryption, socket: null });
        const scoped = installScopedFallback();
        const onIssued = vi.fn(() => {
            expect(activeEncryption.encryptRaw).toHaveBeenCalledTimes(1);
            expect(scoped.machineEncryption.encryptRaw).toHaveBeenCalledTimes(1);
        });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        await expect(machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'spawn-happy-session',
            payload: { value: 2 },
            onIssued,
        })).resolves.toEqual({ decoded: 'scoped' });

        expect(onIssued).toHaveBeenCalledTimes(1);
        expect(scoped.emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('signals exact issuance once immediately before the real active socket emit', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        const activeEncryption = {
            encryptRaw: vi.fn(async () => 'active-encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: 'active' })),
        };
        const activeEmitWithAck = vi.fn(async () => ({ ok: true, result: 'active-encrypted-result' }));
        const timeout = vi.fn(() => ({ emitWithAck: activeEmitWithAck }));
        installRealActiveMachineRpc({
            machineEncryption: activeEncryption,
            socket: { timeout, emitWithAck: activeEmitWithAck },
        });
        const onIssued = vi.fn(() => {
            expect(activeEncryption.encryptRaw).toHaveBeenCalledTimes(1);
            expect(timeout).toHaveBeenCalledWith(5_000);
            expect(activeEmitWithAck).not.toHaveBeenCalled();
        });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        await expect(machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'spawn-happy-session',
            payload: { value: 3 },
            timeoutMs: 5_000,
            onIssued,
        })).resolves.toEqual({ decoded: 'active' });

        expect(onIssued).toHaveBeenCalledTimes(1);
        expect(activeEmitWithAck).toHaveBeenCalledTimes(1);
        expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
    });

    it('does not fall back after an exact active emission times out', async () => {
        vi.useFakeTimers();
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        const activeEncryption = {
            encryptRaw: vi.fn(async () => 'active-encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: 'active' })),
        };
        const activeEmitWithAck = vi.fn(() => new Promise<unknown>(() => {}));
        installRealActiveMachineRpc({
            machineEncryption: activeEncryption,
            socket: { timeout: vi.fn(() => ({ emitWithAck: activeEmitWithAck })), emitWithAck: activeEmitWithAck },
        });
        installScopedFallback();
        const onIssued = vi.fn();

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'spawn-happy-session',
            payload: { value: 4 },
            timeoutMs: 1_000,
            onIssued,
        });
        const expectation = expect(result).rejects.toThrow('Machine RPC timed out');
        await vi.advanceTimersByTimeAsync(1_000);
        await expectation;

        expect(onIssued).toHaveBeenCalledTimes(1);
        expect(activeEmitWithAck).toHaveBeenCalledTimes(1);
        expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('prevents a timed-out active preparation from emitting after exact scoped fallback starts', async () => {
        vi.useFakeTimers();
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        let resolveActiveEncryption!: (value: string) => void;
        const activeEncryption = {
            encryptRaw: vi.fn(() => new Promise<string>((resolve) => {
                resolveActiveEncryption = resolve;
            })),
            decryptRaw: vi.fn(async () => ({ decoded: 'active' })),
        };
        const activeEmitWithAck = vi.fn(async () => ({ ok: true, result: 'active-encrypted-result' }));
        installRealActiveMachineRpc({
            machineEncryption: activeEncryption,
            socket: { timeout: vi.fn(() => ({ emitWithAck: activeEmitWithAck })), emitWithAck: activeEmitWithAck },
        });
        const scoped = installScopedFallback();
        const onIssued = vi.fn();

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'spawn-happy-session',
            payload: { value: 6 },
            timeoutMs: 1_000,
            onIssued,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(result).resolves.toEqual({ decoded: 'scoped' });

        resolveActiveEncryption('active-encrypted-payload');
        await vi.runAllTicks();
        await Promise.resolve();

        expect(onIssued).toHaveBeenCalledTimes(1);
        expect(scoped.emitWithAck).toHaveBeenCalledTimes(1);
        expect(activeEmitWithAck).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('retains active-timeout scoped fallback for generic machine RPC calls', async () => {
        vi.useFakeTimers();
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        const activeEncryption = {
            encryptRaw: vi.fn(async () => 'active-encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: 'active' })),
        };
        const activeEmitWithAck = vi.fn(() => new Promise<unknown>(() => {}));
        installRealActiveMachineRpc({
            machineEncryption: activeEncryption,
            socket: { timeout: vi.fn(() => ({ emitWithAck: activeEmitWithAck })), emitWithAck: activeEmitWithAck },
        });
        const scoped = installScopedFallback();

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: { value: 5 },
            timeoutMs: 1_000,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(result).resolves.toEqual({ decoded: 'scoped' });

        expect(activeEmitWithAck).toHaveBeenCalledTimes(1);
        expect(scoped.emitWithAck).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
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

        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        }))));

        const emitWithAck = vi.fn(async () => ({ ok: true, result: 'encrypted-result' }));
        const fakeSocket = {
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        };
        createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);
        const onIssued = vi.fn(() => {
            expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ value: 2 });
            expect(createEphemeralSocketSpy).toHaveBeenCalledTimes(1);
            expect(fakeSocket.timeout).toHaveBeenCalledWith(5000);
            expect(emitWithAck).not.toHaveBeenCalled();
        });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const { readCachedMachineRpcDirectRoute } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 2 },
            serverId: 'server-b',
            timeoutMs: 5000,
            onIssued,
        });

        expect(result).toEqual({ decoded: true });
        expect(machineRpcSpy).not.toHaveBeenCalled();
        expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            timeoutMs: 5000,
        }));
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ value: 2 });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect(findTelemetryEvent('sync.encryption.machine.encryptRaw.scopedRpc.other')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
            method: 'machine-1:method-test',
            params: 'encrypted-payload',
            timeoutMs: 5000,
        });
        expect(readCachedMachineRpcDirectRoute({
            serverId: 'server-b',
            remoteMachineId: 'machine-1',
        })).toEqual(expect.objectContaining({
            status: 'viable',
        }));
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
        expect(onIssued).toHaveBeenCalledTimes(1);
    });

    it('preserves authorization on scoped machine RPC socket calls', async () => {
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

        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        }))));

        const emitWithAck = vi.fn(async () => ({ ok: true, result: 'encrypted-result' }));
        const fakeSocket = {
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        };
        createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

        const authorization = { kind: 'session.write', sessionId: 'sess_1' } as const;
        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        await expect(machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'daemon.sessionRunner.restart',
            payload: { reason: 'manual' },
            serverId: 'server-b',
            timeoutMs: 5000,
            authorization,
        })).resolves.toEqual({ decoded: true });

        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
            method: 'machine-1:daemon.sessionRunner.restart',
            params: 'encrypted-payload',
            authorization,
            timeoutMs: 5000,
        });
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('unwraps singleton scoped machine RPC acknowledgement arrays before decrypting the result', async () => {
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

        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        }))));

        const emitWithAck = vi.fn(async () => ({ ok: true, result: ['encrypted-result'] }));
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
            payload: { value: 2 },
            serverId: 'server-b',
        });

        expect(result).toEqual({ decoded: true });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
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

        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        }))));

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
            timeoutMs: 30000,
        }));
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ value: 3 });
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

        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        }))));

        const emitWithAck = vi.fn(async () => ({ ok: true, result: 'encrypted-result' }));
        const fakeSocket = {
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        };
        createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const authorization = { kind: 'session.write', sessionId: 'sess_1' } as const;
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'spawn-happy-session',
            payload: { directory: '/tmp/repo' },
            authorization,
        });

        expect(result).toEqual({ decoded: true });
        expect(machineRpcSpy).toHaveBeenCalledWith(
            'machine-1',
            'spawn-happy-session',
            { directory: '/tmp/repo' },
            { timeoutMs: 30000, authorization },
        );
        expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-a.example.test',
            token: 'token-a',
            timeoutMs: 30000,
        }));
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ directory: '/tmp/repo' });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
            method: 'machine-1:spawn-happy-session',
            params: 'encrypted-payload',
            authorization,
            timeoutMs: 30000,
        });
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

        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        }))));

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

        await vi.advanceTimersByTimeAsync(1_000);

        await expect(rpcPromise).resolves.toEqual({ decoded: true });
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-a.example.test',
            token: 'token-a',
            timeoutMs: 1_000,
        }));
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ handoffId: 'handoff_1' });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
            method: 'machine-1:daemon.sessionHandoff.prepareTarget',
            params: 'encrypted-payload',
            timeoutMs: 1_000,
        });
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
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

        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        }))));

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
            timeoutMs: 1_000,
        }));
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ handoffId: 'handoff_1' });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    });
});
