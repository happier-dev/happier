import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT } from '@happier-dev/protocol/sessions';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { DEFAULT_MANAGED_CONNECTION_POLICY } from '@happier-dev/connection-supervisor';
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

async function boot(socketRole?: Readonly<{ clientType: 'session-scoped'; sessionId: string }>) {
    const boundary = createSocketIoBoundaryStub();
    ioSpy.mockReturnValue(boundary.socket);
    const { apiSocket } = await import('./apiSocket');
    activeSocket = apiSocket;
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    resetReachability = resetServerReachabilitySupervisors;
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'self' })).toString('base64')}.signature`;
    const config = { endpoint: 'https://server.example.test/', token, serverId: 'socket-test-home',
        generation: 1, ...(socketRole ? { socketRole, request: await createViewerRequest() } : {}) };
    apiSocket.initialize(config, null);
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
    const previousForceWebsocket = process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET;
    afterEach(async () => {
        activeSocket?.disconnect(); activeSocket = undefined;
        await resetReachability?.(); resetReachability = undefined;
        ioSpy.mockReset();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        if (previousForceWebsocket === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET;
        else process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET = previousForceWebsocket;
        if (coldEnvironmentGraph) {
            coldEnvironmentGraph = false;
            vi.resetModules();
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
        expect(socket.io.timeout()).toBe(false);
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
        const update = { body: { t: 'new-message', sid: 'viewed-session' } };
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
