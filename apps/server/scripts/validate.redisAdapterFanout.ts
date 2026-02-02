import http from 'node:http';
import assert from 'node:assert/strict';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import { Redis } from 'ioredis';

const ENV_REDIS_URL = process.env.REDIS_URL?.trim() ?? '';

const ROOM = 'user:test-user';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('Failed to determine server port');
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function main(): Promise<void> {
  let redisMemory: { stop: () => Promise<boolean>; getIp: () => Promise<string>; getPort: () => Promise<number> } | null = null;
  const redisUrl =
    ENV_REDIS_URL ||
    (await (async () => {
      const { RedisMemoryServer } = await import('redis-memory-server');
      redisMemory = await RedisMemoryServer.create();
      const ip = await redisMemory.getIp();
      const port = await redisMemory.getPort();
      return `redis://${ip}:${port}`;
    })());

  const redisA = new Redis(redisUrl);
  const redisB = new Redis(redisUrl);

  const httpA = http.createServer();
  const ioA = new Server(httpA, {
    path: '/v1/updates',
    transports: ['websocket'],
    serveClient: false,
    adapter: createAdapter(redisA),
  });

  const httpB = http.createServer();
  const ioB = new Server(httpB, {
    path: '/v1/updates',
    transports: ['websocket'],
    serveClient: false,
    adapter: createAdapter(redisB),
  });

  ioA.on('connection', (socket) => {
    socket.join(ROOM);
  });
  ioB.on('connection', (socket) => {
    socket.join(ROOM);
  });

  let client: ReturnType<typeof ioClient> | null = null;
  let bootstrap: ReturnType<typeof ioClient> | null = null;

  try {
    const portA = await listen(httpA);
    const portB = await listen(httpB);

    // Establish at least one connection on ioB so it fully boots and subscribes.
    bootstrap = ioClient(`http://127.0.0.1:${portB}`, {
      path: '/v1/updates',
      transports: ['websocket'],
      timeout: 5000,
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout connecting bootstrap client')), 6000);
      bootstrap!.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
      bootstrap!.once('connect_error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    client = ioClient(`http://127.0.0.1:${portA}`, {
      path: '/v1/updates',
      transports: ['websocket'],
      timeout: 5000,
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout connecting test client')), 6000);
      client!.once('connect', () => {
        clearTimeout(t);
        resolve();
      });
      client!.once('connect_error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    const gotUpdate = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Did not receive update via Redis adapter (timeout)')), 8000);
      client!.once('update', (payload: any) => {
        clearTimeout(t);
        resolve(payload);
      });
    });

    const payload = { kind: 'redis-adapter-fanout', at: Date.now() };
    ioB.to(ROOM).emit('update', payload);

    const received = await gotUpdate;
    assert.deepEqual(received, payload);

    console.log('PASS: Redis adapter cross-instance fanout delivered update to room member.');
  } finally {
    if (bootstrap) bootstrap.disconnect();
    if (client) client.disconnect();
    await ioA.close();
    await ioB.close();
    await closeServer(httpA);
    await closeServer(httpB);
    await redisA.quit();
    await redisB.quit();
    if (redisMemory) await redisMemory.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
