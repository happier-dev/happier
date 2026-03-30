import http from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/projectPath', () => ({
  projectPath: () => '/missing-bunfs-root',
}));

import { configuration, reloadConfiguration } from '@/configuration';
import { clearDaemonState, writeDaemonState } from '@/persistence';
import { isDaemonRunningCurrentlyInstalledHappyVersion } from '@/daemon/controlClient';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

function listen(server: http.Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('unexpected server address'));
        return;
      }
      resolve({ port: addr.port });
    });
  });
}

describe('daemon control client version check', () => {
  const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

  afterEach(async () => {
    await clearDaemonState();
    envScope.restore();
    reloadConfiguration();
    vi.restoreAllMocks();
  });

  it('uses the resolved current CLI version when packaged runtime package.json is unavailable', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/ping') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);

      await withTempDir('happier-daemon-version-check-', async (tmpHomeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
        reloadConfiguration();
        writeDaemonState({
          pid: process.pid,
          httpPort: port,
          startedAt: Date.now(),
          startedWithCliVersion: configuration.currentCliVersion,
          machineId: 'machine-current',
          controlToken: 'test-token',
        });

        await expect(isDaemonRunningCurrentlyInstalledHappyVersion()).resolves.toBe(true);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('treats a same-version daemon as incompatible when it belongs to a different machine id', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/ping') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);

      await withTempDir('happier-daemon-version-check-', async (tmpHomeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
        reloadConfiguration();
        writeDaemonState({
          pid: process.pid,
          httpPort: port,
          startedAt: Date.now(),
          startedWithCliVersion: configuration.currentCliVersion,
          machineId: 'machine-old',
          controlToken: 'test-token',
        });

        await expect(isDaemonRunningCurrentlyInstalledHappyVersion({ expectedMachineId: 'machine-new' })).resolves.toBe(false);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('treats a recent startup-grace daemon as compatible when version and machine id already match', async () => {
    const realFetch = globalThis.fetch;

    try {
      await withTempDir('happier-daemon-version-check-', async (tmpHomeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
        reloadConfiguration();

        const daemonPort = 43210;
        vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
          if (url.hostname === '127.0.0.1' && Number(url.port) === daemonPort) {
            throw new TypeError('fetch failed');
          }
          return await realFetch(input, init);
        });

        writeDaemonState({
          pid: process.pid,
          httpPort: daemonPort,
          startedAt: Date.now(),
          startedWithCliVersion: configuration.currentCliVersion,
          machineId: 'machine-current',
          controlToken: 'test-token',
        });

        await expect(
          isDaemonRunningCurrentlyInstalledHappyVersion({ expectedMachineId: 'machine-current' }),
        ).resolves.toBe(true);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
