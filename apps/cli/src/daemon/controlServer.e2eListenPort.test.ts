import { createServer } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startDaemonControlServer } from './controlServer';

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
