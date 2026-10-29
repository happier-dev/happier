import { createServer, type Server as HttpServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';
import { createHappierSocket } from './createHappierSocket.js';

let http: HttpServer;
let server: Server;
const disposers: Array<() => Promise<void>> = [];
async function start(options: Partial<ConstructorParameters<typeof Server>[1]> = {}) {
  http = createServer();
  server = new Server(http, { path: '/v1/updates/', ...options });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No bound address');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('shared Socket.IO transport', () => {
  it('keeps all settled UI purposes on WebSocket with zero polling or connection churn for an idle minute', async () => {
    const endpoint = await start();
    let pollingRequests = 0, connections = 0, disconnects = 0;
    http.prependListener('request', (request) => {
      if (new URL(request.url ?? '/', endpoint).searchParams.get('transport') === 'polling') pollingRequests++;
    });
    server.engine.on('connection', (engine) => {
      connections++;
      engine.on('close', () => { disconnects++; });
    });
    const clients = ['sync', 'scoped-rpc', 'concurrent-server-cache'].map((clientPurpose) => {
      const client = createHappierSocket({ endpoint, token: 'test', clientType: 'user-scoped', clientPurpose });
      disposers.push(() => client.transport.destroy());
      return client;
    });
    await Promise.all(clients.map(async ({ socket, transport }) => {
      await transport.connect();
      if (socket.io.engine.transport.name !== 'websocket') {
        await new Promise<void>((resolve) => socket.io.engine.once('upgrade', () => resolve()));
      }
    }));
    expect(pollingRequests).toBeGreaterThan(0);
    const settled = { pollingRequests, connections, disconnects };
    await delay(60_000);
    expect({ pollingRequests, connections, disconnects }).toEqual(settled);
    expect(clients.map(({ socket }) => socket.io.engine.transport.name)).toEqual(['websocket', 'websocket', 'websocket']);
    expect(connections).toBe(3);
    expect(disconnects).toBe(0);
  }, 90_000);

  it('keeps polling usable when the server cannot upgrade', async () => {
    const endpoint = await start({ allowUpgrades: false, pingInterval: 25, pingTimeout: 1_000 });
    let pollingRequests = 0, connections = 0;
    http.prependListener('request', (request) => {
      if (new URL(request.url ?? '/', endpoint).searchParams.get('transport') === 'polling') pollingRequests++;
    });
    server.on('connection', (socket) => {
      connections++;
      socket.on('fixture-echo', (value, ack) => ack(value));
    });
    const { socket, transport } = createHappierSocket({ endpoint, token: 'test', clientType: 'user-scoped' });
    disposers.push(() => transport.destroy());
    await transport.connect();
    const settledRequests = pollingRequests;
    await delay(150);
    expect(socket.io.engine.transport.name).toBe('polling');
    expect(pollingRequests).toBeGreaterThan(settledRequests);
    expect(await socket.emitWithAck('fixture-echo', { value: 1 })).toEqual({ value: 1 });
    expect(connections).toBe(1);
  });

  it('can keep one client on fallback while another upgrades without idle connection churn', async () => {
    const endpoint = await start({ pingInterval: 25, pingTimeout: 1_000 });
    let blockedConnection: string | undefined;
    let fallbackPolls = 0, connections = 0, disconnects = 0;
    server.engine.on('connection', (engine) => {
      connections++;
      blockedConnection ??= engine.id;
      engine.on('close', () => { disconnects++; });
    });
    // A real network failure at the HTTP upgrade boundary affects one dial,
    // while leaving the same server's other WebSocket upgrades available.
    http.prependListener('upgrade', (request, connection) => {
      if (new URL(request.url ?? '/', endpoint).searchParams.get('sid') === blockedConnection) connection.destroy();
    });
    http.prependListener('request', (request) => {
      const url = new URL(request.url ?? '/', endpoint);
      if (url.searchParams.get('transport') === 'polling' && url.searchParams.get('sid') === blockedConnection) fallbackPolls++;
    });
    const fallback = createHappierSocket({ endpoint, token: 'test', clientType: 'user-scoped', clientPurpose: 'sync' });
    disposers.push(() => fallback.transport.destroy());
    const failedProbe = new Promise<void>((resolve) => fallback.socket.io.once('open', () => {
      fallback.socket.io.engine.once('upgradeError', () => resolve());
    }));
    await fallback.transport.connect();
    await failedProbe;
    const healthy = createHappierSocket({ endpoint, token: 'test', clientType: 'user-scoped', clientPurpose: 'scoped-rpc' });
    disposers.push(() => healthy.transport.destroy());
    await healthy.transport.connect();
    if (healthy.socket.io.engine.transport.name !== 'websocket') {
      await new Promise<void>((resolve) => healthy.socket.io.engine.once('upgrade', () => resolve()));
    }
    const settledPolls = fallbackPolls;
    await delay(150);
    expect(fallbackPolls).toBeGreaterThan(settledPolls);
    expect(fallback.socket.io.engine.transport.name).toBe('polling');
    expect(healthy.socket.io.engine.transport.name).toBe('websocket');
    expect([fallback.socket.connected, healthy.socket.connected]).toEqual([true, true]);
    expect({ connections, disconnects }).toEqual({ connections: 2, disconnects: 0 });
  });

  it.each([
    { clientType: 'user-scoped' as const },
    { clientType: 'session-scoped' as const, sessionId: 's' },
    { clientType: 'session-scoped' as const, sessionId: 's', machineId: 'm' },
    { clientType: 'machine-scoped' as const, machineId: 'm' },
  ])('connects with exact role auth $clientType', async (role) => {
    const endpoint = await start();
    const auth = new Promise<Record<string, unknown>>((resolve) => server.once('connection', (s) => resolve(s.handshake.auth)));
    const { socket, transport } = createHappierSocket({ endpoint, token: 'test', ...role, clientPurpose: 'test', connectTimeoutMs: 1000 });
    disposers.push(() => transport.destroy());
    await transport.connect();
    expect(await auth).toEqual({ token: 'test', ...role, clientPurpose: 'test' });
    expect(socket.connected).toBe(true);
    const disconnected = new Promise<unknown>((resolve) => transport.onDisconnected(resolve));
    await transport.disconnect({ intentional: true });
    expect(await disconnected).toMatchObject({ intentional: true });
  });
  it('routes pre-connect errors to the connection attempt only', async () => {
    const endpoint = await start();
    server.use((_socket, next) => next(new Error('refused')));
    const { transport } = createHappierSocket({ endpoint, token: 'test', clientType: 'user-scoped', connectTimeoutMs: 1000 });
    disposers.push(() => transport.destroy());
    const errors: unknown[] = [];
    transport.onError((error) => errors.push(error));
    await expect(transport.connect()).rejects.toThrow('refused');
    expect(errors).toEqual([]);
  });
  it('uses the caller connection deadline', async () => {
    const endpoint = await start();
    server.use(() => {});
    const { transport } = createHappierSocket({ endpoint, token: 'test', clientType: 'user-scoped', connectTimeoutMs: 20 });
    disposers.push(() => transport.destroy());
    await expect(transport.connect()).rejects.toMatchObject({ code: 'socket_connect_timeout' });
  });
  it('forwards connected errors, resets intentional disconnect, and destroys all listeners', async () => {
    const endpoint = await start();
    const { socket, transport } = createHappierSocket({ endpoint, token: 'test', clientType: 'user-scoped' });
    disposers.push(() => transport.destroy());
    expect(socket.io.timeout()).toBe(false);
    await transport.connect();
    const error = new Promise<unknown>((resolve) => transport.onError(resolve));
    server.sockets.sockets.forEach((remote) => remote.emit('error', { code: 'remote_error' }));
    expect(await error).toEqual({ code: 'remote_error' });
    await transport.disconnect({ intentional: true });
    await transport.disconnect({ intentional: true });
    await transport.connect();
    const disconnected = new Promise<unknown>((resolve) => transport.onDisconnected(resolve));
    server.sockets.sockets.forEach((remote) => remote.disconnect(true));
    expect(await disconnected).toMatchObject({ intentional: false });
    await transport.connect();
    let destroyedNotifications = 0;
    transport.onDisconnected(() => { destroyedNotifications++; });
    socket.onAny(() => {});
    await transport.destroy();
    expect(socket.connected).toBe(false);
    expect(socket.listenersAny()).toEqual([]);
    expect(socket.listeners('connect')).toEqual([]);
    expect(destroyedNotifications).toBe(0);
    await expect(transport.connect()).rejects.toMatchObject({ code: 'socket_destroyed' });
  });
});
