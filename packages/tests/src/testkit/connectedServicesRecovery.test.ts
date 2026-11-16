import { once } from 'node:events';
import { createServer, Server } from 'node:http';
import { connect, type Socket } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

const { startServerLight } = vi.hoisted(() => ({ startServerLight: vi.fn() }));

// Substitute only the Home process boundary; auth and the recording proxy stay real.
vi.mock('./process/serverLight', () => ({ startServerLight }));

import {
  isRuntimeAuthRecoveryAwaitingProviderOutcomeProof,
  startConnectedServicesClaudeDaemon,
  startConnectedServiceRecoveryProxy,
} from './connectedServicesRecovery';
import { withTimeoutMs } from './timing/withTimeout';

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForNoSockets(sockets: ReadonlySet<Socket>, label: string): Promise<void> {
  await withTimeoutMs({
    promise: new Promise<void>((resolve) => {
      const check = () => {
        if (sockets.size === 0) {
          resolve();
          return;
        }
        setTimeout(check, 25);
      };
      check();
    }),
    timeoutMs: 1_000,
    label,
  });
}

describe('startConnectedServiceRecoveryProxy', () => {
  it('closes upgraded upstream sockets when stopped', async () => {
    const targetSockets = new Set<Socket>();
    const target = createServer((_req, res) => {
      res.end('ok');
    });
    target.on('connection', (socket) => {
      targetSockets.add(socket);
      socket.once('close', () => targetSockets.delete(socket));
    });
    target.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      socket.resume();
      const ping = setInterval(() => {
        if (!socket.destroyed) socket.write('ping');
      }, 25);
      socket.once('close', () => clearInterval(ping));
      socket.once('error', () => clearInterval(ping));
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');

    const proxy = await startConnectedServiceRecoveryProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
      serviceId: 'openai-codex',
      groupId: 'group',
    });
    const proxyUrl = new URL(proxy.baseUrl);
    const socket = connect(Number(proxyUrl.port), proxyUrl.hostname);
    let stopPromise: Promise<void> | null = null;

    try {
      await once(socket, 'connect');
      socket.write([
        'GET /socket HTTP/1.1',
        `Host: ${proxyUrl.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n'));
      await once(socket, 'data');
      expect(targetSockets.size).toBeGreaterThan(0);

      stopPromise = proxy.stop();
      await expect(withTimeoutMs({
        promise: stopPromise,
        timeoutMs: 1_000,
        label: 'connected service recovery proxy stop',
      })).resolves.toBeUndefined();
      await expect(waitForNoSockets(targetSockets, 'connected service recovery upstream sockets to close')).resolves.toBeUndefined();
    } finally {
      socket.destroy();
      for (const targetSocket of targetSockets) targetSocket.destroy();
      await stopPromise?.catch(() => {});
      await closeServer(target);
    }
  });
});

describe('connected-services recovery proof-wait matchers', () => {
  it('recognizes runtime-auth intents pending on provider-outcome proof', () => {
    expect(isRuntimeAuthRecoveryAwaitingProviderOutcomeProof({
      status: 'resumed_awaiting_proof',
      lastError: 'recovery_unproven_awaiting_provider_outcome',
    })).toBe(true);
    expect(isRuntimeAuthRecoveryAwaitingProviderOutcomeProof({
      status: 'waiting',
      lastError: 'recovery_unproven_awaiting_provider_outcome',
    })).toBe(false);
  });
});

describe('startConnectedServicesClaudeDaemon setup cleanup', () => {
  it.each([true, false])('releases acquired listeners when Home auth fails (recording=%s)', async (recording) => {
    const listen = vi.spyOn(Server.prototype, 'listen');
    const home = createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unavailable' }));
    });
    home.listen(0, '127.0.0.1');
    await once(home, 'listening');
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('missing Home address');
    startServerLight.mockResolvedValue({
      baseUrl: `http://127.0.0.1:${address.port}`,
      stop: () => new Promise<void>((resolve, reject) => {
        home.close((error) => error ? reject(error) : resolve());
        home.closeAllConnections();
      }),
    });

    try {
      await expect(startConnectedServicesClaudeDaemon({
        testDir: 'unused-before-auth',
        testName: 'setup-auth-failure',
        tokenUrl: 'http://unused.invalid/token',
        fakeClaudePath: 'unused-before-auth',
        fakeClaudeLogPath: 'unused-before-auth',
        ...(recording ? { recordHomeRequests: true } : {}),
      })).rejects.toThrow('Failed to create test auth token (status=503)');

      const listeners = listen.mock.contexts.filter((server): server is Server => server instanceof Server);
      const proxy = listeners.find((server) => server !== home);
      if (recording) {
        expect(proxy).toBeDefined();
        expect(proxy?.listening).toBe(false);
      }
      expect(home.listening).toBe(false);
    } finally {
      // Also release the deliberately leaked listeners during the RED run.
      const listeners = listen.mock.contexts.filter((server): server is Server => server instanceof Server);
      listen.mockRestore();
      await Promise.all(listeners.filter((server) => server.listening).map((server) => new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })));
    }
  });
});
