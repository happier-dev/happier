import { afterEach, describe, expect, it, vi } from 'vitest';

import { TRANSFER_RELAY_V2_SOCKET_EVENT } from '@happier-dev/protocol';
import type { Encryption } from '@/sync/encryption/encryption';

type SocketEventHandler = (...args: any[]) => void;

function createSocketStub(): Readonly<{
    socket: any;
    emitEvent: (event: string, payload: unknown) => void;
}> {
    let onAnyHandler: SocketEventHandler | null = null;
    const socket = {
        connected: false,
        on: vi.fn(),
        off: vi.fn(),
        onAny: vi.fn((handler: SocketEventHandler) => {
            onAnyHandler = handler;
            return socket;
        }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        emit: vi.fn(),
        emitWithAck: vi.fn(),
        removeAllListeners: vi.fn(),
        timeout: vi.fn(() => socket),
    };

    return {
        socket,
        emitEvent(event, payload) {
            onAnyHandler?.(event, payload);
        },
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
});

describe('apiSocket transfer relay listeners', () => {
    it('fans out relay-v2 envelopes to multiple listeners on the active socket', async () => {
        const socketStub = createSocketStub();

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
            const connectedListeners = new Set<() => void>();
            const transport = {
                async connect() {
                    socketStub.socket.connected = true;
                    connectedListeners.forEach((listener) => listener());
                },
                async disconnect() {},
                async destroy() {},
                isConnected() {
                    return true;
                },
                onConnected(listener: () => void) {
                    connectedListeners.add(listener);
                    return () => connectedListeners.delete(listener);
                },
                onDisconnected() {
                    return () => {};
                },
                onError() {
                    return () => {};
                },
            };
            return {
                createSyncSocketTransport: () => ({ socket: socketStub.socket, transport }),
            };
        });

        const { apiSocket } = await import('./apiSocket');
        apiSocket.initialize(
            { endpoint: 'https://api.example.test', token: 'token-a' },
            { getSessionEncryption: () => null, getMachineEncryption: () => null } as unknown as Encryption,
        );

        const firstListener = vi.fn();
        const secondListener = vi.fn();
        apiSocket.onTransferRelayV2Envelope(firstListener);
        apiSocket.onTransferRelayV2Envelope(secondListener);

        await vi.waitFor(() => {
            expect(socketStub.socket.onAny).toHaveBeenCalled();
        });

        const payload = {
            scopeUserId: 'user-1',
            sender: {
                kind: 'machine',
                machineId: 'machine-1',
            },
            recipient: {
                kind: 'user',
            },
            envelope: {
                transferId: 'transfer-1',
                kind: 'abort',
                reason: 'disabled',
            },
        } as const;

        socketStub.emitEvent(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);

        expect(firstListener).toHaveBeenCalledWith(payload);
        expect(secondListener).toHaveBeenCalledWith(payload);
    });
});
