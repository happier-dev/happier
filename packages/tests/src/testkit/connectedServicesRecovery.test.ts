import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  findSessionContinuationProofWaitAttempt,
  isRuntimeAuthRecoveryAwaitingProviderOutcomeProof,
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
  it('finds the matching continuation attempt only when it is awaiting provider proof', () => {
    const attempt = findSessionContinuationProofWaitAttempt({
      attempts: [
        {
          attemptId: 'unrelated',
          status: 'awaiting_provider_activity',
          continuationRequired: true,
          replayMode: 'continuation_prompt',
          serviceId: 'claude-subscription',
          groupId: 'team',
          profileId: 'other',
        },
        {
          attemptId: 'matching',
          status: 'provider_activity_timeout',
          continuationRequired: true,
          replayMode: 'continuation_prompt',
          serviceId: 'claude-subscription',
          groupId: 'team',
          profileId: 'primary',
        },
      ],
      serviceId: 'claude-subscription',
      groupId: 'team',
      profileId: 'primary',
    });

    expect(attempt).toMatchObject({ attemptId: 'matching' });
    expect(findSessionContinuationProofWaitAttempt({
      attempts: [
        {
          attemptId: 'local-only',
          status: 'restart_requested',
          continuationRequired: true,
          replayMode: 'continuation_prompt',
          serviceId: 'claude-subscription',
          groupId: 'team',
          profileId: 'primary',
        },
      ],
      serviceId: 'claude-subscription',
      groupId: 'team',
      profileId: 'primary',
    })).toBeNull();
  });

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
