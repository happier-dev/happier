import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { expect, it } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1 } from '@happier-dev/protocol/sessions/control/machineSessionTerminalV1';

import { ApiMachineClient } from './apiMachine';
import { dispatchSocketPacket } from '../../../server/sources/app/api/socket/dispatchSocketPacket';

it('preserves typed Home missing-handler refusals for capture and finalize without disconnect or replay', async () => {
    const http = createServer();
    const home = new Server(http);
    const received: string[] = [];
    // Run the production Home dispatcher without capture/finalize registrations.
    // The full startSocket wiring is covered by socket.connectRpc.spec.ts.
    home.on('connection', socket => {
        socket.onAny(method => received.push(method));
        socket.use((packet, next) => dispatchSocketPacket(socket, packet, next));
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const socket = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], autoConnect: false, reconnection: false });
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('connect_error', reject);
            socket.connect();
        });
        const client = new ApiMachineClient('test-token', { id: 'machine', encryptionMode: 'plain',
            metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
        Reflect.set(client, 'socket', socket);
        const calls = [
            client.captureMachineSessionTerminal('session'),
            client.finalizeMachineSessionTerminal({ sessionId: 'session', authority: { kind: 'generation', publisherGeneration: '1' } }),
        ];
        const outcomes = await Promise.allSettled(calls);
        for (const [index, method] of [MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1].entries()) {
            expect(outcomes[index]).toMatchObject({ status: 'rejected', reason: {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, method, retryable: false,
            } });
        }
        expect(socket.connected).toBe(true);
        expect(received).toEqual([MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1]);
    } finally {
        socket.disconnect();
        await new Promise<void>(resolve => home.close(() => resolve()));
    }
});
