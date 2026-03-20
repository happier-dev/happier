import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/projectPath', () => ({
  projectPath: () => '/missing-bunfs-root',
}));

import { configuration, reloadConfiguration } from '@/configuration';
import { clearDaemonState, writeDaemonState } from '@/persistence';
import { isDaemonRunningCurrentlyInstalledHappyVersion } from '@/daemon/controlClient';

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
  let tmpHomeDir: string | null = null;

  afterEach(async () => {
    await clearDaemonState();
    delete process.env.HAPPIER_HOME_DIR;
    reloadConfiguration();
    if (tmpHomeDir) {
      await rm(tmpHomeDir, { recursive: true, force: true });
      tmpHomeDir = null;
    }
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

      tmpHomeDir = await mkdtemp(`${process.env.TMPDIR ?? '/tmp'}/happier-daemon-version-check-`);
      process.env.HAPPIER_HOME_DIR = tmpHomeDir;
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

      tmpHomeDir = await mkdtemp(`${process.env.TMPDIR ?? '/tmp'}/happier-daemon-version-check-`);
      process.env.HAPPIER_HOME_DIR = tmpHomeDir;
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
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
