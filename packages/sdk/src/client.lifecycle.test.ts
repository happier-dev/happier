import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { Server as NotificationServer } from 'socket.io';

import { connect } from './index.js';

const servers: Server[] = [];
const sockets = new Set<Socket>();
const notificationServers: NotificationServer[] = [];

afterEach(async () => {
  await Promise.all(notificationServers.map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
  notificationServers.length = 0;
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(async (server) => await new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  servers.length = 0;
  sockets.clear();
});

describe('Happier SDK client lifecycle', () => {
  it('releases its HTTP connection when the client is closed after a finite Action', async () => {
    let socketClosed = false;
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        v: 1,
        actionId: 'machines.list',
        execution: { ok: true, result: [] },
      }));
    });
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => {
        socketClosed = true;
        sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test endpoint.');

    const client = connect({ endpoint: `http://127.0.0.1:${address.port}`, token: 'hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    await expect(client.actions.execute('machines.list', {})).resolves.toEqual([]);

    await client.close();

    await expect.poll(() => socketClosed, { interval: 10, timeout: 1_000 }).toBe(true);
  });

  it('recovers after declared and streamed oversized responses on real sockets', async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.on('error', () => undefined);
      if (requestCount === 1) {
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': '24000001',
        });
        response.write('{');
        return;
      }
      if (requestCount === 2) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(Buffer.alloc(24_000_001, 0x20));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        v: 1,
        actionId: 'machines.list',
        execution: { ok: true, result: [] },
      }));
    });
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test endpoint.');

    const client = connect({
      endpoint: `http://127.0.0.1:${address.port}`,
      token: 'hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    await expect(client.actions.execute('machines.list', {})).rejects.toMatchObject({
      code: 'response_too_large',
    });
    await expect(client.actions.execute('machines.list', {})).rejects.toMatchObject({
      code: 'response_too_large',
    });
    await expect(client.actions.execute('machines.list', {})).resolves.toEqual([]);

    await client.close();
    expect(requestCount).toBe(3);
  });

  it('bounds iterator return and close and releases real sockets when transcript cleanup never responds', async () => {
    let unfollowSeen = false;
    let socketClosed = false;
    const server = createServer((request, response) => {
      const actionId = decodeURIComponent(request.url?.split('/').at(-1) ?? '');
      if (actionId === 'session.status.get') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          v: 1,
          actionId,
          execution: { ok: true, result: { session: { active: false } } },
        }));
        return;
      }
      if (actionId === 'transcript.follow') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          v: 1,
          actionId,
          execution: { ok: true, result: { items: [{ role: 'assistant' }], nextCursor: '1', truncated: false } },
        }));
        return;
      }
      if (actionId === 'transcript.unfollow') {
        unfollowSeen = true;
        return;
      }
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unexpected_action' }));
    });
    const notifications = new NotificationServer(server, { path: '/v1/updates/' });
    notificationServers.push(notifications);
    const handshakes: unknown[] = [];
    notifications.on('connection', (socket) => { handshakes.push(socket.handshake.auth); });
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => {
        socketClosed = true;
        sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test endpoint.');

    const client = connect({ endpoint: `http://127.0.0.1:${address.port}`, token: 'hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const iterator = client.sessions.get('session-1').followTranscript()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { role: 'assistant' } });
    expect(handshakes).toEqual([]);
    const returned = await Promise.race([
      iterator.return!().then(() => 'returned' as const),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 1_500)),
    ]);
    expect(returned).toBe('returned');
    expect(unfollowSeen).toBe(true);

    const close = client.close();
    try {
      const outcome = await Promise.race([
        close.then(() => 'closed' as const),
        new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 1_500)),
      ]);

      expect(unfollowSeen).toBe(true);
      expect(outcome).toBe('closed');
      await expect.poll(() => socketClosed, { interval: 10, timeout: 1_000 }).toBe(true);
      await expect.poll(() => sockets.size, { interval: 10, timeout: 1_000 }).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await close.catch(() => undefined);
    }
  });
});
