import { describe, expect, it, vi } from 'vitest';

import type { TransportDisconnectEvent } from '@happier-dev/connection-supervisor';
import axios from 'axios';
import { HttpStatusError } from '@/api/client/httpStatusError';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

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
        expect(socket.connect).toHaveBeenCalledTimes(1);
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
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverUrl: 'http://127.0.0.1:4321',
        });

        await expect(transport.connect()).rejects.toBeInstanceOf(HttpStatusError);
        expect(socket.connect).not.toHaveBeenCalled();
    });
});
