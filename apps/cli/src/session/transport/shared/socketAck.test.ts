import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { describe, expect, it } from 'vitest';

import { emitSocketWithAck } from './socketAck';

describe('emitSocketWithAck', () => {
    it('classifies a real Socket.IO timeout as retryable acknowledgement loss and preserves its cause', async () => {
        const http = createServer();
        const server = new Server(http);
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback server');
        const client = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
        server.on('connection', (socket) => {
            // The remote endpoint receives the event but withholds the ACK.
            socket.on('accepted', () => {});
        });
        try {
            await new Promise<void>((resolve, reject) => {
                client.once('connect', resolve);
                client.once('connect_error', reject);
            });
            const params = { socket: client, event: 'accepted', payload: { localId: 'accepted-input' }, timeoutMs: 30 };
            await expect(emitSocketWithAck(params)).rejects.toMatchObject({
                code: 'socket_ack_timeout', event: 'accepted', retryable: true, timeoutMs: 30,
                cause: expect.objectContaining({ message: 'operation has timed out' }),
            });
        } finally {
            client.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
        }
    });

    it('preserves a non-timeout transport error without marking it retryable', async () => {
        const error = new Error('invalid encrypted payload');
        await expect(emitSocketWithAck({
            socket: { connected: true, emitWithAck: async () => { throw error; } },
            event: 'accepted', payload: {},
        })).rejects.toBe(error);
        expect(error).not.toHaveProperty('retryable');
    });
});
