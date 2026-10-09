import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import {
    RPC_METHODS,
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
    type SocketRpcAuthorizationContext,
} from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { resetScopedMachineTransportCacheForTests } from './serverScopedRpcPool';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import * as deviceLocalStorage from '@/auth/storage/deviceLocalStorage';
import { resetRunnerCreatorMachineContentKeyTrustProjectionForTests } from '@/sync/domains/ephemeralRunner/runnerCreatorMachineContentKeyTrust';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { MachineEncryption } from '@/sync/encryption/machineEncryption';
import { SecretBoxEncryption } from '@/sync/encryption/encryptor';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';
import { Encryption } from '@/sync/encryption/encryption';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit';

let machineContextOwner: Encryption;
const machineContextAuthority = {
    captureMachineEncryptionContext: (...args: Parameters<Encryption['captureMachineEncryptionContext']>) => machineContextOwner.captureMachineEncryptionContext(...args),
    getMachineEncryptionContext: (...args: Parameters<Encryption['getMachineEncryptionContext']>) => machineContextOwner.getMachineEncryptionContext(...args),
    removeMachineEncryption: (id: string) => machineContextOwner.removeMachineEncryption(id),
};

function createMachineEncryption() {
    const cipher = new MachineEncryption('machine-1', new SecretBoxEncryption(new Uint8Array(32).fill(17)), new EncryptionCache());
    vi.spyOn(cipher, 'encryptRaw');
    vi.spyOn(cipher, 'decryptRaw');
    return cipher;
}
const responder = { mode: 'e2ee' as const, cipher: createMachineEncryption() };
async function boundResponse(payload: { method: string; params: unknown }, value: unknown) {
    const request = await socketRpcCodec.decodeRequestParams(responder, payload.params, payload.method);
    return socketRpcCodec.encodeResponse(responder, value, request.callId);
}

type MachineRpcSpy = (machineId: string, method: string, params: unknown, options?: {
    timeoutMs?: number | null;
    authorization?: SocketRpcAuthorizationContext;
    onIssued?: () => void;
}) => Promise<unknown>;

const machineRpcSpy = vi.hoisted(() => vi.fn<MachineRpcSpy>());
const createEphemeralSocketSpy = vi.hoisted(() => vi.fn());
const getReadyServerFeaturesSpy = vi.hoisted(() => vi.fn());
const getCredentialsSpy = vi.hoisted(() => vi.fn());
const homeCredentialMutationListeners = vi.hoisted(() => new Set<(event: { serverId: string }) => void>());
const createEncryptionSpy = vi.hoisted(() => vi.fn());
const listServerProfilesSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const getAppliedActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const machineRpcWithPeerMediationRouteSpy = vi.hoisted(() => vi.fn());
const resolveServerScopedContextOverrideSpy = vi.hoisted(() => vi.fn());
const runtimeFetchWithServerReachabilitySpy = vi.hoisted(() => vi.fn());
const SECRET_A = btoa('a'.repeat(32));
const SECRET_B = btoa('b'.repeat(32));
const TOKEN_A = `header.${btoa(JSON.stringify({ sub: 'account-a' }))}.signature`;
const TOKEN_B = `header.${btoa(JSON.stringify({ sub: 'account-b' }))}.signature`;


vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (...args: unknown[]) => getReadyServerFeaturesSpy(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: (...args: unknown[]) => createEphemeralSocketSpy(...args),
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: (...args: unknown[]) => runtimeFetchWithServerReachabilitySpy(...args),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: (...args: Parameters<MachineRpcSpy>) => machineRpcSpy(...args),
    },
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/auth/storage/tokenStorage')>(),
    subscribeHomeCredentialMutations: (listener: (event: { serverId: string }) => void) => {
        homeCredentialMutationListeners.add(listener);
        return () => { homeCredentialMutationListeners.delete(listener); };
    },
    isTokenOnlyAuthCredentials: (credentials: {
        secret?: unknown;
        encryption?: unknown;
    }) => !credentials.secret && !credentials.encryption,
    TokenStorage: {
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsSpy(...args),
    },
}));

vi.mock('./resolveServerScopedContext', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./resolveServerScopedContext')>();
    return {
        ...actual,
        resolveServerScopedContext: (...args: Parameters<typeof actual.resolveServerScopedContext>) => {
            const override = resolveServerScopedContextOverrideSpy.getMockImplementation();
            return override
                ? override(...args)
                : actual.resolveServerScopedContext(...args);
        },
    };
});

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: (...args: unknown[]) => createEncryptionSpy(...args),
}));

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return {
        ...createServerProfilesModuleMock({
        listServerProfiles: (...args: unknown[]) => listServerProfilesSpy(...args),
        }),
        loadHomeViewState: () => null,
    };
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: (...args: unknown[]) => getAppliedActiveServerSnapshotSpy(...args),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));

vi.mock('@/sync/domains/machines/peer/mediation/rpc/client', () => ({
    machineRpcWithPeerMediationRoute: (...args: unknown[]) => machineRpcWithPeerMediationRouteSpy(...args),
}));

function findTelemetryEvent(name: string) {
    return syncPerformanceTelemetry.snapshot().events.find((event) => event.name === name);
}

function mockScopedMachineFetch(machine: Readonly<{
    id: string;
    dataEncryptionKey: string | null;
    installationId?: string;
    installationPublicKey?: string;
}>, accountMode: 'e2ee' | 'plain' = 'e2ee'): void {
    runtimeFetchWithServerReachabilitySpy.mockImplementation(async ({ url }: { url: string }) => ({
        ok: true,
        status: 200,
        json: async () => url.includes('/v1/account/encryption') ? { mode: accountMode, updatedAt: 1 } : { machine },
    }));
}

function installDefaultPeerMediationFallback(): void {
    machineRpcWithPeerMediationRouteSpy.mockImplementation(async (params: {
        serverId?: string | null;
        machineId: string;
        method: string;
        payload: unknown;
        timeoutMs?: number;
        authorization?: SocketRpcAuthorizationContext;
        serverFallback: (input: {
            serverId?: string | null;
            machineId: string;
            method: string;
            payload: unknown;
            timeoutMs?: number;
            authorization?: SocketRpcAuthorizationContext;
            reasonCode: string;
        }) => Promise<unknown>;
    }) => await params.serverFallback({
        serverId: params.serverId,
        machineId: params.machineId,
        method: params.method,
        payload: params.payload,
        timeoutMs: params.timeoutMs,
        authorization: params.authorization,
        reasonCode: 'server_required',
    }));
}

// Keep the real crypto and RPC graph construction outside individual deadlines.
// This suite's retained runtime stub must be valid when real Sync initializes.
getActiveServerSnapshotSpy.mockReturnValue({
    serverId: 'server-a', serverUrl: 'https://server-a.example.test', kind: 'custom', generation: 1,
});
await import('@/sync/encryption/encryption');
await import('./serverScopedMachineRpc');
getActiveServerSnapshotSpy.mockReset();

describe('machineRpcWithServerScope', () => {
    it.each(['envelope', 'custody'] as const)('rejects unavailable Machine %s before opening a socket and retires its previous cipher', async (failure) => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        await encryption.initializeMachines(new Map([['machine-1', new Uint8Array(32).fill(2)]]));
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a', serverUrl: 'https://server-a.example.test', kind: 'custom', generation: 1,
        });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
        ]);
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_B, secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
        createEncryptionSpy.mockResolvedValue(encryption);
        if (failure === 'custody') {
            vi.spyOn(deviceLocalStorage, 'readDeviceLocalStorageString').mockRejectedValue(new Error('storage unavailable'));
        }
        mockScopedMachineFetch({ id: 'machine-1', dataEncryptionKey: failure === 'envelope' ? 'invalid-present-envelope' : null });
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            result: await encryption.getMachineEncryption('machine-1')!.encryptRaw({ accepted: true }),
        }));
        createEphemeralSocketSpy.mockResolvedValue({
            timeout: vi.fn(() => ({ emitWithAck })),
            disconnect: vi.fn(),
        });
        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        await expect(machineRpcWithServerScope({
            serverId: 'server-b', machineId: 'machine-1', method: RPC_METHODS.SPAWN_HAPPY_SESSION,
            payload: { directory: '/work' },
        })).rejects.toMatchObject({ rpcErrorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' });
        expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(encryption.getMachineEncryption('machine-1')).toBeNull();
    });

    beforeEach(async () => {
        machineContextOwner = await Encryption.create(new Uint8Array(32).fill(17));
        resetRunnerCreatorMachineContentKeyTrustProjectionForTests();
        // Device custody is an external persistent boundary; successful absence
        // lets real Account-material trust resolution run beneath it.
        vi.spyOn(deviceLocalStorage, 'readDeviceLocalStorageString').mockResolvedValue(null);
        getAppliedActiveServerSnapshotSpy.mockImplementation(() => getActiveServerSnapshotSpy());
        installDefaultPeerMediationFallback();
    });

    afterEach(() => {
        homeCredentialMutationListeners.clear();
        vi.restoreAllMocks();
        machineRpcSpy.mockReset();
        createEphemeralSocketSpy.mockReset();
        getReadyServerFeaturesSpy.mockReset();
        getCredentialsSpy.mockReset();
        createEncryptionSpy.mockReset();
        listServerProfilesSpy.mockReset();
        getActiveServerSnapshotSpy.mockReset();
        getAppliedActiveServerSnapshotSpy.mockReset();
        machineRpcWithPeerMediationRouteSpy.mockReset();
        resolveServerScopedContextOverrideSpy.mockReset();
        runtimeFetchWithServerReachabilitySpy.mockReset();
        vi.unstubAllGlobals();
        resetScopedMachineTransportCacheForTests();
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

    it('binds an omitted peer-mediated RPC to the applied Home while another Home is staged', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            kind: 'custom',
            generation: 2,
        });
        getAppliedActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });
        machineRpcWithPeerMediationRouteSpy.mockResolvedValueOnce({ direct: true });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        await expect(machineRpcWithServerScope({
            machineId: 'machine-shared',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true },
        })).resolves.toEqual({ direct: true });

        expect(machineRpcWithPeerMediationRouteSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'server-a',
            machineId: 'machine-shared',
        }));
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
            authorization?: SocketRpcAuthorizationContext;
            serverFallback: (input: {
                serverId?: string | null;
                machineId: string;
                method: string;
                payload: unknown;
                timeoutMs?: number;
                authorization?: SocketRpcAuthorizationContext;
                reasonCode: string;
            }) => Promise<unknown>;
        }) => await params.serverFallback({
            serverId: params.serverId,
            machineId: params.machineId,
            method: params.method,
            payload: params.payload,
            timeoutMs: params.timeoutMs,
            authorization: params.authorization,
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

    it('supplies canonical server feature relay fallback decisions to peer-mediated heavy voice rpc', async () => {
        const relayCaps = {
            maxBitrateBps: 64_000,
            maxFramesPerSecond: 50,
            maxFrameBytes: 16_000,
            maxDurationMs: 60_000,
            maxTotalBytes: 1_000_000,
            maxConcurrentStreamsPerAccount: 2,
            maxConcurrentStreamsPerSocket: 1,
            maxConcurrentStreamsPerMachine: 1,
        };
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        getReadyServerFeaturesSpy.mockResolvedValueOnce({
            features: {
                machines: {
                    liveStream: {
                        serverRouted: { enabled: true },
                    },
                },
            },
            capabilities: {
                machines: {
                    liveStream: {
                        serverRouted: {
                            caps: relayCaps,
                            disabledReason: null,
                        },
                    },
                },
            },
        });
        machineRpcWithPeerMediationRouteSpy.mockImplementationOnce(async (params: {
            resolveRelayFallback?: (input: {
                method: string;
                reasonCode: string;
                policy: { relayFallback?: unknown };
            }) => Promise<unknown>;
        }) => {
            expect(params.resolveRelayFallback).toEqual(expect.any(Function));
            return await params.resolveRelayFallback?.({
                method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK,
                reasonCode: 'topology_unavailable',
                policy: {
                    relayFallback: {
                        flowKind: 'daemon_voice_audio',
                        defaultSharedServerMode: 'disabled',
                        authorizationRequired: true,
                        relayCapsRequired: true,
                        meteringRequired: true,
                        lifecycleReceiptRequired: true,
                        capProfile: 'machine_live_stream_relay_caps_v1',
                    },
                },
            });
        });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK,
            payload: { streamId: 'stream-1', seq: 1 },
        });

        expect(result).toMatchObject({
            ok: true,
            routeKind: 'server_relay',
            caps: relayCaps,
        });
        expect(getReadyServerFeaturesSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'server-a',
            timeoutMs: undefined,
        }));
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
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                sessionId: 'sess_1',
            },
        });

        expect(result).toEqual({ ok: true });
        expect(machineRpcSpy).toHaveBeenCalledWith(
            'machine-1',
            'method-test',
            { value: 1 },
            expect.objectContaining({
                authorization: {
                    kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                    sessionId: 'sess_1',
                },
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

    it('does not fall back after an exact active machine RPC has been issued', async () => {
        vi.useFakeTimers();
        try {
            getActiveServerSnapshotSpy.mockReturnValue({
                serverId: 'server-a', serverUrl: 'https://server-a.example.test', kind: 'custom', generation: 1,
            });
            machineRpcSpy.mockImplementation(async (_machineId, _method, _params, options) => {
                options?.onIssued?.();
                return await new Promise<never>(() => {});
            });
            const onIssued = vi.fn();
            const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
            const result = machineRpcWithServerScope({
                machineId: 'machine-1', method: RPC_METHODS.SPAWN_HAPPY_SESSION,
                payload: { sessionId: 'session-1' }, timeoutMs: 25, onIssued,
            });
            const settled = result.then(
                () => ({ state: 'resolved' as const }),
                (error: unknown) => ({ state: 'rejected' as const, error }),
            );

            await vi.advanceTimersByTimeAsync(25);
            await expect(settled).resolves.toMatchObject({ state: 'rejected', error: expect.any(Error) });
            expect(onIssued).toHaveBeenCalledTimes(1);
            expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps an admitted exact active observation past the setup timeout without replay', async () => {
        vi.useFakeTimers();
        try {
            getActiveServerSnapshotSpy.mockReturnValue({
                serverId: 'server-a', serverUrl: 'https://server-a.example.test', kind: 'custom', generation: 1,
            });
            let resolveResult!: (value: unknown) => void;
            machineRpcSpy.mockImplementation(async (_machineId, _method, _params, options) => {
                options?.onIssued?.();
                return await new Promise((resolve) => { resolveResult = resolve; });
            });
            const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
            const result = machineRpcWithServerScope({
                machineId: 'machine-1', method: 'execution.run.get', payload: { runId: 'run-1' },
                operationTimeoutMs: null, onIssued: () => undefined,
            });
            const settled = vi.fn();
            void result.then(settled, settled);
            await vi.advanceTimersByTimeAsync(31_000);
            expect(settled).not.toHaveBeenCalled();
            expect(machineRpcSpy.mock.calls[0]?.[3]).toMatchObject({ timeoutMs: null });
            expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
            resolveResult({ run: { runId: 'run-1', status: 'running' } });
            await expect(result).resolves.toMatchObject({ run: { status: 'running' } });
        } finally { vi.useRealTimers(); }
    });

    it.each(['daemon.filesystem.upload', 'daemon.filesystem.download'] as const)('keeps concrete transfer custody mounted while blocking approval is pending (%s)', async (actionId) => {
        vi.useFakeTimers();
        try {
            getActiveServerSnapshotSpy.mockReturnValue({ serverId: 'server-a', serverUrl: 'https://server-a.example.test', generation: 1 });
            getAppliedActiveServerSnapshotSpy.mockReturnValue({ serverId: 'server-a', serverUrl: 'https://server-a.example.test', generation: 1 });
            getReadyServerFeaturesSpy.mockResolvedValue(createRootLayoutFeaturesResponse({ features: { machines: { transfer: { enabled: true } } } }));
            let resolveResult!: (value: unknown) => void;
            machineRpcSpy.mockImplementation(async (_machineId, _method, _params, options) => {
                options?.onIssued?.();
                return await new Promise(resolve => { resolveResult = resolve; });
            });
            const { callFilesystemTransferAction } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/filesystemTransferActionClient');
            const pending = callFilesystemTransferAction({ actionId, machineId: 'machine-1', serverId: 'server-a',
                input: { rootPath: '/repo', path: 'binary.dat' }, timeoutMs: 5_000 });
            const settled = vi.fn();
            void pending.then(settled, settled);
            await vi.advanceTimersByTimeAsync(31_000);
            expect(settled).not.toHaveBeenCalled();
            resolveResult({ success: true, status: 'accepted', operationId: 'transfer-operation' });
            await expect(pending).resolves.toMatchObject({ status: 'accepted' });
            expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it('keeps recovery Account custody independent of the completed upload signal and retires it on actual Home credential replacement', async () => {
        listServerProfilesSpy.mockReturnValue([{ id: 'server-a', serverUrl: 'https://server-a.example.test' }]);
        getActiveServerSnapshotSpy.mockReturnValue({ serverId: 'server-a', serverUrl: 'https://server-a.example.test', generation: 1 });
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_A });
        const upload = new AbortController();
        const { captureFilesystemTransferAccountScope } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/filesystemTransferAccountScope');
        const account = await captureFilesystemTransferAccountScope('server-a', upload.signal);
        try {
            expect(account.accountId).toBe('account-a');
            upload.abort();
            expect(account.signal.aborted).toBe(true);
            expect(account.accountLifetime.isCurrent()).toBe(true);
            getCredentialsSpy.mockResolvedValue({ token: TOKEN_B });
            for (const listener of [...homeCredentialMutationListeners]) listener({ serverId: 'server-a' });
            expect(account.accountLifetime.isCurrent()).toBe(false);
        } finally { account.dispose(); }
        expect(homeCredentialMutationListeners.size).toBe(0);
    });

    it('refuses a public prepared entry descriptor without replacing its original export custody', async () => {
        const { copyPreparedFilesystemFile } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/preparedFilesystemCopy');
        await expect(copyPreparedFilesystemFile({ input: { kind: 'prepared_transfer',
            source: { kind: 'entry_tree', serverId: 'server-a', machineId: 'source', rootPath: '/source', path: 'tree', sourceId: 'original-source',
                sizeBytes: 1, sha256: 'a'.repeat(64), entryTree: { operationId: 'original-export', expectation: { kind: 'directory', fingerprint: 'b'.repeat(64) }, blobs: [] } },
            destination: { serverId: 'server-a', machineId: 'destination', rootPath: '/destination', path: 'tree' }, overwrite: false, recursive: true },
            acquireSourceCarrier: async () => { throw new Error('Replacement source carrier'); },
            acquireDestinationCarrier: async () => { throw new Error('Replacement destination carrier'); },
        })).resolves.toMatchObject({ success: false, status: 'failed', errorCode: 'filesystem_transfer_custody_required' });
        expect(machineRpcSpy).not.toHaveBeenCalled();
    });

    it.each(['file', 'entry_tree', 'entry_tree_unknown'] as const)('streams qualified copy bytes into the admitted import before acknowledging the source (%s)', async (mode) => {
        getActiveServerSnapshotSpy.mockReturnValue({ serverId: 'server-a', serverUrl: 'https://server-a.example.test', generation: 1 });
        getAppliedActiveServerSnapshotSpy.mockReturnValue({ serverId: 'server-a', serverUrl: 'https://server-a.example.test', generation: 1 });
        getReadyServerFeaturesSpy.mockResolvedValue(createRootLayoutFeaturesResponse({ features: { machines: { transfer: { enabled: true } } } }));
        const { createTransferRecipientKeyPair, createEncryptedTransferChunkEnvelope, decryptEncryptedTransferChunkEnvelope } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption');
        const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const binary = new Uint8Array([0, 255, 128, 42]);
        const bytes = mode === 'file' ? binary : new TextEncoder().encode('{"entry":".hidden/binary.dat","blob":"copy-blob"}');
        const hash = async (payload: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', payload)), byte => byte.toString(16).padStart(2, '0')).join('');
        const sha256 = await hash(bytes);
        const blobSha256 = await hash(binary);
        const expectation = { kind: 'directory' as const, fingerprint: 'a'.repeat(64) };
        const entryTree = { operationId: 'copy-source', expectation, blobs: [{ transferId: 'copy-blob', sizeBytes: binary.length, manifestHash: `sha256:${blobSha256}` }] };
        const recipient = createTransferRecipientKeyPair();
        const payloads = new Map([['copy-source', { bytes, sha256 }], ['copy-blob', { bytes: binary, sha256: blobSha256 }]]);
        const received = new Map<string, number[]>();
        const finalized = new Set<string>();
        const preparedImport = (uploadId: string, expectedSizeBytes: number) => ({ uploadId, destDisplayPath: '/destination/copied.dat',
            expectedSizeBytes, chunkSizeBytes: 2, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
            expiresAt: 50_000, endpointCandidates: [{ kind: 'http' as const, url: `http://127.0.0.1:4002/machine-transfers/direct/imports/${uploadId}`, expiresAt: 50_000 }] });
        machineRpcSpy.mockImplementation(async (_machineId, method, request) => {
            const wire = request as { input: { destination?: { destinationId: string }; source?: { sourceId: string } } };
            if (method === 'daemon.filesystem.download') return { success: true, status: 'accepted', operationId: 'source-operation',
                destinationId: wire.input.destination!.destinationId, prepared: { transferId: 'copy-source', name: 'binary.dat', sizeBytes: bytes.length,
                    manifestHash: `sha256:${sha256}`, expiresAt: 50_000, endpointCandidates: [{ kind: 'http',
                        url: 'http://127.0.0.1:4001/machine-transfers/direct/Y29weS1zb3VyY2U', authorizationToken: 'source-token', expiresAt: 50_000 }] },
                ...(mode === 'file' ? {} : { entryTree }) };
            if (method === 'daemon.filesystem.copy') return { success: true, status: 'accepted', operationId: 'copy-operation',
                sourceId: wire.input.source!.sourceId, prepared: mode === 'file' ? preparedImport('copy-import', bytes.length)
                    : { manifest: preparedImport('copy-import', bytes.length), blobs: [{ transferId: 'copy-blob', prepared: preparedImport('blob-import', binary.length) }] } };
            if (method === ACTION_OPERATION_RPC_METHODS_V2.get) {
                expect(finalized).toEqual(new Set(['copy-import', 'blob-import']));
                expect(request).toMatchObject({ operationId: 'copy-operation', waitForTerminal: true });
                return { kind: 'found', operation: { version: 1, operationId: 'copy-operation', revision: 3,
                    actionId: 'daemon.filesystem.copy', state: mode === 'entry_tree_unknown' ? 'running' : 'succeeded',
                    scope: { accountId: 'account-a', machineId: 'destination-machine' }, title: 'Copy', createdAt: 1, startedAt: 2,
                    cancellation: 'supported', ...(mode === 'entry_tree_unknown' ? { observation: { kind: 'outcome_uncertain', code: 'indeterminate' } }
                        : { settledAt: 3, result: { success: true, status: 'completed', sourceId: 'copy-source', path: '/destination/copied.dat', expectation } }) } };
            }
            return { success: true, aborted: true };
        });
        const encrypted = new Map<string, Awaited<ReturnType<typeof createEncryptedTransferChunkEnvelope>>>();
        setRuntimeFetch(async (request, init) => {
            const url = String(request);
            const pathname = new URL(url).pathname;
            if (url.includes('/open')) {
                const sourceId = atob(pathname.split('/').at(-2)!);
                const payload = payloads.get(sourceId)!;
                encrypted.set(sourceId, await createEncryptedTransferChunkEnvelope({ transferId: sourceId, sequence: 0, payload: payload.bytes,
                    recipientPublicKeyBase64: new Headers(init?.headers).get('x-happier-transfer-recipient-public-key')! }));
                return Response.json({ transferId: sourceId, sizeBytes: payload.bytes.length, totalChunks: 1, manifestHash: `sha256:${payload.sha256}` });
            }
            if (url.includes('/imports/') && url.includes('/chunks/')) {
                const uploadId = pathname.split('/imports/')[1]!.split('/')[0]!;
                const body = JSON.parse(String(init?.body)) as { payloadBase64: string; encryptedDataKeyEnvelopeBase64: string };
                const sequence = Number(url.split('/').at(-1));
                const chunk = await decryptEncryptedTransferChunkEnvelope({ transferId: uploadId, sequence, ...body,
                    recipientSecretKeySeed: recipient.recipientSecretKeySeed });
                const previous = received.get(uploadId) ?? [];
                previous.push(...chunk); received.set(uploadId, previous);
                return Response.json({ success: true });
            }
            if (url.includes('/finalize')) {
                const uploadId = pathname.split('/imports/')[1]!.split('/')[0]!;
                const payload = payloads.get(uploadId === 'copy-import' ? 'copy-source' : 'copy-blob')!;
                expect(received.get(uploadId)).toEqual(Array.from(payload.bytes)); finalized.add(uploadId);
                return Response.json({ success: true, finalized: { success: true, path: '/destination/copied.dat', sizeBytes: payload.bytes.length }, sha256: payload.sha256 });
            }
            if (url.includes('/complete')) { expect(finalized).toEqual(new Set(mode === 'file' ? ['copy-import'] : ['copy-import', 'blob-import'])); return Response.json({ success: true }); }
            const sourceId = atob(pathname.split('/chunks/')[0]!.split('/').at(-1)!);
            return Response.json({ transferId: sourceId, kind: 'chunk', sequence: 0, ...encrypted.get(sourceId) });
        });
        try {
            const { copyPreparedFilesystemFile } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/preparedFilesystemCopy');
            const source = { serverId: 'server-a', machineId: 'source-machine', rootPath: '/source', path: 'binary.dat' };
            const destination = { serverId: 'server-a', machineId: 'destination-machine', rootPath: '/destination', path: 'copied.dat' };
            await expect(copyPreparedFilesystemFile({ input: mode === 'file' ? { kind: 'prepared_transfer',
                source: { kind: 'file', serverId: 'server-a', machineId: 'source-machine', rootPath: '/source', path: 'binary.dat', sourceId: 'copy-source', sizeBytes: bytes.length, sha256 },
                destination, overwrite: false, recursive: false } : { kind: 'target_copy', source, destination, overwrite: false, recursive: true },
                acquireSourceCarrier: async () => ({ kind: 'native_http', localOrigin: 'http://127.0.0.1:4001', release: async () => {} }),
                acquireDestinationCarrier: async () => ({ kind: 'native_http', localOrigin: 'http://127.0.0.1:4002', release: async () => {} }),
            })).resolves.toMatchObject(mode === 'file' ? { success: true, status: 'completed', sizeBytes: bytes.length }
                : mode === 'entry_tree_unknown' ? { success: false, status: 'unknown', errorCode: 'indeterminate' }
                    : { success: true, status: 'completed', expectation });
        } finally { resetRuntimeFetch(); }
    });

    it.each(['capability', 'installDecision', 'marketplaceQuery'] as const)('keeps plugin capability execution pending until its admitted daemon operation completes (%s)', async (operation) => {
        vi.useFakeTimers();
        try {
            getActiveServerSnapshotSpy.mockReturnValue({
                serverId: 'server-a', serverUrl: 'https://server-a.example.test', kind: 'custom', generation: 1,
            });
            // A wrong timed-out implementation may try its ordinary scoped fallback;
            // keep that transport available so RED is not a missing-credentials fixture failure.
            getCredentialsSpy.mockResolvedValue({ token: TOKEN_A });
            mockScopedMachineFetch({ id: 'machine-1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }, 'plain');
            const emitWithAck = vi.fn(() => new Promise<never>(() => {}));
            createEphemeralSocketSpy.mockResolvedValue({
                timeout: () => ({ emitWithAck }), emitWithAck, emit: vi.fn(), disconnect: vi.fn(),
            });
            let resolveResult!: (value: unknown) => void;
            machineRpcSpy.mockImplementation(async (_machineId, _method, _params, options) => {
                options?.onIssued?.();
                return await new Promise((resolve) => { resolveResult = resolve; });
            });
            const page = { revision: 7, items: [], nextCursor: null, sources: [], diagnostics: [] };
            const pending = operation === 'capability'
                ? (await import('@/sync/ops/capabilities')).machineCapabilitiesInvoke('machine-1', {
                    id: 'tool.plugins', method: 'install', params: { pluginId: 'example' },
                }, { timeoutMs: null })
                : operation === 'installDecision'
                    ? (await import('@/sync/ops/machinePluginInstallDecision')).machinePluginInstallDecision('machine-1', {
                        timeoutMs: null, isAuthorityCurrent: () => true,
                        decision: { pendingChangeId: 'pending-1', decision: 'cancel' },
                    })
                    : (await import('@/sync/ops/machineMarketplaceSources')).machineMarketplaceIndexQuery('machine-1', {
                        text: '', cursor: null, limit: 50, filters: {},
                    }, { timeoutMs: null });
            const settled = vi.fn();
            void pending.then(settled, settled);
            await vi.advanceTimersByTimeAsync(601_000);
            expect(settled).not.toHaveBeenCalled();
            resolveResult(operation === 'capability' ? { ok: true, result: { installed: true } }
                : operation === 'installDecision' ? { kind: 'cancelled' } : page);
            await expect(pending).resolves.toMatchObject(operation === 'capability'
                ? { supported: true, response: { ok: true, result: { installed: true } } }
                : operation === 'installDecision' ? { supported: true, outcome: { kind: 'cancelled' } } : page);
            expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it('keeps capability inventory loading until its admitted daemon probe completes', async () => {
        vi.useFakeTimers();
        try {
            getActiveServerSnapshotSpy.mockReturnValue({
                serverId: 'server-a', serverUrl: 'https://server-a.example.test', kind: 'custom', generation: 1,
            });
            let resolveResult!: (value: unknown) => void;
            machineRpcSpy.mockImplementation(async (_machineId, _method, _params, options) => {
                options?.onIssued?.();
                return await new Promise((resolve) => { resolveResult = resolve; });
            });
            const { prefetchMachineCapabilities, getMachineCapabilitiesCacheState } = await import('@/hooks/server/useMachineCapabilitiesCache');
            const target = { machineId: 'machine-1', cacheKeySalt: 'slow-plugin-probe' };
            const pending = prefetchMachineCapabilities({ ...target, request: { checklistId: 'new-session' } });
            await vi.advanceTimersByTimeAsync(31_000);
            expect(getMachineCapabilitiesCacheState(target.machineId, undefined, target.cacheKeySalt)?.status).toBe('loading');
            resolveResult({ protocolVersion: 1, results: {} });
            await pending;
            expect(getMachineCapabilitiesCacheState(target.machineId, undefined, target.cacheKeySalt)?.status).toBe('loaded');
        } finally { vi.useRealTimers(); }
    });

    it('decrypts a scoped E2EE observation after its caller-owned wait without an expired setup budget', async () => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { createFakeCryptoWorker } = await import('@/sync/encryption/nativeCryptoWorker/fakeCryptoWorker');
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        const worker = createFakeCryptoWorker();
        encryption.configureNativeCryptoWorker({ worker: {
            ...worker,
            // Native crypto completion is an OS boundary; retain its real codec
            // while making response work outlast the exhausted 1ms setup budget.
            decryptSecretboxJson: async (request) => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                return await worker.decryptSecretboxJson(request);
            },
        }, routing: { mode: 'require', minPayloadBytes: 0 } });
        getActiveServerSnapshotSpy.mockReturnValue({ serverId: 'server-a', serverUrl: 'https://server-a.example.test', generation: 1 });
        listServerProfilesSpy.mockReturnValue([{ id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' }]);
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_B, secret: SECRET_B });
        createEncryptionSpy.mockResolvedValue(encryption);
        mockScopedMachineFetch({ id: 'machine-1', dataEncryptionKey: null });
        let resolveAck!: (value: unknown) => void;
        let issuedRequest!: { method: string; params: unknown };
        const emitWithAck = vi.fn((_event: string, request: { method: string; params: unknown }) => {
            issuedRequest = request;
            return new Promise((resolve) => { resolveAck = resolve; });
        });
        const socket = { timeout: vi.fn(() => ({ emitWithAck })), emitWithAck, emit: vi.fn(), disconnect: vi.fn() };
        createEphemeralSocketSpy.mockResolvedValue(socket);
        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const pending = machineRpcWithServerScope({ serverId: 'server-b', machineId: 'machine-1',
            method: 'execution.run.get', payload: { runId: 'run-1' }, operationTimeoutMs: null, onIssued: () => undefined });
        const settled = vi.fn();
        void pending.then(settled, settled);
        await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledOnce());
        const codec = { mode: 'e2ee' as const, cipher: encryption.getMachineEncryption('machine-1')! };
        const request = await socketRpcCodec.decodeRequestParams(codec, issuedRequest.params, issuedRequest.method);
        const ciphertext = await socketRpcCodec.encodeResponse(codec, { run: { status: 'running' } }, request.callId);
        const startedAt = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(startedAt + 31_000);
        resolveAck({ ok: true, result: ciphertext });
        await expect(pending).resolves.toMatchObject({ run: { status: 'running' } });
        expect(socket.timeout).not.toHaveBeenCalled();
        expect(socket.disconnect).toHaveBeenCalledOnce();
    });
    it.each(['exact', 'ordered'] as const)('fences delayed active preparation after %s scoped fallback starts', async (dispatchMode) => {
        vi.useFakeTimers();
        try {
            getActiveServerSnapshotSpy.mockReturnValue({
                serverId: 'server-a', serverUrl: 'https://server-a.example.test', kind: 'custom', generation: 1,
            });
            let releaseActive!: () => void;
            const activeGate = new Promise<void>((resolve) => { releaseActive = resolve; });
            let activeEmits = 0;
            machineRpcSpy.mockImplementation(async (_machineId, _method, _params, options) => {
                await activeGate;
                options?.onIssued?.();
                activeEmits += 1;
                return { source: 'late-active' };
            });
            getCredentialsSpy.mockResolvedValue({ token: TOKEN_A, secret: SECRET_A });
            const machineEncryption = createMachineEncryption();
            createEncryptionSpy.mockResolvedValue({
                ...machineContextAuthority,
                decryptEncryptionKey: vi.fn(async () => null),
                initializeMachines: vi.fn(async () => {}),
                getMachineEncryption: vi.fn(() => machineEncryption),
            });
            mockScopedMachineFetch({ id: 'machine-1', dataEncryptionKey: null });
            const scopedEmit = vi.fn(async (_event: string, payload: { method: string; params: unknown }) => ({ ok: true, result: await boundResponse(payload, { source: 'scoped' }) }));
            createEphemeralSocketSpy.mockResolvedValue({
                timeout: vi.fn(() => ({ emitWithAck: scopedEmit })),
                emit: vi.fn(),
                disconnect: vi.fn(),
            });
            const onIssued = vi.fn();
            const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
            const result = machineRpcWithServerScope({
                machineId: 'machine-1', method: RPC_METHODS.SPAWN_HAPPY_SESSION,
                payload: { sessionId: 'session-1' }, timeoutMs: 25,
                skipTransferPolicyEvaluation: true,
                ...(dispatchMode === 'exact' ? { onIssued } : { onDispatched: onIssued }),
            });

            await vi.advanceTimersByTimeAsync(0);
            expect(machineRpcSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(25);
            expect(scopedEmit).toHaveBeenCalledTimes(1);
            await expect(result).resolves.toEqual({ source: 'scoped' });
            releaseActive();
            await Promise.resolve();
            await Promise.resolve();

            expect(scopedEmit).toHaveBeenCalledTimes(1);
            expect(onIssued).toHaveBeenCalledTimes(1);
            expect(activeEmits).toBe(0);
        } finally {
            vi.useRealTimers();
        }
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
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_A, secret: SECRET_A });

        const machineEncryption = createMachineEncryption();
        createEncryptionSpy.mockResolvedValue({
                ...machineContextAuthority,
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        mockScopedMachineFetch({ id: 'machine-1', dataEncryptionKey: null });

        const emitWithAck = vi.fn(async (_event: string, payload: { method: string; params: unknown }, _opts?: { timeoutMs?: number }) => ({
            ok: true,
            result: await boundResponse(payload, { decoded: true }),
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
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
        ]);
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_B, secret: SECRET_B });

        const machineEncryption = createMachineEncryption();
        createEncryptionSpy.mockResolvedValue({
                ...machineContextAuthority,
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        mockScopedMachineFetch({ id: 'machine-1', dataEncryptionKey: null });

        const emitWithAck = vi.fn(async (_event: string, payload: { method: string; params: unknown }) => ({ ok: true, result: await boundResponse(payload, { decoded: true }) }));
        const fakeSocket = {
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        };
        createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const { readCachedMachineRpcDirectRoute } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 1_000_000,
        });
        syncPerformanceTelemetry.reset();
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 2 },
            serverId: 'server-b',
            timeoutMs: 5000,
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                sessionId: 'sess_2',
            },
        });

        expect(result).toEqual({ decoded: true });
        expect(machineRpcSpy).not.toHaveBeenCalled();
        expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-b.example.test',
            token: TOKEN_B,
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
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith(expect.objectContaining({ v: 2, k: 'req', c: expect.stringMatching(/^[0-9a-f]{32}$/), p: { value: 2 } }));
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith(expect.any(String));
        expect(findTelemetryEvent('sync.encryption.machine.encryptRaw.scopedRpc.other')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, expect.objectContaining({
            method: 'machine-1:method-test',
            params: expect.any(String),
            timeoutMs: expect.any(Number),
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                sessionId: 'sess_2',
            },
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

    it('routes scoped plaintext machine RPC with token-only credentials and no account encryption', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
        ]);
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_B });
        mockScopedMachineFetch({
            id: 'machine-plain',
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        }, 'plain');
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            result: { decoded: true },
        }));
        createEphemeralSocketSpy.mockResolvedValue({
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        await expect(machineRpcWithServerScope({
            machineId: 'machine-plain',
            method: 'method-test',
            payload: { value: 2 },
            serverId: 'server-b',
            timeoutMs: 5_000,
        })).resolves.toEqual({ decoded: true });

        expect(createEncryptionSpy).not.toHaveBeenCalled();
        expect(emitWithAck).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.CALL,
            expect.objectContaining({
                method: 'machine-plain:method-test',
                params: { value: 2 },
            }),
        );
        await expect(machineRpcWithServerScope({
            machineId: 'machine-plain', method: RPC_METHODS.SESSION_SPAWN_NEW,
            payload: { credential: 'must-not-be-emitted' }, serverId: 'server-b',
            requireEncryptedPayload: true,
        })).rejects.toMatchObject({ rpcErrorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' });
        expect(emitWithAck).toHaveBeenCalledTimes(1);
    });

    it.each(['e2ee', 'plain'] as const)('keeps %s requester Account material installation-sealed on the existing Plain Machine carrier', async accountMode => {
        getActiveServerSnapshotSpy.mockReturnValue({ serverId: 'server-a', serverUrl: 'https://server-a.example.test', kind: 'custom', generation: 1 });
        listServerProfilesSpy.mockReturnValue([{ id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' }]);
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_B });
        // RFC 8032 installation test vector; the real shared seal/open codec remains in the path.
        const installationPublicKey = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';
        const privateHex = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
        const installationPrivateKey = Uint8Array.from(privateHex.match(/../gu)!, byte => Number.parseInt(byte, 16));
        mockScopedMachineFetch({ id: 'machine-plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            installationId: 'installation', installationPublicKey }, 'plain');
        let emitted: unknown;
        const emitWithAck = vi.fn(async (_event: string, payload: { params: unknown }) => {
            emitted = payload.params;
            return { ok: true, result: { decoded: true } };
        });
        createEphemeralSocketSpy.mockResolvedValue({ timeout: vi.fn(() => ({ emitWithAck })), emit: vi.fn(), disconnect: vi.fn() });
        const request = { kind: 'requester_session_bootstrap_v1', input: {
            executionTarget: { serverId: 'server-b', machineId: 'machine-plain' },
            directory: { kind: 'path', path: '/workspace' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        }, requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: {
            token: TOKEN_B, ...(accountMode === 'e2ee' ? { secret: SECRET_B } : {}),
        } } } as const;
        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        if (accountMode === 'plain') {
            // Reach the ordinary public UI spawn sender, not an explicit private-transport flag.
            const { dispatchSessionSpawnNewToMachine } = await import('@/sync/ops/actions/sessionSpawnNewAction');
            await expect(dispatchSessionSpawnNewToMachine({ payload: request.input, requesterBootstrap: request.requesterBootstrap }))
                .resolves.toEqual({ decoded: true });
        } else {
            await expect(machineRpcWithServerScope({ machineId: 'machine-plain', method: RPC_METHODS.SESSION_SPAWN_NEW,
                payload: request, serverId: 'server-b', requireEncryptedPayload: true })).resolves.toEqual({ decoded: true });
        }
        expect(emitted).toMatchObject({ kind: request.kind, input: request.input,
            requesterBootstrap: { kind: 'installation_sealed_v1', installationId: 'installation' } });
        expect(JSON.stringify(emitted)).not.toContain(TOKEN_B);
        expect(JSON.stringify(emitted)).not.toContain(SECRET_B);
        const { openSessionRequesterBootstrapRpcRequestV1 } = await import('@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1');
        expect(openSessionRequesterBootstrapRpcRequestV1({ request: emitted, machineId: 'machine-plain',
            installationId: 'installation', installationPrivateKey })).toEqual(request);
        for (const unavailableKey of [undefined, 'AAAA', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=']) {
            mockScopedMachineFetch({ id: 'machine-plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                installationId: 'installation', ...(unavailableKey ? { installationPublicKey: unavailableKey } : {}) }, 'plain');
            await expect(machineRpcWithServerScope({ machineId: 'machine-plain', method: RPC_METHODS.SESSION_SPAWN_NEW,
                payload: request, serverId: 'server-b', requireEncryptedPayload: true }))
                .rejects.toMatchObject({ rpcErrorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' });
        }
        expect(emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('preserves issued cancellation disposition when mapping the scoped machine abort error', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a', serverUrl: 'https://server-a.example.test', kind: 'custom', generation: 1,
        });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
        ]);
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_B });
        mockScopedMachineFetch({ id: 'machine-plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }, 'plain');
        let resolveAck!: (value: unknown) => void;
        const emitWithAck = vi.fn<(event: string, payload: unknown) => Promise<unknown>>(
            () => new Promise((resolve) => { resolveAck = resolve; }),
        );
        const socket = { timeout: vi.fn(() => ({ emitWithAck })), emit: vi.fn(), disconnect: vi.fn() };
        createEphemeralSocketSpy.mockResolvedValueOnce(socket);
        const controller = new AbortController();
        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const pending = machineRpcWithServerScope({
            machineId: 'machine-plain', method: 'method-test', payload: {},
            serverId: 'server-b', timeoutMs: 5_000, signal: controller.signal,
        });
        const outcome = pending.catch((error: unknown) => error);
        await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledTimes(1));
        const payload = emitWithAck.mock.calls[0]?.[1] as { requestId?: unknown };
        controller.abort();
        const error = await outcome;
        expect(error).toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
        const { readRpcRequestDisposition } = await import('@happier-dev/sync-client');
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
        expect(payload.requestId).toEqual(expect.any(String));
        expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, { requestId: payload.requestId });
        expect(socket.disconnect).toHaveBeenCalledTimes(1);
        resolveAck({ ok: true, result: { stale: true } });
        await expect(pending).rejects.toBe(error);
    });

    it('hands browser-Iroh carrier custody to the pooled socket without releasing it after the logical machine RPC', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        const releaseCarrier = vi.fn(async () => {});
        const carrierRequests: Array<{ url: string; init: RequestInit }> = [];
        const homeCarrier = {
            leaseId: 'browser-lease-1',
            homeServerIdentityId: 'server-b',
            endpointId: 'a'.repeat(64),
            appliedRelayUrls: ['https://relay.example.test'],
            readObservedPath: () => 'relay' as const,
            request: async (url: string, init: RequestInit) => {
                carrierRequests.push({ url, init });
                if (url.includes('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
                return Response.json({
                    machine: {
                        id: 'machine-plain',
                        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    },
                });
            },
            createWebSocket: () => ({}),
            release: releaseCarrier,
        };
        resolveServerScopedContextOverrideSpy.mockResolvedValue({
            scope: 'scoped',
            machineId: 'machine-plain',
            timeoutMs: 5_000,
            targetServerId: 'server-b',
            targetServerUrl: 'https://server-b.example.test',
            targetAccountId: 'account-b',
            token: TOKEN_B,
            encryption: null,
            runtimeOrigin: 'https://server-b.example.test',
            carrier: 'iroh',
            homeCarrier,
            release: releaseCarrier,
        });
        const emitWithAck = vi.fn(async () => ({ ok: true, result: { decoded: true } }));
        const disconnect = vi.fn();
        createEphemeralSocketSpy.mockImplementationOnce(async (params: {
            takeCarrierRelease?: () => (() => Promise<void>) | undefined;
        }) => {
            expect(params.takeCarrierRelease?.()).toBe(releaseCarrier);
            return {
                timeout: vi.fn(() => ({ emitWithAck })),
                emit: vi.fn(),
                disconnect,
            };
        });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        await expect(machineRpcWithServerScope({
            machineId: 'machine-plain',
            method: 'method-test',
            payload: { value: 2 },
            serverId: 'server-b',
            timeoutMs: 5_000,
            onIssued: vi.fn(),
        })).resolves.toEqual({ decoded: true });

        expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            carrier: 'iroh',
            homeCarrier: expect.objectContaining({ endpointId: homeCarrier.endpointId }),
            takeCarrierRelease: expect.any(Function),
        }));
        expect(carrierRequests.filter(({ url }) => url.includes('/v1/machines/'))).toHaveLength(1);
        expect(carrierRequests[0]?.url).toBe('https://server-b.example.test/v1/machines/machine-plain');
        expect(runtimeFetchWithServerReachabilitySpy).not.toHaveBeenCalled();
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(releaseCarrier).not.toHaveBeenCalled();
    });

    it('falls back to a scoped socket on the active server when active machine encryption is unavailable', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockRejectedValue(new Error('Machine encryption not found for machine-1'));
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_A, secret: SECRET_A });

        const machineEncryption = createMachineEncryption();
        createEncryptionSpy.mockResolvedValue({
                ...machineContextAuthority,
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        mockScopedMachineFetch({ id: 'machine-1', dataEncryptionKey: null });

        const emitWithAck = vi.fn(async (_event: string, payload: { method: string; params: unknown }) => ({ ok: true, result: await boundResponse(payload, { decoded: true }) }));
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
            token: TOKEN_A,
            timeoutMs: expect.any(Number),
        }));
        expect((createEphemeralSocketSpy.mock.calls[0]?.[0] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0);
        expect((createEphemeralSocketSpy.mock.calls[0]?.[0] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(30_000);
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith(expect.objectContaining({ v: 2, k: 'req', c: expect.stringMatching(/^[0-9a-f]{32}$/), p: { value: 3 } }));
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith(expect.any(String));
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
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_A, secret: SECRET_A });

        const machineEncryption = createMachineEncryption();
        createEncryptionSpy.mockResolvedValue({
                ...machineContextAuthority,
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        mockScopedMachineFetch({ id: 'machine-1', dataEncryptionKey: null });

        const emitWithAck = vi.fn(async (_event: string, payload: { method: string; params: unknown }) => ({ ok: true, result: await boundResponse(payload, { decoded: true }) }));
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
            token: TOKEN_A,
            timeoutMs: expect.any(Number),
        }));
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith(expect.objectContaining({ v: 2, k: 'req', c: expect.stringMatching(/^[0-9a-f]{32}$/), p: { value: 5 } }));
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith(expect.any(String));
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('falls back to a scoped socket on the active server when the active machine rpc reports method not available', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockRejectedValue(Object.assign(new Error('RPC method not available'), {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        }));
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_A, secret: SECRET_A });

        const machineEncryption = createMachineEncryption();
        createEncryptionSpy.mockResolvedValue({
                ...machineContextAuthority,
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        mockScopedMachineFetch({ id: 'machine-1', dataEncryptionKey: null });

        const emitWithAck = vi.fn(async (_event: string, payload: { method: string; params: unknown }) => ({ ok: true, result: await boundResponse(payload, { decoded: true }) }));
        const fakeSocket = {
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        };
        createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 1_000_000,
        });
        syncPerformanceTelemetry.reset();
        const payload = {
            creationKey: 'manual:voice-v2-contract',
            executionTarget: {
                serverId: 'server-a',
                machineId: 'machine-1',
            },
            directory: '/tmp/repo',
            agentTarget: {
                kind: 'agent' as const,
                identity: {
                    pluginId: 'happier.agent.codex',
                    localId: 'codex',
                },
            },
        };
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: RPC_METHODS.SESSION_SPAWN_NEW,
            payload,
        });

        expect(result).toEqual({ decoded: true });
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://server-a.example.test',
            token: TOKEN_A,
            timeoutMs: expect.any(Number),
        }));
        expect((createEphemeralSocketSpy.mock.calls[0]?.[0] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0);
        expect((createEphemeralSocketSpy.mock.calls[0]?.[0] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(30_000);
        expect(machineRpcSpy).toHaveBeenCalledWith(
            'machine-1',
            RPC_METHODS.SESSION_SPAWN_NEW,
            payload,
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith(expect.objectContaining({ v: 2, k: 'req', c: expect.stringMatching(/^[0-9a-f]{32}$/), p: payload }));
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith(expect.any(String));
        expect(findTelemetryEvent('sync.encryption.machine.encryptRaw.scopedRpc.sessionWrite')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, expect.objectContaining({
            method: `machine-1:${RPC_METHODS.SESSION_SPAWN_NEW}`,
        }));
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('falls back to a scoped socket with a fresh timeout budget when the active machine rpc call hangs', async () => {
        vi.useFakeTimers();
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockImplementation(() => new Promise(() => {}));
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_A, secret: SECRET_A });

        const machineEncryption = createMachineEncryption();
        createEncryptionSpy.mockResolvedValue({
                ...machineContextAuthority,
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        mockScopedMachineFetch({ id: 'machine-1', dataEncryptionKey: null });

        const emitWithAck = vi.fn(async (_event: string, payload: { method: string; params: unknown }) => ({ ok: true, result: await boundResponse(payload, { decoded: true }) }));
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
            token: TOKEN_A,
            timeoutMs: 1_000,
        }));
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith(expect.objectContaining({ v: 2, k: 'req', c: expect.stringMatching(/^[0-9a-f]{32}$/), p: { handoffId: 'handoff_1' } }));
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith(expect.any(String));
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
            method: 'machine-1:daemon.sessionHandoff.prepareTarget',
            params: expect.any(String),
            timeoutMs: 1_000,
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
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_A, secret: SECRET_A });
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
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_A, secret: SECRET_A });

        const machineEncryption = createMachineEncryption();
        createEncryptionSpy.mockResolvedValue({
                ...machineContextAuthority,
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        mockScopedMachineFetch({ id: 'machine-1', dataEncryptionKey: null });
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
            token: TOKEN_A,
            timeoutMs: 1_000,
        }));
        expect(machineEncryption.encryptRaw).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('reports the total rpc budget when a late scoped rpc emit exhausts the remaining timeout', async () => {
        vi.useFakeTimers();
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_A, secret: SECRET_A });

        const machineEncryption = createMachineEncryption();
        createEncryptionSpy.mockResolvedValue({
                ...machineContextAuthority,
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        mockScopedMachineFetch({ id: 'machine-1', dataEncryptionKey: null });

        const emitWithAck = vi.fn(() => new Promise(() => {}));
        const fakeSocket = {
            timeout: vi.fn(() => ({ emitWithAck })),
            emit: vi.fn(),
            disconnect: vi.fn(),
        };
        createEphemeralSocketSpy.mockImplementationOnce(async () => {
            await new Promise((resolve) => setTimeout(resolve, 999));
            return fakeSocket;
        });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const rpcPromise = machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: { handoffId: 'handoff_1' },
            timeoutMs: 1_000,
            preferScoped: true,
        });
        const capturedError = rpcPromise.catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(1_000);

        await expect(capturedError).resolves.toMatchObject({
            code: 'MACHINE_RPC_TIMEOUT',
            timeoutMs: 1_000,
            remainingTimeoutMs: 1,
            message: expect.stringContaining('after 1000ms'),
        });
        expect(fakeSocket.timeout).toHaveBeenCalledWith(1);
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
        getCredentialsSpy.mockResolvedValue({ token: TOKEN_A, secret: SECRET_A });

        const machineEncryption = createMachineEncryption();
        createEncryptionSpy.mockResolvedValue({
                ...machineContextAuthority,
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        mockScopedMachineFetch({ id: 'machine-1', dataEncryptionKey: null });

        const emitWithAck = vi.fn(async (_event: string, payload: { method: string; params: unknown }) => ({ ok: true, result: await boundResponse(payload, { decoded: true }) }));
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
            token: TOKEN_A,
            timeoutMs: expect.any(Number),
        }));
        expect((createEphemeralSocketSpy.mock.calls[0]?.[0] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0);
        expect((createEphemeralSocketSpy.mock.calls[0]?.[0] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(1_000);
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith(expect.objectContaining({ v: 2, k: 'req', c: expect.stringMatching(/^[0-9a-f]{32}$/), p: { handoffId: 'handoff_1' } }));
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith(expect.any(String));
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    });
});
