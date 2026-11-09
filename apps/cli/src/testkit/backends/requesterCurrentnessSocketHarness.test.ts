import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { createUserScopedSocketConnection } from '@/api/session/sockets';
import { createRequesterCurrentnessSocketHarness } from './requesterCurrentnessSocketHarness';

afterEach(() => vi.restoreAllMocks());

it.each([
    { transports: ['polling'], settled: 'polling' },
    { transports: ['websocket'], settled: 'websocket' },
    { transports: ['polling', 'websocket'], settled: 'websocket' },
])('settles both ends of the genuine channel before host setup ($transports)', async ({ transports, settled }) => {
    const channel = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => channel.close());
    const connection = createUserScopedSocketConnection({ token: 'fixture-token' });
    connection.socket.io.opts.transports = transports;
    await connection.transport.connect();
    await channel.settleTransport();
    const peer = connection.socket.id ? channel.server.sockets.sockets.get(connection.socket.id) : undefined;
    expect(connection.socket.io.engine.transport.name).toBe(settled);
    expect(peer?.conn.transport.name).toBe(settled);
    // A caller may reuse an already settled admitted channel.
    await channel.settleTransport();
});

it('rejects a prior native upgrade failure and settles a replacement connection', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => channel.close());
    channel.server.engine.once('connection', peer => {
        peer.once('upgrading', transport => transport.close());
    });
    const connection = createUserScopedSocketConnection({ token: 'fixture-token' });
    connection.socket.io.opts.transports = ['polling', 'websocket'];
    const connecting = connection.transport.connect();
    const nativeFailure = new Promise<void>(resolve => {
        const engine = connection.socket.io.engine;
        const finished = () => { engine.off('upgradeError', finished); engine.off('close', finished); resolve(); };
        engine.once('upgradeError', finished);
        engine.once('close', finished);
    });
    await connecting;
    await nativeFailure;
    await expect(channel.settleTransport()).rejects.toThrow();
    await channel.disconnect();
    await channel.reconnect();
    await channel.settleTransport();
    expect(connection.socket.io.engine.transport.name).toBe('websocket');
});
