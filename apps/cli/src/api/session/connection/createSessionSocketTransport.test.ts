import { describe, expect, it, vi } from 'vitest';

import type { TransportDisconnectEvent } from '@happier-dev/connection-supervisor';
import axios from 'axios';

const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

vi.mock('axios');

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

type MockSocket = {
    connected: boolean;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
};

function createSocketStub(): {
    socket: MockSocket;
    trigger: (event: string, ...args: unknown[]) => void;
} {
    const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    const socket: MockSocket = {
        connected: false,
        connect: vi.fn(() => {
            socket.connected = true;
            trigger('connect');
        }),
        disconnect: vi.fn(() => {
            socket.connected = false;
            trigger('disconnect', 'io client disconnect');
        }),
        close: vi.fn(() => {
            socket.connected = false;
            trigger('disconnect', 'io client disconnect');
        }),
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            const listeners = handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
            listeners.add(handler);
            handlers.set(event, listeners);
            return socket;
        }),
        off: vi.fn((event: string, handler?: (...args: unknown[]) => void) => {
            if (!handler) {
                handlers.delete(event);
                return socket;
            }
            const listeners = handlers.get(event);
            listeners?.delete(handler);
            if (listeners && listeners.size === 0) {
                handlers.delete(event);
            }
            return socket;
        }),
        removeAllListeners: vi.fn(() => {
            handlers.clear();
            return socket;
        }),
        emit: vi.fn(),
    };

    function trigger(event: string, ...args: unknown[]): void {
        for (const handler of handlers.get(event) ?? []) {
            handler(...args);
        }
    }

    return { socket, trigger };
}

describe('createSessionSocketTransport', () => {
    it('creates a non-reconnecting socket transport and reports manual disconnects as intentional', async () => {
        const stub = createSocketStub();
        mockIo.mockReset();
        mockIo.mockReturnValue(stub.socket);
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: { id: 'existing-key' } } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const { socket, transport } = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
        });

        expect(socket).toBe(stub.socket);
        const opts = mockIo.mock.calls[0]?.[1] as Record<string, unknown>;
        expect(opts.reconnection).toBe(false);
        expect(opts.autoConnect).toBe(false);

        const connectedListener = vi.fn();
        const disconnectedListener = vi.fn<(event: TransportDisconnectEvent) => void>();
        transport.onConnected(connectedListener);
        transport.onDisconnected(disconnectedListener);

        await transport.connect();
        expect(connectedListener).toHaveBeenCalledTimes(1);

        await transport.disconnect({ intentional: true });
        expect(disconnectedListener).toHaveBeenCalledWith(
            expect.objectContaining({
                intentional: true,
                reason: 'io client disconnect',
            }),
        );
    });

    it('ensures a machine-bound session access key before connecting a session-scoped socket', async () => {
        const stub = createSocketStub();
        mockIo.mockReset();
        mockIo.mockReturnValue(stub.socket);
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: null } } as never);
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const { transport } = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverUrl: 'http://127.0.0.1:4321',
        });

        await transport.connect();

        expect(axios.get).toHaveBeenCalledWith(
            'http://127.0.0.1:4321/v1/access-keys/session-1/machine-1',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-1',
                }),
            }),
        );
        expect(axios.post).toHaveBeenCalledWith(
            'http://127.0.0.1:4321/v1/access-keys/session-1/machine-1',
            expect.objectContaining({
                data: expect.any(String),
            }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-1',
                }),
            }),
        );
        expect(stub.socket.connect).toHaveBeenCalledTimes(1);
    });
});
