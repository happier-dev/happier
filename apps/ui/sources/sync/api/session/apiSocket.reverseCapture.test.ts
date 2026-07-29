import { afterEach, describe, expect, it, vi } from 'vitest';

import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    UiBrowserRecordingCaptureFrameResponseV1Schema,
    type UiBrowserRecordingCaptureFrameRequestV1,
} from '@happier-dev/protocol';
import type { Encryption } from '@/sync/encryption/encryption';

type SocketEventHandler = (...args: any[]) => void;

/**
 * Reversible test "encryption": prefixes a JSON encoding so encrypt/decrypt round-trip is symmetric
 * exactly like the daemon<->UI machine envelope (daemon encrypt -> UI decryptRaw, UI encryptRaw ->
 * daemon decrypt). Lets the test drive the real apiSocket dispatch path without real crypto.
 */
function createFakeMachineEncryption() {
    return {
        encryptRaw: vi.fn(async (data: unknown): Promise<string> => `enc:${JSON.stringify(data ?? null)}`),
        decryptRaw: vi.fn(async (encrypted: string): Promise<unknown> => {
            if (typeof encrypted !== 'string' || !encrypted.startsWith('enc:')) return null;
            try {
                return JSON.parse(encrypted.slice('enc:'.length));
            } catch {
                return null;
            }
        }),
    };
}

function machineEncryptParams(data: unknown): string {
    return `enc:${JSON.stringify(data ?? null)}`;
}

function machineDecryptAck(ack: unknown): unknown {
    if (typeof ack !== 'string' || !ack.startsWith('enc:')) {
        throw new Error(`Expected machine-encrypted ack, received: ${String(ack)}`);
    }
    return JSON.parse(ack.slice('enc:'.length));
}

function createSocketStub(): Readonly<{ socket: any }> {
    const socket = {
        id: 'socket-1',
        connected: false,
        on: vi.fn(),
        off: vi.fn(),
        onAny: vi.fn(() => socket),
        connect: vi.fn(),
        disconnect: vi.fn(),
        emit: vi.fn(),
        emitWithAck: vi.fn(),
        removeAllListeners: vi.fn(),
        timeout: vi.fn(() => socket),
    };
    return { socket };
}

function getRegisteredHandler(socket: any, event: string): SocketEventHandler | undefined {
    const call = socket.on.mock.calls.find(([registeredEvent]: [string]) => registeredEvent === event);
    return call?.[1];
}

function emittedMethods(socket: any, event: string): string[] {
    return socket.emit.mock.calls
        .filter(([emittedEvent]: [string]) => emittedEvent === event)
        .map(([, payload]: [string, { method?: string }]) => payload?.method ?? '');
}

async function bootApiSocket(params: Readonly<{
    socket: any;
    getMachineEncryption: (machineId: string) => unknown;
    connectedListeners: Set<() => void>;
}>) {
    vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
        return {
            ...actual,
            subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                listener({
                    phase: 'online',
                    reason: 'initial_connect',
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                });
                return () => {};
            },
            startServerReachabilitySupervisor: vi.fn(async () => {}),
        };
    });

    vi.doMock('@/sync/api/session/connection/createSyncSocketTransport', () => {
        const transport = {
            async connect() {
                params.socket.connected = true;
                params.connectedListeners.forEach((listener) => listener());
            },
            async disconnect() {},
            async destroy() {},
            isConnected() {
                return params.socket.connected;
            },
            onConnected(listener: () => void) {
                params.connectedListeners.add(listener);
                return () => params.connectedListeners.delete(listener);
            },
            onDisconnected() {
                return () => {};
            },
            onError() {
                return () => {};
            },
        };
        return {
            createSyncSocketTransport: () => ({ socket: params.socket, transport }),
        };
    });

    const { apiSocket } = await import('./apiSocket');
    apiSocket.initialize(
        { endpoint: 'https://api.example.test', token: 'token-a' },
        {
            getSessionEncryption: () => null,
            getMachineEncryption: params.getMachineEncryption,
        } as unknown as Encryption,
    );

    await vi.waitFor(() => {
        expect(getRegisteredHandler(params.socket, SOCKET_RPC_EVENTS.REQUEST)).toBeTypeOf('function');
    });

    return apiSocket;
}

afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
});

describe('apiSocket inbound machine-scoped reverse RPC (RU2 G1)', () => {
    it('registers a machine-scoped handler and round-trips request -> handler -> encrypted ack', async () => {
        const { socket } = createSocketStub();
        const machineEnc = createFakeMachineEncryption();
        const connectedListeners = new Set<() => void>();
        const apiSocket = await bootApiSocket({
            socket,
            getMachineEncryption: (id) => (id === 'machine-1' ? machineEnc : null),
            connectedListeners,
        });

        const handler = vi.fn(async (params: unknown) => ({ echoed: params }));
        apiSocket.registerMachineScopedRpcHandler('machine-1', 'ui.demo.method', handler);

        // The socket joined the per-machine rpc room.
        expect(emittedMethods(socket, SOCKET_RPC_EVENTS.REGISTER)).toContain('machine-1:ui.demo.method');

        const requestHandler = getRegisteredHandler(socket, SOCKET_RPC_EVENTS.REQUEST)!;
        const ack = await new Promise<unknown>((resolve) => {
            void requestHandler(
                { method: 'machine-1:ui.demo.method', params: machineEncryptParams({ hello: 'world' }) },
                resolve,
            );
        });

        // Params were decrypted with the machine key before reaching the handler.
        expect(handler).toHaveBeenCalledWith({ hello: 'world' });
        // The ack was re-encrypted with the machine key and carries the handler result.
        expect(machineDecryptAck(ack)).toEqual({ echoed: { hello: 'world' } });
    });

    it('fails closed for an unknown method and for a machine with no encryption', async () => {
        const { socket } = createSocketStub();
        const machineEnc = createFakeMachineEncryption();
        const connectedListeners = new Set<() => void>();
        await bootApiSocket({
            socket,
            getMachineEncryption: (id) => (id === 'machine-1' ? machineEnc : null),
            connectedListeners,
        });
        const requestHandler = getRegisteredHandler(socket, SOCKET_RPC_EVENTS.REQUEST)!;

        // Unknown method on a decryptable machine -> encrypted METHOD_NOT_FOUND (daemon treats as no UI).
        const unknownAck = await new Promise<unknown>((resolve) => {
            void requestHandler(
                { method: 'machine-1:ui.unregistered', params: machineEncryptParams({}) },
                resolve,
            );
        });
        expect(machineDecryptAck(unknownAck)).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });

        // No machine encryption -> fail closed without ever decrypting/encrypting (isolate this path).
        machineEnc.encryptRaw.mockClear();
        machineEnc.decryptRaw.mockClear();
        const noKeyAck = await new Promise<unknown>((resolve) => {
            void requestHandler(
                { method: 'machine-unknown:ui.demo.method', params: machineEncryptParams({}) },
                resolve,
            );
        });
        expect(noKeyAck).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        expect(machineEnc.encryptRaw).not.toHaveBeenCalled();
    });

    it('re-registers inbound rooms on reconnect and stops routing after dispose', async () => {
        const { socket } = createSocketStub();
        const machineEnc = createFakeMachineEncryption();
        const connectedListeners = new Set<() => void>();
        const apiSocket = await bootApiSocket({
            socket,
            getMachineEncryption: (id) => (id === 'machine-1' ? machineEnc : null),
            connectedListeners,
        });

        const dispose = apiSocket.registerMachineScopedRpcHandler('machine-1', 'ui.demo.method', async () => ({ ok: true }));
        socket.emit.mockClear();

        // Simulate a reconnect: every installed inbound room is re-joined.
        connectedListeners.forEach((listener) => listener());
        expect(emittedMethods(socket, SOCKET_RPC_EVENTS.REGISTER)).toContain('machine-1:ui.demo.method');

        // Dispose leaves the room and stops answering.
        dispose();
        expect(emittedMethods(socket, SOCKET_RPC_EVENTS.UNREGISTER)).toContain('machine-1:ui.demo.method');

        const requestHandler = getRegisteredHandler(socket, SOCKET_RPC_EVENTS.REQUEST)!;
        const ack = await new Promise<unknown>((resolve) => {
            void requestHandler(
                { method: 'machine-1:ui.demo.method', params: machineEncryptParams({}) },
                resolve,
            );
        });
        // Method is no longer handled -> fail closed.
        expect(machineDecryptAck(ack)).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
    });

    it('installBrowserRecordingReverseCapture routes to the reverse-capture handler and returns a contract-valid ack', async () => {
        const { socket } = createSocketStub();
        const machineEnc = createFakeMachineEncryption();
        const connectedListeners = new Set<() => void>();
        const apiSocket = await bootApiSocket({
            socket,
            getMachineEncryption: (id) => (id === 'machine-1' ? machineEnc : null),
            connectedListeners,
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
        const ack = await new Promise<unknown>((resolve) => {
            void requestHandler({ method: prefixed, params: machineEncryptParams(request) }, resolve);
        });

        // The inbound request reached the real UI reverse-capture handler and produced a
        // contract-valid, machine-encrypted reference-only response. (Outside Tauri the native
        // capture is unavailable, so the handler fails closed inside a valid response envelope.)
        const decoded = machineDecryptAck(ack);
        const parsed = UiBrowserRecordingCaptureFrameResponseV1Schema.safeParse(decoded);
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.result.ok).toBe(false);
    });
});
