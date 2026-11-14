import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { vi } from 'vitest';
import * as sockets from '@/api/session/sockets';
import type { Socket } from 'socket.io-client';
import { UpdateBodySchema } from '@happier-dev/protocol/updates';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
const createUserScopedSocketConnection = sockets.createUserScopedSocketConnection;

export type RequesterCurrentnessSocketHarness = Readonly<{
    server: Server;
    serverUrl: string;
    clients: Socket[];
    settleTransport(): Promise<void>;
    disconnect(): Promise<void>;
    reconnect(): Promise<void>;
    pushProfile(accountId: string): Promise<void>;
    pushSettings(accountId: string, settings: unknown, version: number): Promise<void>;
    hintSettings(settingsVersion: number): Promise<void>;
    hintAccountChange(cursor?: number): Promise<void>;
    pushInvalidCurrentness(accountId: string): Promise<void>;
    pushInvalidSettings(accountId: string): Promise<void>;
    push(accountId: string, currentness: unknown): Promise<void>;
    close(): Promise<void>;
}>;

/** Real Socket.IO channel; only the network endpoint is redirected from Home to loopback. */
export async function createRequesterCurrentnessSocketHarness(): Promise<RequesterCurrentnessSocketHarness> {
    const http = createServer();
    const server = new Server(http, { path: '/v1/updates' });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing socket listen address');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const clients: Socket[] = [];
    const failedUpgrades = new WeakSet<Socket>();
    const redirect = vi.spyOn(sockets, 'createUserScopedSocketConnection').mockImplementation(options => {
        const connection = createUserScopedSocketConnection({ ...options, serverUrl });
        // This is the genuine network socket, with default event typing at the test boundary.
        const client = connection.socket as Socket;
        // Remember a native failure even if it precedes the fixture's settling call.
        client.io.on('open', () => {
            failedUpgrades.delete(client);
            const engine = client.io.engine;
            if (engine.transport.name !== 'polling') return;
            const clear = () => { engine.off('upgradeError', failed); engine.off('upgrade', clear); engine.off('close', clear); };
            const failed = () => { failedUpgrades.add(client); clear(); };
            engine.once('upgradeError', failed);
            engine.once('upgrade', clear);
            engine.once('close', clear);
        });
        client.on('fx56-delivered', (ack: () => void) => ack());
        clients.push(client);
        return connection;
    });
    const deliver = async (body: unknown, cursor = 2) => {
        await Promise.all([...server.sockets.sockets.values()].map(socket => new Promise<void>(resolve => {
            // Revocation can close the real subscriber while it consumes this update.
            // That terminal transport signal also completes this delivery probe.
            const complete = () => { socket.off('disconnect', complete); resolve(); };
            socket.once('disconnect', complete);
            socket.emit('update', { id: 'encryption-change', seq: cursor, createdAt: 2, body });
            socket.emit('fx56-delivered', complete);
        })));
    };
    return {
        server,
        serverUrl,
        clients,
        async settleTransport() {
            await Promise.all(clients.map(async client => {
                const engine = client.io.engine;
                const peer = client.id ? server.sockets.sockets.get(client.id)?.conn : undefined;
                if (!client.connected || !peer) throw new Error('Requester fixture channel is unavailable');
                if (failedUpgrades.has(client)) throw new Error('Requester fixture transport upgrade failed');
                // The host supplies transport names. Polling-only channels have no upgrade to await.
                const transports = client.io.opts.transports;
                if (client.io.opts.upgrade === false || transports && !transports.some(transport => transport === 'websocket')
                    || !server.engine.upgrades('polling').includes('websocket')) return;
                await new Promise<void>((resolve, reject) => {
                    const cleanup = () => {
                        engine.off('upgrade', complete);
                        engine.off('upgradeError', fail);
                        engine.off('close', fail);
                        peer.off('upgrade', complete);
                        peer.off('close', fail);
                    };
                    const complete = () => {
                        if (engine.transport.name !== 'websocket' || peer.transport.name !== 'websocket') return;
                        cleanup();
                        resolve();
                    };
                    const fail = () => { cleanup(); reject(new Error('Requester fixture transport upgrade failed')); };
                    engine.on('upgrade', complete);
                    engine.on('upgradeError', fail);
                    engine.on('close', fail);
                    peer.on('upgrade', complete);
                    peer.on('close', fail);
                    complete();
                });
            }));
        },
        async disconnect() {
            clients.forEach(client => client.disconnect());
        },
        async reconnect() {
            await Promise.all(clients.map(client => new Promise<void>((resolve, reject) => {
                client.once('connect', resolve);
                client.once('connect_error', reject);
                client.connect();
            })));
        },
        async pushProfile(accountId: string) {
            await deliver(UpdateBodySchema.parse({ t: 'update-account', id: accountId, name: 'Changed profile' }));
        },
        async pushSettings(accountId: string, settings: unknown, version: number) {
            await deliver(UpdateBodySchema.parse({ t: 'update-account', id: accountId,
                settingsV2: { content: { t: 'plain', v: settings }, version } }));
        },
        async hintSettings(settingsVersion: number) {
            await deliver(UpdateBodySchema.parse({ t: 'account-settings-changed', settingsVersion }));
        },
        async hintAccountChange(cursor?: number) {
            await deliver(UpdateBodySchema.parse({ t: 'account-change' }), cursor);
        },
        pushInvalidCurrentness: async (accountId: string) => await deliver({ t: 'update-account', id: accountId,
            encryptionCurrentness: { mode: 'unknown' } }),
        pushInvalidSettings: async (accountId: string) => await deliver({ t: 'update-account', id: accountId,
            settingsV2: { version: 'invalid', content: { t: 'plain', v: {} } } }),
        async push(accountId: string, currentness: unknown) {
            const body = UpdateBodySchema.parse({ t: 'update-account', id: accountId,
                encryptionCurrentness: currentness === null ? null : AccountEncryptionCurrentnessResponseSchema.parse(currentness) });
            await deliver(body);
        },
        async close() {
            redirect.mockRestore();
            clients.forEach(client => client.disconnect());
            server.disconnectSockets(true);
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}
