import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { expect, it } from 'vitest';

import { getSocketRooms } from '@/app/api/socketRooms';
import { eventRouter } from './eventRouter';
import { buildAccountChangeWakeUpdate } from './eventPayloadBuilders';

it('keeps Machine and other Session wakes when current-view sockets are already covered', async () => {
    const http = createServer();
    const io = new Server(http, { transports: ['websocket'] });
    const subjects = [
        { clientType: 'user-scoped' },
        { clientType: 'session-scoped', sessionId: 'covered' },
        { clientType: 'session-scoped', sessionId: 'other' },
        { clientType: 'machine-scoped', machineId: 'machine' },
    ] satisfies Array<Omit<Parameters<typeof getSocketRooms>[0], 'userId'>>;
    io.on('connection', socket => {
        void socket.join(getSocketRooms({ userId: 'owner', includeAccountStoredContentV3Room: true,
            ...subjects[Number(socket.handshake.auth.subject)]! }));
        socket.on('barrier', acknowledge => acknowledge());
    });
    const clients: Socket[] = [];
    try {
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing test listener');
        const frames: unknown[][] = subjects.map(() => []);
        for (const index of subjects.keys()) {
            const client = connect(`http://127.0.0.1:${address.port}`, {
                transports: ['websocket'], forceNew: true, auth: { subject: index }, autoConnect: false,
            });
            clients.push(client);
            client.on('update', payload => frames[index]!.push(payload));
            await new Promise<void>((resolve, reject) => {
                client.once('connect', resolve); client.once('connect_error', reject); client.connect();
            });
        }
        eventRouter.setIo(io);
        const wake = buildAccountChangeWakeUpdate(9, 'wake', { changeKinds: ['session'], entityIds: ['covered'], sessionSystemRecords: [] });
        eventRouter.emitUpdate({ userId: 'owner', payload: wake,
            recipientFilter: { type: 'account-stored-content-v3', exceptSessionCurrentView: 'covered' } });
        await Promise.all(clients.map(client => client.emitWithAck('barrier')));
        expect(frames).toEqual([[], [], [wake], [wake]]);
        // Projection failure and writers without a current view retain ordinary recovery.
        eventRouter.emitUpdate({ userId: 'owner', payload: wake,
            recipientFilter: { type: 'account-stored-content-v3' } });
        await Promise.all(clients.map(client => client.emitWithAck('barrier')));
        expect(frames).toEqual([[wake], [wake], [wake, wake], [wake, wake]]);
    } finally {
        eventRouter.clearIo();
        for (const client of clients) client.disconnect();
        await new Promise<void>(resolve => io.close(() => resolve()));
    }
});
