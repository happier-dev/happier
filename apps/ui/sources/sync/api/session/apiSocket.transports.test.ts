import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT } from '@happier-dev/protocol/sessions';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { DEFAULT_MANAGED_CONNECTION_POLICY } from '@happier-dev/connection-supervisor';
import { act, createDeferred, createMachineFixture, renderHook } from '@/dev/testkit';
import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import { useSimulatorRelayIngestion, type UseSimulatorRelayIngestionInput } from '@/components/devices/simulator/relay/useSimulatorRelayIngestion';
import { sealMachineLiveStreamEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import { MACHINE_LIVE_STREAM_SOCKET_EVENT, type MachineLiveStreamStartRequestV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { fetchAndApplyMachines } from '@/sync/engine/machines/syncMachines';
import { encodeBase64 } from '@/encryption/base64';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
// Ordinary transport lifecycles share one real module graph and retire their concrete sockets.
import './apiSocket';

const ioSpy = vi.hoisted(() => vi.fn());
let activeSocket: typeof import('./apiSocket')['apiSocket'] | undefined;
let resetReachability: (() => Promise<void>) | undefined;
let coldEnvironmentGraph = false;
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => ioSpy(...args) }));
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: vi.fn(async () => new Response('{}', { status: 200 })),
    resetRuntimeFetch: () => {},
    setRuntimeFetch: () => {},
}));

async function boot(socketRole?: Readonly<{ clientType: 'session-scoped'; sessionId: string }>, encryption: Encryption | null = null,
    serverId = 'socket-test-home') {
    const boundary = createSocketIoBoundaryStub();
    ioSpy.mockReturnValue(boundary.socket);
    const { apiSocket } = await import('./apiSocket');
    activeSocket = apiSocket;
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    resetReachability = resetServerReachabilitySupervisors;
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'self' })).toString('base64')}.signature`;
    const config = { endpoint: 'https://server.example.test/', token, serverId,
        generation: 1, ...(socketRole ? { socketRole, request: await createViewerRequest() } : {}) };
    apiSocket.initialize(config, encryption);
    await vi.waitFor(() => expect(boundary.socket.connected).toBe(true));
    return { apiSocket, ...boundary };
}

async function createViewerRequest() {
    const { runtimeFetch } = await import('@/utils/system/runtimeFetch');
    // The real embed Session caller supplies a captured endpoint request. Keep
    // that scoped transport lifecycle while replacing only its HTTP bytes.
    return (path: string, init?: RequestInit) => runtimeFetch(new URL(path, 'https://server.example.test/'), init);
}

describe('apiSocket transports and roles', () => {
    it('classifies unavailable Machine content before sending a read', async () => {
        const { apiSocket } = await boot();
        await expect(apiSocket.machineRPC('missing-machine', 'scm.diff.file', {})).rejects.toMatchObject({
            rpcErrorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE',
        });
    });
    it('classifies a disconnected socket before sending a Machine read', async () => {
        storage.setState({ machines: { machine: createMachineFixture({ id: 'machine', storageMode: 'plain' }) } });
        const { apiSocket, trigger } = await boot();
        trigger('disconnect', 'transport close');
        await expect(apiSocket.machineRPC('machine', 'scm.diff.file', {})).rejects.toMatchObject({
            rpcErrorCode: 'RPC_TRANSPORT_UNAVAILABLE',
        });
    });
    const initialState = storage.getState();
    const previousForceWebsocket = process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET;
    afterEach(async () => {
        activeSocket?.disconnect(); activeSocket = undefined;
        await resetReachability?.(); resetReachability = undefined;
        ioSpy.mockReset();
        storage.setState(initialState, true);
        vi.useRealTimers();
        vi.unstubAllGlobals();
        if (previousForceWebsocket === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET;
        else process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET = previousForceWebsocket;
        if (coldEnvironmentGraph) {
            coldEnvironmentGraph = false;
            vi.resetModules();
        }
    });

    it.each(['available', 'cached-available', 'pending-material', 'pending-material-settled', 'locked', 'list-failed', 'disconnected'] as const)('awaits Machine hydration after screen-stream mount without Retry, then respects %s', async outcome => {
        const machineId = 'cold-machine';
        const streamId = 'cold-stream';
        const serverId = resolveServerProfileScopeIdForIdentifier(getActiveServerSnapshot().serverId);
        const secret = new Uint8Array(32).fill(1);
        const dataKey = new Uint8Array(32).fill(2);
        const source = await Encryption.create(secret);
        await source.initializeMachines(new Map([[machineId, dataKey]]));
        const encryption = await Encryption.create(secret);
        const cold = createMachineFixture({ id: machineId, storageMode: 'e2ee', metadata: null,
            ...(outcome === 'cached-available' ? { availability: { kind: 'available' } } : {}),
            ...(outcome.startsWith('pending-material') ? { storageMode: undefined,
                availability: { kind: 'locked', reason: 'encryption_material_unavailable' } } : {}),
            dataEncryptionKey: encodeBase64(await source.encryptEncryptionKey(dataKey), 'base64') });
        storage.setState({ machines: { [machineId]: cold }, machineListStatusByServerId: { [serverId]: 'loading' } });
        const { apiSocket, trigger } = await boot(undefined, encryption, serverId);
        const startRequest: MachineLiveStreamStartRequestV1 = {
            v: 1, streamId, streamFamily: 'screen', sourceId: 'computer-display', routeKind: 'server_relay',
            sourceMachineId: machineId, targetMachineId: machineId,
            authorization: { payload: { v: 1, grantId: 'grant', accountId: 'self', sourceMachineId: machineId,
                targetMachineId: machineId, flowKind: 'live_stream', routeKind: 'server_relay', streamId,
                streamFamily: 'screen', sourceId: 'computer-display', iat: Date.now(), exp: Date.now() + 60_000,
                aud: 'happier-live-stream-relay-authorization' },
                signature: { keyId: 'relay', alg: 'Ed25519', valueBase64Url: 'AbCdEf012_-' } },
        };
        const input: UseSimulatorRelayIngestionInput = {
            transport: { send: (_event, envelope) => apiSocket.sendMachineLiveStreamRelayEnvelope(envelope),
                onEnvelope: listener => apiSocket.onMachineLiveStreamRelayEnvelope(listener) },
            sourceMachineId: machineId, targetMachineId: machineId, streamId, streamFamily: 'screen',
            sourceId: 'computer-display', simulatorId: 'computer-display', caps: {}, sourceCodecs: ['image.frame.v1'],
            // These are the HTTP grant and daemon RPC boundaries. The socket framing, crypto,
            // hydration, relay client, ingestion and player remain the production implementations.
            startProduction: async () => ({ ok: true, routeKind: 'server_relay', startRequest,
                relayAuthorization: startRequest.authorization! }),
            startDaemonRelay: async () => ({ ok: true, streamId }),
        };
        const mounted = await renderHook(() => useSimulatorRelayIngestion(input));
        const frame = await sealMachineLiveStreamEnvelopeV1({ v: 1, sourceMachineId: machineId, targetMachineId: machineId,
            message: { kind: 'frame', frame: { v: 1, streamId, sequence: 1, timestampMs: 1,
                payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64', payloadBase64: 'AQID', payloadSizeBytes: 3 } } },
            { mode: 'e2ee', cipher: source.getMachineEncryption(machineId)! });
        expect(frame.ok).toBe(true);
        if (!frame.ok) throw new Error(frame.code);
        const firstPicture = createDeferred<void>();
        const stopObserving = apiSocket.onMachineLiveStreamRelayEnvelope(envelope => {
            if (envelope.message.kind === 'frame' && envelope.message.frame.streamId === streamId) firstPicture.resolve();
        });
        try {
            await act(async () => trigger(MACHINE_LIVE_STREAM_SOCKET_EVENT, frame.value));
            expect(mounted.getCurrent().playerStatesBySimulatorId['computer-display']?.phase).toBe('opening');
            if (outcome === 'pending-material-settled') {
                await act(async () => storage.getState().markMachineListSettled(serverId));
                await vi.waitFor(() => expect(mounted.getCurrent().playerStatesBySimulatorId['computer-display'])
                    .toMatchObject({ phase: 'stopped', diagnostic: { reasonCode: 'stream_payload_mode_mismatch' } }));
                expect(mounted.getCurrent().playerStatesBySimulatorId['computer-display']?.lastFrameUrl).toBeUndefined();
                return;
            }
            if (outcome === 'list-failed') {
                await act(async () => storage.getState().markMachineListUnavailable(serverId));
                await vi.waitFor(() => expect(mounted.getCurrent().playerStatesBySimulatorId['computer-display'])
                    .toMatchObject({ phase: 'stopped', diagnostic: { reasonCode: 'stream_encryption_material_unavailable' } }));
                expect(mounted.getCurrent().playerStatesBySimulatorId['computer-display']?.lastFrameUrl).toBeUndefined();
                return;
            }
            if (outcome === 'locked') {
                await act(async () => {
                    await encryption.initializeMachines(new Map(), new Set([machineId]));
                    storage.setState({ machines: { [machineId]: { ...cold,
                        availability: { kind: 'locked', reason: 'decryption_failed' } } } });
                });
                await vi.waitFor(() => expect(mounted.getCurrent().playerStatesBySimulatorId['computer-display'])
                    .toMatchObject({ phase: 'stopped', diagnostic: { reasonCode: 'stream_payload_mode_mismatch' } }));
                expect(mounted.getCurrent().playerStatesBySimulatorId['computer-display']?.lastFrameUrl).toBeUndefined();
                return;
            }
            if (outcome === 'disconnected') {
                apiSocket.disconnect();
                await act(async () => {
                    await encryption.initializeMachines(new Map([[machineId, dataKey]]));
                    storage.setState({ machines: { [machineId]: { ...cold, availability: { kind: 'available' } } } });
                });
                expect(mounted.getCurrent().playerStatesBySimulatorId['computer-display']?.lastFrameUrl).toBeUndefined();
                return;
            }
            const metadata = await source.getMachineEncryption(machineId)!.encryptMetadata(createMachineFixture().metadata!);
            await act(async () => {
                await fetchAndApplyMachines({
                    credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'self' })).toString('base64')}.signature`,
                        secret: encodeBase64(secret) }, expectedAccountMode: 'e2ee', sourceServerId: serverId,
                    encryption, machineDataKeys: new Map(),
                    request: async () => new Response(JSON.stringify([{ ...cold, metadata }])),
                    getMachineSnapshot: () => storage.getState().machines,
                    getExistingMachine: id => storage.getState().machines[id],
                    applyMachineDisplayEntries: (machines, options) => storage.getState().replaceMachineDisplays(machines,
                        { sourceServerId: serverId, ...options }),
                    applyMachines: (machines, replace) => storage.getState().applyMachines(machines, replace, { sourceServerId: serverId }),
                    onListComplete: () => storage.getState().markMachineListSettled(serverId),
                });
                await firstPicture.promise;
            });
            expect(mounted.getCurrent().playerStatesBySimulatorId['computer-display'])
                .toMatchObject({ phase: 'playing', lastFrameUrl: 'data:image/jpeg;base64,AQID' });
        } finally {
            stopObserving(); await mounted.unmount();
        }
    });

    it('rejects unwrapped live-stream pixels at socket ingress', async () => {
        const { MACHINE_LIVE_STREAM_SOCKET_EVENT } = await import('@happier-dev/protocol');
        const { apiSocket, trigger } = await boot();
        const received = vi.fn();
        const error = vi.fn();
        const detachError = apiSocket.onError(error);
        const detach = apiSocket.onMachineLiveStreamRelayEnvelope(received);
        trigger(MACHINE_LIVE_STREAM_SOCKET_EVENT, {
            v: 1, sourceMachineId: 'machine-source', targetMachineId: 'viewer-machine',
            message: { kind: 'frame', frame: {
                v: 1, streamId: 'stream_1', sequence: 1, timestampMs: 1000,
                payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64',
                payloadBase64: 'AQID', payloadSizeBytes: 3,
            } },
        });
        expect(received).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(expect.objectContaining({ code: 'stream_payload_invalid' }));
        detachError();
        detach();
    });

    it('keeps the default account handshake and Engine.IO upgrade lifecycle through apiSocket', async () => {
        const { socket } = await boot();
        expect(socket.io.timeout()).toBe(15_000 + 45_000);
        expect(ioSpy).toHaveBeenCalledWith('https://server.example.test', expect.objectContaining({
            path: '/v1/updates/', auth: expect.objectContaining({ clientType: 'user-scoped', clientPurpose: 'sync' }),
            forceNew: true, multiplex: false, reconnection: false, autoConnect: false, withCredentials: false,
        }));
        expect(ioSpy.mock.calls[0]?.[1]).not.toHaveProperty('transports');
    });

    it('uses Engine.IO defaults in browser runtimes', async () => {
        vi.stubGlobal('window', {}); vi.stubGlobal('document', {});
        await boot();
        expect(ioSpy.mock.calls[0]?.[1]).not.toHaveProperty('transports');
    });

    it('delivers Account changes after the same Home and bearer are reapplied while retiring old ingress', async () => {
        const initial = await boot();
        const next = createSocketIoBoundaryStub();
        ioSpy.mockReturnValue(next.socket);
        const received = vi.fn();
        const detach = initial.apiSocket.onMessage('update', received);
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'self' })).toString('base64')}.signature`;
        initial.apiSocket.initialize({ endpoint: 'https://server.example.test/', token, serverId: 'socket-test-home',
            generation: 1 }, null);
        const settled = { id: 'settled', seq: 2, createdAt: 2, body: { t: 'account-change' } };
        await vi.waitFor(() => expect(initial.socket.connected || next.socket.connected).toBe(true));
        (initial.socket.connected ? initial : next).trigger('update', settled);
        expect(received).toHaveBeenCalledWith(settled, { serverId: 'socket-test-home' });
        received.mockClear();
        initial.trigger('update', { ...settled, id: 'retired-socket' });
        expect(received).not.toHaveBeenCalled();
        detach();
    });

    it('preserves caller-configured websocket-only transport', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET = '1';
        // Expo configuration is a boot-time environment boundary, unlike the
        // ordinary reconnect/configuration lifecycles in the neighboring cases.
        vi.resetModules();
        coldEnvironmentGraph = true;
        await boot();
        expect(ioSpy.mock.calls[0]?.[1]).toMatchObject({ transports: ['websocket'] });
    });

    it('replaces the concrete viewer when its Session target changes on the same Home and token', async () => {
        const { apiSocket, socket } = await boot({ clientType: 'session-scoped', sessionId: 'first-session' });
        const next = createSocketIoBoundaryStub();
        ioSpy.mockReturnValue(next.socket);
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'self' })).toString('base64')}.signature`;
        apiSocket.initialize({ endpoint: 'https://server.example.test/', token, serverId: 'socket-test-home',
            generation: 1, socketRole: { clientType: 'session-scoped', sessionId: 'second-session' },
            request: await createViewerRequest() }, null);
        await vi.waitFor(() => expect(next.socket.connected).toBe(true));
        expect(socket.connected).toBe(false);
        expect(ioSpy.mock.calls.at(-1)?.[1]).toMatchObject({
            auth: { clientType: 'session-scoped', sessionId: 'second-session' },
        });
    });

    it('opens a Session viewer without account presence or machine RPC receiver registration', async () => {
        const { replaceExternalSessionStatusDemandViewport, resetExternalSessionStatusDemandCoordinatorForTests } =
            await import('@/sync/runtime/orchestration/externalSessions/externalSessionStatusDemandCoordinator');
        replaceExternalSessionStatusDemandViewport('viewer-test', [{ serverId: 'socket-test-home',
            sessionId: 'viewed-session', machineId: 'machine-1', linkGeneration: 'generation-1', demand: 'open' }]);
        const { apiSocket, socket, trigger, listeners } = await boot({ clientType: 'session-scoped', sessionId: 'viewed-session' });
        expect(ioSpy.mock.calls[0]?.[1]).toMatchObject({ auth: { clientType: 'session-scoped', sessionId: 'viewed-session' } });
        const options: unknown = ioSpy.mock.calls[0]?.[1];
        const auth = (options as { auth: Record<string, unknown> }).auth;
        expect(auth).not.toHaveProperty('machineId');
        expect(listeners.has(SOCKET_RPC_EVENTS.REQUEST)).toBe(false);
        expect(listeners.has(SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT)).toBe(false);
        const update = { body: { t: 'new-message', delivery: 'full' as const, sid: 'viewed-session' } };
        const onUpdate = vi.fn();
        const detachUpdate = apiSocket.onMessage('update', onUpdate);
        trigger('update', update);
        expect(onUpdate).toHaveBeenCalledWith(update, { serverId: 'socket-test-home' });
        expect(onUpdate.mock.calls[0]?.[0]).toBe(update);
        const dispose = apiSocket.registerMachineScopedRpcHandler('machine-1', 'reverse-test', async () => ({}));
        const replacement = createSocketIoBoundaryStub();
        ioSpy.mockReturnValue(replacement.socket);
        vi.useFakeTimers();
        trigger('disconnect', 'transport close');
        await vi.advanceTimersByTimeAsync(DEFAULT_MANAGED_CONNECTION_POLICY.initialFastRetryDelayMs);
        expect(replacement.socket.connected).toBe(true);
        expect(socket.connected).toBe(false);
        expect(socket.emit.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.REGISTER)).toEqual([]);
        expect(socket.emitWithAck.mock.calls.filter(([event]) => event.startsWith('session-human-presence:'))).toEqual([]);
        expect(socket.emit.mock.calls.filter(([event]) => event === 'external-session-status-demand-v1')).toEqual([]);
        expect(replacement.socket.emit.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.REGISTER)).toEqual([]);
        expect(replacement.socket.emitWithAck.mock.calls.filter(([event]) => event.startsWith('session-human-presence:'))).toEqual([]);
        expect(replacement.socket.emit.mock.calls.filter(([event]) => event === 'external-session-status-demand-v1')).toEqual([]);
        dispose();
        expect(socket.emit.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.UNREGISTER)).toEqual([]);
        detachUpdate();
        resetExternalSessionStatusDemandCoordinatorForTests();
    });
});
