import { ActionFailureCauseV1Schema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    UiBrowserRecordingCaptureFrameResponseV1Schema,
    uiBrowserAutomationDispatchMethod,
    type UiBrowserRecordingCaptureFrameRequestV1,
} from '@happier-dev/protocol';
import type { Encryption } from '@/sync/encryption/encryption';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { createBrowserAutomationControlService } from '@/sync/domains/browser/automation/controlService';
import { registerBrowserRuntimeControlAdapter } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { applyBrowserControlEvent, createBrowserControlState } from '@/sync/domains/browser/control';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import { apiSocket } from './apiSocket';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { MachineEncryption } from '@/sync/encryption/machineEncryption';
import { SecretBoxEncryption } from '@/sync/encryption/encryptor';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createMachineRpcReadAdmission } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcReadAdmission';

type SocketEventHandler = (...args: unknown[]) => void;
type SocketStub = ReturnType<typeof createSocketIoBoundaryStub>['socket'];

const rpcBoundary = vi.hoisted(() => ({
    socket: null as SocketStub | null,
}));

vi.mock('socket.io-client', () => ({ io: () => rpcBoundary.socket }));
vi.mock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
    return {
        ...actual,
        subscribeServerReachabilityState: (_serverUrl: string, listener: (state: import('@happier-dev/connection-supervisor').ManagedConnectionState) => void) => {
            listener({
                phase: 'online', reason: 'initial_connect', attempt: 0, nextRetryAt: null,
                lastConnectedAt: Date.now(), lastDisconnectedAt: null, lastErrorMessage: null,
            });
            return () => {};
        },
        startServerReachabilitySupervisor: vi.fn(async () => {}),
    };
});

function createMachineEncryption() {
    return new MachineEncryption('machine-1', new SecretBoxEncryption(new Uint8Array(32).fill(17)), new EncryptionCache());
}
const callId = '0123456789abcdef0123456789abcdef';
const callerContent = { mode: 'e2ee' as const, cipher: createMachineEncryption() };
async function invokeMachineRpc(handler: SocketEventHandler, method: string, data: unknown, requestId?: string) {
    const params = await socketRpcCodec.encodeParams(callerContent, data, { method, callId });
    return new Promise<unknown>(resolve => handler({ method, params, ...(requestId ? { requestId } : {}) }, resolve));
}
function machineDecryptAck(ack: unknown) {
    return socketRpcCodec.decodeResult(callerContent, { ok: true, result: ack }, callId);
}

function createSocketStub() { return createSocketIoBoundaryStub(); }

function getRegisteredHandler(socket: SocketStub, event: string): SocketEventHandler | undefined {
    const call = socket.on.mock.calls.find(([registeredEvent]) => registeredEvent === event);
    return call?.[1];
}

function emittedMethods(socket: SocketStub, event: string): string[] {
    return socket.emit.mock.calls
        .filter(([emittedEvent]) => emittedEvent === event)
        .map(([, payload]) => payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string' ? payload.method : '');
}

async function bootApiSocket(params: Readonly<{
    socket: SocketStub;
    getMachineEncryption: (machineId: string) => unknown;
    token?: string;
}>) {
    rpcBoundary.socket = params.socket;
    apiSocket.initialize(
        { endpoint: 'https://api.example.test', token: params.token ?? 'token-a' },
        {
            getSessionEncryption: () => null,
            getMachineEncryption: params.getMachineEncryption,
            getMachineEncryptionContext: () => undefined,
        } as unknown as Encryption,
    );

    await vi.waitFor(() => {
        expect(getRegisteredHandler(params.socket, SOCKET_RPC_EVENTS.REQUEST)).toBeTypeOf('function');
    });

    return apiSocket;
}

afterEach(() => {
    apiSocket.disconnect();
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe('apiSocket inbound machine-scoped reverse RPC (RU2 G1)', () => {
    it.each(['plain', 'e2ee'] as const)('redacts thrown RPC messages and preserves producer causes in %s replies', async mode => {
        const { socket } = createSocketStub();
        const machineId = mode === 'plain' ? 'catch-plain-machine' : 'machine-1';
        const machineEncryption = createMachineEncryption();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applyMachines([createMachineFixture({ id: machineId, storageMode: mode })], true);
        await bootApiSocket({ socket, getMachineEncryption: () => mode === 'plain' ? null : machineEncryption });
        const content = mode === 'plain' ? { mode: 'plain' as const } : callerContent;
        const receive = getRegisteredHandler(socket, SOCKET_RPC_EVENTS.REQUEST)!;
        const producerCause = ActionFailureCauseV1Schema.parse({ phase: 'machine.setup.apply', errorClass: 'Error', errorCode: 'ENOSPC', httpStatus: null });
        for (const cause of [undefined, producerCause]) {
            const method = `${machineId}:ui.throwing`;
            const dispose = apiSocket.registerMachineScopedRpcHandler(machineId, 'ui.throwing', async () => {
                throw cause ? Object.assign(new Error('request failed token=PRIVATE_TOKEN'), { failureCause: cause })
                    : Object.assign(new Error('request failed token=PRIVATE_TOKEN'), { code: 'ECONNRESET' });
            });
            try {
                const params = await socketRpcCodec.encodeParams(content, {}, { method, callId });
                const ack = await new Promise<unknown>(resolve => receive({ method, params }, resolve));
                const result = await socketRpcCodec.decodeResult(content, { ok: true, result: ack }, callId);
                expect(result).toEqual({ error: expect.stringContaining('request failed'), failureCause: cause ?? {
                    phase: 'rpc.handler', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null,
                } });
                expect(JSON.stringify(result)).not.toContain('PRIVATE_TOKEN');
            } finally { dispose(); }
        }
    });

    it('fingerprints token-only admitted reads without exposing the bearer or merging replacement tokens', async () => {
        const { socket } = createSocketStub();
        socket.emitWithAck.mockResolvedValue({ ok: true, result: { ready: true } });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-plain', storageMode: 'plain' })], true);
        const admittedKeys: string[] = [];
        const admission = createMachineRpcReadAdmission(['token-only-test']);
        for (const token of ['token-a', 'token-b']) {
            await bootApiSocket({ socket, getMachineEncryption: () => null, token });
            await expect(apiSocket.machineRPC('machine-plain', 'demo.read', {}, {
                readAdmission: {
                    run: input => {
                        admittedKeys.push(input.binding.key);
                        return admission.run(input);
                    },
                },
            })).resolves.toEqual({ ready: true });
        }
        expect(admittedKeys).toHaveLength(2);
        expect(admittedKeys[0]).not.toBe(admittedKeys[1]);
        expect(admittedKeys.join('')).not.toContain('token-a');
        expect(admittedKeys.join('')).not.toContain('token-b');
    });

    it('withdraws a navigating client Action only after its accepted call has returned its receipt', async () => {
        const { socket } = createSocketStub();
        const machineEncryption = createMachineEncryption();
        await bootApiSocket({ socket, getMachineEncryption: () => machineEncryption });
        let began!: () => void;
        const started = new Promise<void>(resolve => { began = resolve; });
        let settle!: () => void;
        let effectSignal: AbortSignal | undefined;
        const method = 'machine-1:ui.navigation';
        const dispose = apiSocket.registerMachineScopedRpcHandler('machine-1', 'ui.navigation', async (_raw, context) => {
            effectSignal = context?.signal;
            began();
            await new Promise<void>(resolve => { settle = resolve; });
            return { status: 'opened' };
        }, { settleInFlight: true });
        const receive = getRegisteredHandler(socket, SOCKET_RPC_EVENTS.REQUEST)!;
        const order: string[] = [];
        const emit = socket.emit.getMockImplementation();
        socket.emit.mockImplementation((event, ...args) => {
            if (event === SOCKET_RPC_EVENTS.UNREGISTER) order.push('unregistered');
            return emit?.(event, ...args) ?? socket;
        });
        const params = await socketRpcCodec.encodeParams(callerContent, {}, { method, callId });
        const ack = new Promise<unknown>(resolve => receive({ method, params }, (value: unknown) => {
            order.push('receipt');
            resolve(value);
        }));
        try {
            await started;
            dispose();
            expect(effectSignal?.aborted).toBe(false);
            expect(emittedMethods(socket, SOCKET_RPC_EVENTS.UNREGISTER)).not.toContain(method);
            await expect(machineDecryptAck(await invokeMachineRpc(receive, method, {})))
                .resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        } finally {
            settle();
            expect(await machineDecryptAck(await ack)).toEqual({ status: 'opened' });
            expect(order).toEqual(['receipt', 'unregistered']);
            dispose();
        }
    });

    it('refuses redirected and unbound requests before invoking the reverse handler', async () => {
        const { socket } = createSocketStub();
        await bootApiSocket({ socket, getMachineEncryption: () => createMachineEncryption() });
        let effects = 0;
        apiSocket.registerMachineScopedRpcHandler('machine-1', 'ui.delete', async () => { effects += 1; return { deleted: true }; });
        const receive = getRegisteredHandler(socket, SOCKET_RPC_EVENTS.REQUEST)!;
        const params = await socketRpcCodec.encodeParams(callerContent, { path: 'keep' }, { method: 'machine-1:ui.stat', callId });
        const redirected = await new Promise<unknown>(resolve => receive({ method: 'machine-1:ui.delete', params }, resolve));
        await expect(machineDecryptAck(redirected)).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
        const unbound = await callerContent.cipher.encryptRaw({ path: 'keep' });
        const refused = await new Promise<unknown>(resolve => receive({ method: 'machine-1:ui.delete', params: unbound }, resolve));
        await expect(machineDecryptAck(refused)).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
        expect(effects).toBe(0);
    });

    it.each(['cancel', 'disconnect', 'retire'] as const)('delivers reverse RPC %s to the deferred page owner', async (interruption) => {
        const { socket, trigger } = createSocketStub();
        const machineEncryption = createMachineEncryption();
        await bootApiSocket({ socket, getMachineEncryption: () => machineEncryption });
        const view = { browserSessionId: 'socket-session', viewId: 'socket-view', sessionId: 'happier-session' };
        let began!: () => void;
        const started = new Promise<void>(resolve => { began = resolve; });
        let effectSignal: AbortSignal | undefined;
        let settle!: () => void;
        const service = createBrowserAutomationControlService({ nowMs: Date.now });
        service.registerOwner({ ...view, ownerId: 'socket-engine', authority: 'uiLocal', navigationGeneration: 0,
            adapterKind: 'localPreview', fidelity: 'injectedPage', trustedInput: false, supportedActions: ['click'],
            executeAction: async (_request, context) => {
                effectSignal = context.signal;
                began();
                await new Promise<void>(resolve => { settle = resolve; });
                return { status: 'succeeded' };
            },
        });
        const state = applyBrowserControlEvent(applyBrowserControlEvent(createBrowserControlState(), {
            kind: 'sessionCreated', browserSessionId: view.browserSessionId, eventId: 'session', profileId: 'profile', occurredAt: 1,
        }), {
            kind: 'viewOpened', ...view, eventId: 'view', occurredAt: 2, platform: 'web', adapterKind: 'localPreview', engineKind: 'webIframe',
            target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test', display: { title: 'Page', addressLabel: 'example.test' } },
            adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'localPreview', supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['webIframe'] }),
        });
        const disposeOwner = registerBrowserRuntimeControlAdapter({ browserSessionId: view.browserSessionId,
            control: { readState: () => state, applyDispatchResult: () => {} }, automation: { controlService: service } });
        const disposeHandler = apiSocket.installBrowserAutomationReverseDispatch('machine-1', view);
        const receive = getRegisteredHandler(socket, SOCKET_RPC_EVENTS.REQUEST)!;
        const ack = invokeMachineRpc(receive, `machine-1:${uiBrowserAutomationDispatchMethod(view)}`, {
                v: 1, sessionId: view.sessionId, actionId: 'browser.automation.click', authority: 'account_automation', input: {
                    v: 1, browserSessionId: view.browserSessionId, viewId: view.viewId, automationRequestId: 'socket-click',
                    actionKind: 'click', navigationGeneration: 0, requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent' },
                    timeoutMs: 1000, payload: { selector: '#go' },
                },
            }, 'effect-request');
        try {
            await started;
            if (interruption === 'cancel') trigger(SOCKET_RPC_EVENTS.CANCEL, { requestId: 'effect-request' });
            else if (interruption === 'disconnect') trigger('disconnect', 'transport close');
            else disposeHandler();
            expect(effectSignal?.aborted).toBe(true);
        } finally {
            settle();
            expect(await machineDecryptAck(await ack)).toMatchObject({ status: 'interrupted', completion: 'unknown' });
            disposeHandler();
            disposeOwner();
        }
    });

    it('dispatches encrypted automation to the existing mounted owner and retires its exact handler', async () => {
        const { socket } = createSocketStub();
        const machineEncryption = createMachineEncryption();
        const apiSocket = await bootApiSocket({ socket, getMachineEncryption: () => machineEncryption });
        const view = { browserSessionId: 'socket-session', viewId: 'socket-view', sessionId: 'happier-session' };
        const service = createBrowserAutomationControlService({ nowMs: Date.now });
        service.registerOwner({ ...view, ownerId: 'socket-engine', authority: 'uiLocal', navigationGeneration: 0,
            adapterKind: 'localPreview', fidelity: 'injectedPage', trustedInput: false, supportedActions: ['click'],
            executeAction: async () => ({ status: 'succeeded', resultSummary: { clicked: true, cookie: 'private-cookie' } }),
        });
        const state = applyBrowserControlEvent(applyBrowserControlEvent(createBrowserControlState(), {
            kind: 'sessionCreated', browserSessionId: view.browserSessionId, eventId: 'session', profileId: 'profile', occurredAt: 1,
        }), {
            kind: 'viewOpened', ...view, eventId: 'view', occurredAt: 2, platform: 'web', adapterKind: 'localPreview', engineKind: 'webIframe',
            target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test', display: { title: 'Page', addressLabel: 'example.test' } },
            adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'localPreview', supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['webIframe'] }),
        });
        const disposeOwner = registerBrowserRuntimeControlAdapter({ browserSessionId: view.browserSessionId,
            control: { readState: () => state, applyDispatchResult: () => {} }, automation: { controlService: service } });
        const disposeHandler = apiSocket.installBrowserAutomationReverseDispatch('machine-1', view);
        const method = `machine-1:${uiBrowserAutomationDispatchMethod(view)}`;
        const requestHandler = getRegisteredHandler(socket, SOCKET_RPC_EVENTS.REQUEST)!;
        const call = () => invokeMachineRpc(requestHandler, method, {
            v: 1, sessionId: view.sessionId, actionId: 'browser.automation.click', authority: 'account_automation', input: {
                v: 1, browserSessionId: view.browserSessionId, viewId: view.viewId, automationRequestId: 'socket-click', actionKind: 'click', navigationGeneration: 0,
                requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent' }, timeoutMs: 1000, payload: { selector: '#go' },
            },
        });
        try {
            const ack = await machineDecryptAck(await call());
            expect(ack).toMatchObject({ status: 'succeeded', trustedInput: false, resultSummary: { clicked: true } });
            expect(JSON.stringify(ack)).not.toContain('private-cookie');
            disposeHandler();
            expect(emittedMethods(socket, SOCKET_RPC_EVENTS.UNREGISTER)).toContain(method);
            expect(await machineDecryptAck(await call())).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        } finally {
            disposeHandler();
            disposeOwner();
        }
    });

    it('round-trips forward and reverse machine RPC in plaintext mode without a machine key', async () => {
        const { socket } = createSocketStub();
        socket.emitWithAck.mockImplementation(async (event: string, payload: unknown) => {
            expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
            expect(payload).toMatchObject({
                method: 'machine-plain:demo.forward',
                params: { hello: 'daemon' },
            });
            return { ok: true, result: { hello: 'ui' } };
        });
        const apiSocket = await bootApiSocket({
            socket,
            getMachineEncryption: () => null,
        });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applyMachines([{
            id: 'machine-plain',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            revokedAt: null,
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
            storageMode: 'plain',
        }], true);

        await expect(apiSocket.machineRPC(
            'machine-plain',
            'demo.forward',
            { hello: 'daemon' },
        )).resolves.toEqual({ hello: 'ui' });

        const handler = vi.fn(async (params: unknown) => ({ echoed: params }));
        apiSocket.registerMachineScopedRpcHandler('machine-plain', 'demo.reverse', handler);
        const requestHandler = getRegisteredHandler(socket, SOCKET_RPC_EVENTS.REQUEST)!;
        const ack = await new Promise<unknown>((resolve) => {
            void requestHandler(
                {
                    method: 'machine-plain:demo.reverse',
                    params: { hello: 'world' },
                },
                resolve,
            );
        });

        expect(handler).toHaveBeenCalledWith({ hello: 'world' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(ack).toEqual({ echoed: { hello: 'world' } });
        storage.getState().applyMachines([], true);
    });

    it('registers a machine-scoped handler and round-trips request -> handler -> encrypted ack', async () => {
        const { socket } = createSocketStub();
        const machineEnc = createMachineEncryption();
        const apiSocket = await bootApiSocket({
            socket,
            getMachineEncryption: (id) => (id === 'machine-1' ? machineEnc : null),
        });

        const handler = vi.fn(async (params: unknown) => ({ echoed: params }));
        apiSocket.registerMachineScopedRpcHandler('machine-1', 'ui.demo.method', handler);

        // The socket joined the per-machine rpc room.
        expect(emittedMethods(socket, SOCKET_RPC_EVENTS.REGISTER)).toContain('machine-1:ui.demo.method');

        const requestHandler = getRegisteredHandler(socket, SOCKET_RPC_EVENTS.REQUEST)!;
        const ack = await invokeMachineRpc(requestHandler, 'machine-1:ui.demo.method', { hello: 'world' });

        // Params were decrypted with the machine key before reaching the handler.
        expect(handler).toHaveBeenCalledWith({ hello: 'world' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        // The ack was re-encrypted with the machine key and carries the handler result.
        expect(await machineDecryptAck(ack)).toEqual({ echoed: { hello: 'world' } });
    });

    it('fails closed for an unknown method and for a machine with no encryption', async () => {
        const { socket } = createSocketStub();
        const machineEnc = createMachineEncryption();
        await bootApiSocket({
            socket,
            getMachineEncryption: (id) => (id === 'machine-1' ? machineEnc : null),
        });
        const requestHandler = getRegisteredHandler(socket, SOCKET_RPC_EVENTS.REQUEST)!;

        // Unknown method on a decryptable machine -> encrypted METHOD_NOT_FOUND (daemon treats as no UI).
        const unknownAck = await invokeMachineRpc(requestHandler, 'machine-1:ui.unregistered', {});
        expect(await machineDecryptAck(unknownAck)).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });

        // No machine encryption -> fail closed without ever decrypting/encrypting (isolate this path).
        const noKeyAck = await invokeMachineRpc(requestHandler, 'machine-unknown:ui.demo.method', {});
        expect(noKeyAck).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
    });

    it('re-registers inbound rooms on reconnect and stops routing after dispose', async () => {
        const { socket } = createSocketStub();
        const machineEnc = createMachineEncryption();
        const apiSocket = await bootApiSocket({
            socket,
            getMachineEncryption: (id) => (id === 'machine-1' ? machineEnc : null),
        });

        const dispose = apiSocket.registerMachineScopedRpcHandler('machine-1', 'ui.demo.method', async () => ({ ok: true }));
        socket.emit.mockClear();

        // Simulate a reconnect: every installed inbound room is re-joined.
        socket.connect();
        expect(emittedMethods(socket, SOCKET_RPC_EVENTS.REGISTER)).toContain('machine-1:ui.demo.method');

        // Dispose leaves the room and stops answering.
        dispose();
        expect(emittedMethods(socket, SOCKET_RPC_EVENTS.UNREGISTER)).toContain('machine-1:ui.demo.method');

        const requestHandler = getRegisteredHandler(socket, SOCKET_RPC_EVENTS.REQUEST)!;
        const ack = await invokeMachineRpc(requestHandler, 'machine-1:ui.demo.method', {});
        // Method is no longer handled -> fail closed.
        expect(await machineDecryptAck(ack)).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
    });

    it('installBrowserRecordingReverseCapture routes to the reverse-capture handler and returns a contract-valid ack', async () => {
        const { socket } = createSocketStub();
        const machineEnc = createMachineEncryption();
        const apiSocket = await bootApiSocket({
            socket,
            getMachineEncryption: (id) => (id === 'machine-1' ? machineEnc : null),
        });

        apiSocket.installBrowserRecordingReverseCapture('machine-1');
        const prefixed = `machine-1:${RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME}`;
        expect(emittedMethods(socket, SOCKET_RPC_EVENTS.REGISTER)).toContain(prefixed);

        const request: UiBrowserRecordingCaptureFrameRequestV1 = {
            protocolVersion: 1,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 2,
            captureRequestId: 'capture_1',
            outputPath: '/tmp/recordings/rec.capture_1.native-view.png',
            maxBytes: 16_000_000,
        };
        const requestHandler = getRegisteredHandler(socket, SOCKET_RPC_EVENTS.REQUEST)!;
        const ack = await invokeMachineRpc(requestHandler, prefixed, request);

        // The inbound request reached the real UI reverse-capture handler and produced a
        // contract-valid, machine-encrypted reference-only response. (Outside Tauri the native
        // capture is unavailable, so the handler fails closed inside a valid response envelope.)
        const decoded = await machineDecryptAck(ack);
        const parsed = UiBrowserRecordingCaptureFrameResponseV1Schema.safeParse(decoded);
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.result.ok).toBe(false);
    });
});
