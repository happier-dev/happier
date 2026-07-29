import { describe, expect, it, vi } from 'vitest';

import type { TransportDisconnectEvent } from '@happier-dev/connection-supervisor';
import axios from 'axios';
import { HttpStatusError } from '@/api/client/httpStatusError';
import {
    bindApiSessionSocketMock,
    bindApiSessionSocketSequenceMock,
    createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

vi.mock('axios');

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

describe('createSessionSocketTransport', () => {
    it('creates a non-reconnecting socket transport and reports manual disconnects as intentional', async () => {
        const socket = createApiSessionSocketStub({ disconnectReason: 'io client disconnect' });
        bindApiSessionSocketMock(mockIo, socket);
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: { id: 'existing-key' } } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const { socket: transportSocket, transport } = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
        });

        expect(transportSocket).toBe(socket);
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
        const socket = createApiSessionSocketStub();
        bindApiSessionSocketMock(mockIo, socket);
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
                    'x-happier-client-kind': 'session-runner',
                    'x-happier-session-sync-protocol': '2',
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
                    'x-happier-client-kind': 'session-runner',
                    'x-happier-session-sync-protocol': '2',
                }),
            }),
        );
        expect(socket.connect).toHaveBeenCalledTimes(1);
    });

    it('does not resolve connect until the session-scoped socket has actually connected', async () => {
        const socket = createApiSessionSocketStub();
        socket.connect.mockImplementation(() => socket);
        bindApiSessionSocketMock(mockIo, socket);
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: { id: 'existing-key' } } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const { transport } = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverUrl: 'http://127.0.0.1:4321',
        });

        let resolved = false;
        const connectPromise = transport.connect().then(() => {
            resolved = true;
        });

        await vi.waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1));
        expect(resolved).toBe(false);

        socket.connected = true;
        socket.trigger('connect');
        await connectPromise;

        expect(resolved).toBe(true);
    });

    it('rejects connect when the session-scoped socket reports a connect error', async () => {
        const socket = createApiSessionSocketStub();
        socket.connect.mockImplementation(() => socket);
        bindApiSessionSocketMock(mockIo, socket);
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: { id: 'existing-key' } } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const { transport } = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverUrl: 'http://127.0.0.1:4321',
        });

        const connectPromise = transport.connect();
        await vi.waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1));
        const error = new Error('socket auth failed');
        socket.trigger('connect_error', error);

        await expect(connectPromise).rejects.toThrow('socket auth failed');
    });

    it('preserves terminal auth failures from the access-key bootstrap request', async () => {
        const socket = createApiSessionSocketStub();
        bindApiSessionSocketMock(mockIo, socket);
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.get).mockResolvedValue({ status: 401, data: { error: 'Unauthorized' } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const { transport } = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-auth-failure',
            machineId: 'machine-auth-failure',
            serverUrl: 'http://127.0.0.1:4321',
        });

        await expect(transport.connect()).rejects.toBeInstanceOf(HttpStatusError);
        expect(socket.connect).not.toHaveBeenCalled();
    });

    it('coalesces concurrent access-key bootstrap requests for the same machine-bound session', async () => {
        const socket1 = createApiSessionSocketStub({ id: 'socket-concurrent-1' });
        const socket2 = createApiSessionSocketStub({ id: 'socket-concurrent-2' });
        bindApiSessionSocketSequenceMock(mockIo, [socket1, socket2]);
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.post).mockReset();

        let resolveAccessKey: (value: unknown) => void = () => {};
        vi.mocked(axios.get).mockImplementation(
            () => new Promise((resolve) => {
                resolveAccessKey = resolve;
            }) as never,
        );

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const first = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-concurrent-bootstrap',
            machineId: 'machine-concurrent-bootstrap',
            serverUrl: 'http://127.0.0.1:4321',
        });
        const second = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-concurrent-bootstrap',
            machineId: 'machine-concurrent-bootstrap',
            serverUrl: 'http://127.0.0.1:4321',
        });

        const firstConnect = first.transport.connect();
        const secondConnect = second.transport.connect();
        await Promise.resolve();

        expect(axios.get).toHaveBeenCalledTimes(1);
        resolveAccessKey({ status: 200, data: { accessKey: { id: 'existing-key' } } });
        await Promise.all([firstConnect, secondConnect]);

        expect(axios.post).not.toHaveBeenCalled();
        expect(socket1.connect).toHaveBeenCalledTimes(1);
        expect(socket2.connect).toHaveBeenCalledTimes(1);
    });

    it('reuses a recent successful access-key bootstrap for the same machine-bound session', async () => {
        const socket1 = createApiSessionSocketStub({ id: 'socket-recent-1' });
        const socket2 = createApiSessionSocketStub({ id: 'socket-recent-2' });
        bindApiSessionSocketSequenceMock(mockIo, [socket1, socket2]);
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { accessKey: { id: 'existing-key' } } } as never);

        const { createSessionSocketTransport } = await import('./createSessionSocketTransport');
        const first = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-recent-bootstrap',
            machineId: 'machine-recent-bootstrap',
            serverUrl: 'http://127.0.0.1:4321',
        });
        const second = createSessionSocketTransport({
            token: 'token-1',
            sessionId: 'session-recent-bootstrap',
            machineId: 'machine-recent-bootstrap',
            serverUrl: 'http://127.0.0.1:4321',
        });

        await first.transport.connect();
        await second.transport.connect();

        expect(axios.get).toHaveBeenCalledTimes(1);
        expect(axios.post).not.toHaveBeenCalled();
        expect(socket1.connect).toHaveBeenCalledTimes(1);
        expect(socket2.connect).toHaveBeenCalledTimes(1);
    });
});
