import { stubUndiciFetch } from '@/testkit/http/stubUndiciFetch';
import http from 'node:http';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFiles = vi.hoisted(() => ({ unavailablePath: null as string | null }));
// The package root and version resolver stay real; only the OS read fails.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]) === nativeFiles.unavailablePath) {
        throw Object.assign(new Error('fixture package file unavailable'), { code: 'ENOENT' });
      }
      return actual.readFileSync(...args);
    },
  };
});

import { configuration, reloadConfiguration } from '@/configuration';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import { isDaemonRunningCurrentlyInstalledHappyVersion } from '@/daemon/controlClient';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { spawnSleepyDetachedProcess } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { projectPath } from '@/projectPath';

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
    nativeFiles.unavailablePath = null;
    await clearDaemonStateForTestTeardown();
    envScope.restore();
    reloadConfiguration();
    vi.restoreAllMocks();
  });

  it('uses the resolved current CLI version when packaged runtime package.json is unavailable', async () => {
    nativeFiles.unavailablePath = join(projectPath(), 'package.json');
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/ping') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok' }));
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
        res.end(JSON.stringify({ status: 'ok' }));
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
    const owner = spawnSleepyDetachedProcess(['/opt/happier/package-dist/index.mjs', 'daemon', 'start-sync']);

    try {
      await withTempDir('happier-daemon-version-check-', async (tmpHomeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
        reloadConfiguration();

        const daemonPort = 43210;
        stubUndiciFetch(async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
          if (url.hostname === '127.0.0.1' && Number(url.port) === daemonPort) {
            throw new TypeError('fetch failed');
          }
          return await realFetch(input, init);
        });

        writeDaemonState({
          pid: owner.pid,
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
      await owner.kill();
      vi.unstubAllGlobals();
    }
  });
});
