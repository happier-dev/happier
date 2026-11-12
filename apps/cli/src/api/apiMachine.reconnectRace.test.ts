import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import { FeaturesResponseSchema, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';

import { bindApiSessionSocketSequenceMock, createApiSessionSocketStub, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { logger } from '@/ui/logger';
import { ApiMachineClient } from './apiMachine';
import type { RpcHandlerManager } from './rpc/RpcHandlerManager';

const ioMock = vi.hoisted(() => vi.fn());
const probeReadiness = vi.hoisted(() => vi.fn(async () => ({ status: 'ready' as const })));

// Only network, environment and logging boundaries are replaced. Both the
// connection supervisor and RPC manager execute their production lifecycle.
vi.mock('socket.io-client', () => ({ io: ioMock }));
vi.mock('@/configuration', () => ({ configuration: {
    serverUrl: 'https://example.test', apiServerUrl: 'https://example.test',
    activeServerId: 'reconnect-race-home', currentCliVersion: '0.0.0-test',
    socketForceWebsocketOnly: false, socketIoTransports: ['polling', 'websocket'],
    activeServerDir: '/private/tmp/happier-api-machine-reconnect-race/server',
    happyHomeDir: '/private/tmp/happier-api-machine-reconnect-race',
} }));
vi.mock('@/utils/proxy/socketIoProxy', () => ({ getSocketIoProxyOptions: () => ({}) }));
vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({ createLoopbackReadinessProbe: () => probeReadiness }));
vi.mock('@/ui/logger', () => ({ logger: {
    debug: vi.fn(), info: vi.fn(), infoFile: vi.fn(), warn: vi.fn(), warnLocalFile: vi.fn(), debugLargeJson: vi.fn(),
} }));

const clients: ApiMachineClient[] = [];
const states = new WeakMap<ApiMachineClient, ManagedConnectionState>();

function readState(client: ApiMachineClient): ManagedConnectionState {
    const state = states.get(client);
    if (!state) throw new Error('Expected an observed connection state');
    return state;
}

function createSocket(id: string): ApiSessionSocketStub {
    return createApiSessionSocketStub({
        id, disconnectReason: 'transport close',
        emitWithAck: (event, payload) => {
            if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) return { v: 1, result: 'success', revision: 1 };
            if (event === 'machine-update-state') {
                const update = payload as { expectedVersion: number; daemonState: string };
                return { result: 'success', version: update.expectedVersion + 1, daemonState: update.daemonState };
            }
            return { result: 'success', version: 1 };
        },
    });
}

function createClient() {
    const client = new ApiMachineClient('token', {
        id: 'machine-1', encryptionMode: 'plain',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    }, {
        runtimeId: 'runtime-dev', cliVersion: '0.2.4-dev', publicReleaseChannel: 'dev',
        startupSource: 'manual', serviceManaged: false,
    });
    clients.push(client);
    client.onConnectionStateChange(state => states.set(client, state));
    return client;
}

function sendTransfer(client: ApiMachineClient) {
    client.sendMachineTransferEnvelope({ targetMachineId: 'machine-2', envelope: {
        transferId: 'transfer-1', kind: 'chunk', sequence: 1, payloadBase64: 'YQ==',
    } });
}

function expectTransfer(socket: ApiSessionSocketStub) {
    expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, expect.objectContaining({ targetMachineId: 'machine-2' }));
}

async function connectPair() {
    const first = createSocket('first');
    const second = createSocket('second');
    bindApiSessionSocketSequenceMock(ioMock, [first, second]);
    const client = createClient();
    const onConnect = vi.fn();
    const ownershipConflict = vi.fn();
    client.connect({ onConnect, onOwnershipConflict: ownershipConflict });
    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));
    return { client, first, second, onConnect, ownershipConflict };
}

async function reconnect(pair: Awaited<ReturnType<typeof connectPair>>) {
    pair.first.disconnect();
    await vi.waitFor(() => expect(pair.onConnect).toHaveBeenCalledTimes(2));
    expect(pair.second.connected).toBe(true);
}

describe('ApiMachineClient reconnect race handling', () => {
    beforeEach(() => {
        vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({})), {
            status: 200, headers: { 'content-type': 'application/json' },
        })));
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) await client.shutdown();
        ioMock.mockReset();
        probeReadiness.mockClear();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    it('does not let a queued stale disconnect callback clear a newer transport socket', async () => {
        const pair = await connectPair();
        // Capture native callbacks before retirement, as an event already queued by Socket.IO.
        const queued = pair.first.getHandlers('disconnect');
        await reconnect(pair);
        for (const callback of queued) callback('transport close');
        sendTransfer(pair.client);
        expectTransfer(pair.second);
    });

    it('does not dispatch a stale RPC and dispatches once through the current transport', async () => {
        const pair = await connectPair();
        const manager = Reflect.get(pair.client, 'rpcHandlerManager') as RpcHandlerManager;
        const effect = vi.fn(async () => ({ ok: true }));
        manager.registerHandler('neutral.reconnect', effect);
        const queuedRequest = pair.first.getHandler(SOCKET_RPC_EVENTS.REQUEST);
        expect(queuedRequest).toBeDefined();
        const callId = '0123456789abcdef0123456789abcdef';
        const params = await socketRpcCodec.encodeParams({ mode: 'plain' }, {}, { method: 'machine-1:neutral.reconnect', callId });
        const request = { method: 'machine-1:neutral.reconnect', params, requestId: 'rpc_23b2ed82-2ef7-4e4e-af0f-f64d599a08c6' };
        await reconnect(pair);
        const staleAck = vi.fn();
        queuedRequest!(request, staleAck);
        expect(staleAck).not.toHaveBeenCalled();
        expect(effect).not.toHaveBeenCalled();
        expect(logger.warnLocalFile).toHaveBeenCalledWith('[API MACHINE] RPC transport retired before acknowledgement', expect.objectContaining({
            method: 'neutral.reconnect', requestId: request.requestId, phase: 'before-handler', sameSocket: false,
        }));
        const currentAck = vi.fn();
        pair.second.trigger(SOCKET_RPC_EVENTS.REQUEST, request, currentAck);
        await vi.waitFor(() => expect(currentAck).toHaveBeenCalledTimes(1));
        const response = await socketRpcCodec.decodeResult({ mode: 'plain' }, { ok: true, result: currentAck.mock.calls[0][0] }, callId);
        // This neutral test-only handler has no protected Action/Session route.
        // Its successful reply proves the real current dispatch path is live.
        expect(response).toEqual({ ok: true });
        expect(effect).toHaveBeenCalledTimes(1);
    });

    it('clears the active send route immediately when the current transport disconnects', async () => {
        const pair = await connectPair();
        pair.first.emit.mockClear();
        pair.first.disconnect();
        sendTransfer(pair.client);
        expect(pair.first.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, expect.anything());
    });

    it('does not let queued auth failure callbacks from an older transport clear the current socket', async () => {
        const pair = await connectPair();
        const queued = pair.first.getHandlers('connect_error');
        await reconnect(pair);
        for (const callback of queued) callback(Object.assign(new Error('expired token'), { data: { statusCode: 401 } }));
        sendTransfer(pair.client);
        expectTransfer(pair.second);
        expect(readState(pair.client).phase).toBe('online');
    });

    it('stops reconnecting and reports a relay ownership conflict from connect_error', async () => {
        const socket = createSocket('conflict');
        bindApiSessionSocketSequenceMock(ioMock, [socket]);
        const client = createClient();
        const ownershipConflict = vi.fn();
        const onConnect = vi.fn();
        client.connect({ onOwnershipConflict: ownershipConflict, onConnect });
        await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
        expect(ioMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ auth: expect.objectContaining({
            runtimeId: 'runtime-dev', cliVersion: '0.2.4-dev', publicReleaseChannel: 'dev', startupSource: 'manual', serviceManaged: false,
        }) }));
        const owner = { cliVersion: '0.2.0', publicReleaseChannel: 'stable', startupSource: 'background-service', serviceManaged: true,
            serviceLabel: 'com.happier.cli.daemon.default' };
        socket.trigger('connect_error', { message: 'machine-owner-conflict', data: { error: 'machine-owner-conflict', statusCode: 409, owner } });
        await vi.waitFor(() => expect(readState(client).phase).toBe('shutting_down'));
        expect(ownershipConflict).toHaveBeenCalledWith({ owner });
        expect(socket.connected).toBe(false);
    });

    it('redacts active non-ownership connect errors without stopping a usable transport', async () => {
        const pair = await connectPair();
        pair.first.trigger('connect_error', { message: 'transport rejected', name: 'Error', code: 'ERR_BAD_REQUEST',
            data: { error: 'transport-not-ready', statusCode: 503, secret: 'must-not-log' } });
        expect(logger.warn).toHaveBeenCalledWith('[API MACHINE] Machine socket connect error', {
            message: 'transport rejected', name: 'Error', code: 'ERR_BAD_REQUEST', statusCode: 503,
        });
        expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('must-not-log');
        expect(readState(pair.client).phase).toBe('online');
        sendTransfer(pair.client);
        expectTransfer(pair.first);
    });

    it('does not classify an account-storage result as a connection-wide upgrade rejection', async () => {
        const pair = await connectPair();
        pair.first.trigger('connect_error', { message: 'client-upgrade-required', data: { error: 'client-upgrade-required',
            requirement: { v: 1, kind: 'account-stored-content', minimumProtocolVersion: 2 } } });
        expect(readState(pair.client).phase).toBe('online');
        sendTransfer(pair.client);
        expectTransfer(pair.first);
    });

    it('stops reconnecting and reports a replaced machine from connect_error', async () => {
        const socket = createSocket('replaced');
        bindApiSessionSocketSequenceMock(ioMock, [socket]);
        const client = createClient();
        const machineReplaced = vi.fn();
        const onConnect = vi.fn();
        client.connect({ onMachineReplaced: machineReplaced, onConnect });
        await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
        socket.trigger('connect_error', { message: 'machine-replaced', data: { error: 'machine-replaced', statusCode: 410 } });
        await vi.waitFor(() => expect(readState(client).phase).toBe('shutting_down'));
        expect(machineReplaced).toHaveBeenCalledWith({ machineId: 'machine-1' });
        expect(socket.connected).toBe(false);
    });

    it('stops a displaced installation and reports the existing revoked reason', async () => {
        const socket = createSocket('displaced');
        bindApiSessionSocketSequenceMock(ioMock, [socket]);
        const client = createClient();
        const machineReplaced = vi.fn();
        const onConnect = vi.fn();
        client.connect({ onMachineReplaced: machineReplaced, onConnect });
        await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
        socket.trigger('connect_error', { message: 'machine_revoked', data: { error: 'machine_revoked', statusCode: 410 } });
        await vi.waitFor(() => expect(readState(client).phase).toBe('shutting_down'));
        expect(machineReplaced).toHaveBeenCalledWith({ machineId: 'machine-1', reason: 'revoked' });
        expect(socket.connected).toBe(false);
    });

    it('ignores queued ownership conflicts from an older socket', async () => {
        const pair = await connectPair();
        const queued = pair.first.getHandlers('connect_error');
        await reconnect(pair);
        for (const callback of queued) callback({ message: 'machine-owner-conflict', data: {
            error: 'machine-owner-conflict', statusCode: 409, owner: { cliVersion: '0.2.0' },
        } });
        expect(pair.ownershipConflict).not.toHaveBeenCalled();
        expect(readState(pair.client).phase).toBe('online');
        sendTransfer(pair.client);
        expectTransfer(pair.second);
    });

    it('keeps takeover on failed attempts and clears it only after a successful connection', async () => {
        vi.useFakeTimers();
        const first = createSocket('failed');
        const second = createSocket('connected');
        const third = createSocket('reconnected');
        first.connect.mockImplementation(() => {
            first.trigger('connect_error', new Error('connection refused'));
            return first;
        });
        bindApiSessionSocketSequenceMock(ioMock, [first, second, third]);
        const client = createClient();
        const onConnect = vi.fn();
        client.connect({ takeover: true, onConnect });
        await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
        expect(ioMock.mock.calls.slice(0, 2).map(([, options]) => options.auth.takeover)).toEqual([true, true]);
        second.disconnect();
        await vi.waitFor(() => expect(readState(client).nextRetryAt).not.toBeNull());
        const retryAt = readState(client).nextRetryAt;
        if (retryAt === null) throw new Error('Expected a scheduled reconnect');
        await vi.advanceTimersByTimeAsync(Math.max(0, retryAt - Date.now()));
        await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(2));
        expect(ioMock.mock.calls[2][1].auth).not.toHaveProperty('takeover');
    });

    it('tracks connected client RPC availability only from current machine-prefixed events', async () => {
        const pair = await connectPair();
        const method = RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME;
        const queued = pair.first.getHandlers(SOCKET_RPC_EVENTS.REGISTERED);
        for (const invalid of [method, `other-machine:${method}`]) pair.first.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: invalid });
        expect(pair.client.hasConnectedClientRpcHandler(method)).toBe(false);
        pair.first.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `machine-1:${method}` });
        expect(pair.client.hasConnectedClientRpcHandler(method)).toBe(true);
        await reconnect(pair);
        expect(pair.client.hasConnectedClientRpcHandler(method)).toBe(false);
        for (const callback of queued) callback({ method: `machine-1:${method}` });
        expect(pair.client.hasConnectedClientRpcHandler(method)).toBe(false);
        pair.second.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `machine-1:${method}` });
        expect(pair.client.hasConnectedClientRpcHandler(method)).toBe(true);
        pair.second.trigger(SOCKET_RPC_EVENTS.UNREGISTERED, { method: `machine-1:${method}` });
        expect(pair.client.hasConnectedClientRpcHandler(method)).toBe(false);
    });
});
