import { createServer, type Server } from 'node:http';
import { createServer as createPortReservationServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveRelayRuntimeDefaults } from '../firstPartyRuntime/relayRuntime.js';

async function withTemporaryHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'relay-host-engine-local-health-'));
  await run(homeDir);
}

async function startRelayHealthServer(params: Readonly<{ port: number; healthPath: string }>): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === params.healthPath) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '0.1.2' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(params.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return server;
}

async function reserveUnusedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createPortReservationServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to reserve relay test port'));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

describe('RelayHostEngine (local health)', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('marks a local relay unhealthy when the service is active but the health endpoint is unreachable', async () => {
    await withTemporaryHome(async (homeDir) => {
      const port = await reserveUnusedPort();
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });

      await mkdir(defaults.configDir, { recursive: true });
      await mkdir(defaults.installRoot, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), `PORT=${port}\nHAPPIER_SERVER_HOST=127.0.0.1\n`, 'utf8');
      await writeFile(join(defaults.installRoot, 'self-host-state.json'), JSON.stringify({ version: '0.1.2' }), 'utf8');

      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              return { status: 0, stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\n', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      const status = await engine.readStatus({
        target: { kind: 'local' },
        channel: 'stable',
        mode: 'user',
      });

      expect(status.service).toEqual({ enabled: true, active: true });
      expect(status.healthy).toBe(false);
    });
  });

  it('waits for local start to become healthy before returning', async () => {
    await withTemporaryHome(async (homeDir) => {
      const port = await reserveUnusedPort();
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });

      await mkdir(defaults.configDir, { recursive: true });
      await mkdir(defaults.logDir, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), `PORT=${port}\nHAPPIER_SERVER_HOST=127.0.0.1\n`, 'utf8');

      let server: Server | null = null;
      const delayedStart = setTimeout(async () => {
        server = await startRelayHealthServer({ port, healthPath: defaults.healthPath });
      }, 250);

      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args[1] === 'start') {
              return { status: 0, stdout: '', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      try {
        const { createRelayHostEngine } = await import('./relayHostEngine.js');
        const engine = createRelayHostEngine({
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
          copyLocalDirectoryToRemote: async () => {},
          installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
        });

        const startedAt = Date.now();
        await engine.control({
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
          action: 'start',
        });

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
      } finally {
        clearTimeout(delayedStart);
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      }
    });
  });

  it('waits for local restart to become healthy before returning', async () => {
    await withTemporaryHome(async (homeDir) => {
      const port = await reserveUnusedPort();
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });

      await mkdir(defaults.configDir, { recursive: true });
      await mkdir(defaults.logDir, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), `PORT=${port}\nHAPPIER_SERVER_HOST=127.0.0.1\n`, 'utf8');

      let server: Server | null = null;
      const delayedStart = setTimeout(async () => {
        server = await startRelayHealthServer({ port, healthPath: defaults.healthPath });
      }, 250);

      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args[1] === 'restart') {
              return { status: 0, stdout: '', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      try {
        const { createRelayHostEngine } = await import('./relayHostEngine.js');
        const engine = createRelayHostEngine({
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
          copyLocalDirectoryToRemote: async () => {},
          installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
        });

        const startedAt = Date.now();
        await engine.control({
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
          action: 'restart',
        });

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
      } finally {
        clearTimeout(delayedStart);
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      }
    });
  });

  it('fails closed when another relay lane is already installed on the same local base URL', async () => {
    await withTemporaryHome(async (homeDir) => {
      const stableDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });
      const previewDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });

      await mkdir(stableDefaults.configDir, { recursive: true });
      await mkdir(stableDefaults.installRoot, { recursive: true });
      await writeFile(join(stableDefaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');
      await writeFile(join(stableDefaults.installRoot, 'self-host-state.json'), JSON.stringify({ version: '0.1.2' }), 'utf8');

      await mkdir(previewDefaults.installRoot, { recursive: true });
      const previewBinaryPath = join(previewDefaults.installRoot, 'happier-server');
      await writeFile(previewBinaryPath, '#!/usr/bin/env bash\n', 'utf8');

      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        localInstallPolicy: {
          runServiceCommands: false,
          skipHealthCheck: true,
        },
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        channel: 'preview',
        mode: 'user',
        selfHostRelayBinaryOverride: previewBinaryPath,
      })).rejects.toThrow(/stable/i);
    });
  });
});
