import { once } from 'node:events';
import { Server, type Socket } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { getMachineSocketRoom } from '@/app/api/socketRooms';
import { buildRpcMethodRoom } from './rpcMethodRoom';
import { RPC_REGISTERED_METHODS_SOCKET_DATA_KEY } from './rpcRegisteredMethods';
import { discoverRpcTargets, readMachineRpcTargetPresence } from './rpcTargetDiscovery';
import { forwardRpcCall } from './forwardRpcCall';

// Persistence is the boundary. Both Accounts' rows are present so dropping the
// Account predicate would expose the foreign Machine rather than hide it.
const machines = vi.hoisted(() => [
    { id: 'machine-a', accountId: 'account-a', revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null },
    { id: 'machine-b', accountId: 'account-b', revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null },
]);
vi.mock('@/storage/db', () => ({ db: { machine: {
    findFirst: async ({ where }: { where: { id: string; accountId?: string } }) =>
        machines.find(row => row.id === where.id && (where.accountId === undefined || row.accountId === where.accountId)) ?? null,
} } }));

it('isolates unadmitted Machine discovery and forwarding by Account while resolving its own target', async () => {
    const app = createAuthenticatedTestApp();
    const io = new Server(app.server);
    const clients: ReturnType<typeof connect>[] = [];
    const received: string[] = [];
    try {
        const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        for (const machine of machines) {
            const accepted = once(io, 'connection');
            const client = connect(baseUrl, { transports: ['websocket'], reconnection: false, autoConnect: false });
            clients.push(client);
            const connected = once(client, 'connect');
            client.connect();
            const [socket] = await accepted as [Socket];
            await connected;
            const method = `${machine.id}:read`;
            socket.data.clientType = 'machine-scoped';
            socket.data.machineId = machine.id;
            socket.data[RPC_REGISTERED_METHODS_SOCKET_DATA_KEY] = [method];
            await socket.join(getMachineSocketRoom(machine.accountId, machine.id));
            await socket.join(buildRpcMethodRoom({ userId: machine.accountId, method }));
            client.on(SOCKET_RPC_EVENTS.REQUEST, (_payload: unknown, ack: (value: unknown) => void) => {
                received.push(machine.id);
                ack({ machineId: machine.id });
            });
        }
        // No machineAdmission is supplied: this is the legacy/unadmitted path.
        const own = await discoverRpcTargets({ io, userId: 'account-a', method: 'machine-a:read' });
        expect(own.targets.map(target => target.data?.machineId)).toEqual(['machine-a']);
        expect(await discoverRpcTargets({ io, userId: 'account-a', method: 'machine-b:read' }))
            .toMatchObject({ targets: [], methodRoomEmpty: true });
        // A known Machine with a live daemon proves method absence only to its
        // own Account. This reaches the Account-scoped DB and Machine room.
        expect(await readMachineRpcTargetPresence({ io, userId: 'account-a', method: 'machine-a:missing' })).toBe('method-absent');
        expect(await readMachineRpcTargetPresence({ io, userId: 'account-a', method: 'machine-b:missing' })).toBe('unknown');
        expect(await forwardRpcCall({ io, targetUserId: 'account-a', method: 'machine-a:read', callParams: {} }))
            .toMatchObject({ ok: true, result: { machineId: 'machine-a' } });
        expect(await forwardRpcCall({ io, targetUserId: 'account-a', method: 'machine-b:read', callParams: {} }))
            .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        expect(received).toEqual(['machine-a']);
    } finally {
        for (const client of clients) client.disconnect();
        await new Promise<void>(resolve => io.close(() => resolve()));
        await app.close();
    }
});
