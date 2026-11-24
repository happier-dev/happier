import { createServer } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startDaemonControlServer } from './controlServer';
import { requestDaemonSessionConnectedServiceAuthSwitch } from './controlClient';
import { createConnectedServiceSwitchDeferralQueue } from './connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { SessionConnectedServiceAuthSwitchReceiptSchema } from '@happier-dev/protocol/connect/sessionConnectedServiceAuthSwitch';

async function reserveAvailablePort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing reserved port');
    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('daemon control server E2E listen port', () => {
  const originalPort = process.env.HAPPIER_E2E_DAEMON_CONTROL_PORT;

  afterEach(() => {
    if (originalPort === undefined) {
      delete process.env.HAPPIER_E2E_DAEMON_CONTROL_PORT;
    } else {
      process.env.HAPPIER_E2E_DAEMON_CONTROL_PORT = originalPort;
    }
    vi.restoreAllMocks();
  });

  it('withdraws a disconnected switch before the turn boundary and accepts a fresh switch', async () => {
    const admitted = Promise.withResolvers<void>();
    const emit = vi.fn((_sessionId: string, event: unknown) => {
      if ((event as { type: string }).type === 'connected_service_account_switch_deferred') admitted.resolve();
    });
    const queue = createConnectedServiceSwitchDeferralQueue({ disableDeferral: false, emitSessionEvent: emit });
    const sessionId = 'session';
    const receipt = { ok: true, action: 'hot_applied' } as const;
    const apply = vi.fn(async () => receipt);
    const boundary = () => queue.recordTurnLifecycleEvent({ sessionId, event: 'assistant_message_end' });
    queue.recordTurnLifecycleEvent({ sessionId, event: 'task_started' });
    const started = await startDaemonControlServer({
      getChildren: () => [], machineId: 'machine', controlToken: 'test-control',
      stopSession: async () => ({ status: 'stopped' }), spawnSession: async () => ({ type: 'success', sessionId }),
      requestShutdown: vi.fn(), onHappySessionWebhook: vi.fn(),
      handleSessionConnectedServiceAuthSwitch: async (input, signal?: AbortSignal) =>
        SessionConnectedServiceAuthSwitchReceiptSchema.parse(await queue.requestSwitch({
          sessionId: input.sessionId, source: 'manual', policy: 'defer_until_turn_boundary', signal,
          target: { serviceId: 'test.plugin/service', profileId: 'selected', groupId: '', generation: 0 },
          runSwitch: apply,
        })),
    });
    const target = { httpPort: started.port, pid: process.pid, controlToken: 'test-control' };
    const body = { sessionId, agentId: 'codex', bindings: { v: 2, bindingsByServiceId: {} } } as const;
    try {
      const caller = new AbortController();
      const request = requestDaemonSessionConnectedServiceAuthSwitch(body, { target, signal: caller.signal });
      const observed = expect(request).rejects.toThrow('caller retired');
      await admitted.promise;
      caller.abort(new Error('caller retired'));
      await observed;
      await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(sessionId, expect.objectContaining({
        type: 'connected_service_account_switch_deferral_completed', reason: 'switch_cancelled',
      })));
      boundary();
      expect(apply).not.toHaveBeenCalled();
      await expect(requestDaemonSessionConnectedServiceAuthSwitch(body, { target }))
        .resolves.toEqual(SessionConnectedServiceAuthSwitchReceiptSchema.parse(receipt));
      expect(apply).toHaveBeenCalledOnce();
    } finally {
      boundary();
      await started.stop();
    }
  });

  it('binds the explicitly reserved E2E control port', async () => {
    const requestedPort = await reserveAvailablePort();
    process.env.HAPPIER_E2E_DAEMON_CONTROL_PORT = String(requestedPort);

    const started = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine-e2e-control-port',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: vi.fn(),
      controlToken: 'test-control-token',
    });

    try {
      expect(started.port).toBe(requestedPort);
    } finally {
      await started.stop();
    }
  });
});
