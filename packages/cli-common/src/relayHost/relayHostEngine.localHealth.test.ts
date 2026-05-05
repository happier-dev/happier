import { createServer, type Server } from 'node:http';
import { createServer as createPortReservationServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveRelayRuntimeDefaults } from '../firstPartyRuntime/relayRuntime.js';

async function withTemporaryHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'relay-host-engine-local-health-'));
  try {
    await run(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
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
              return { status: 0, stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nLoadState=loaded\n', stderr: '' };
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

  it('resolves a non-colliding desired local relay URL before lane conflict checks', async () => {
    await withTemporaryHome(async (homeDir) => {
      const stableDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });
      await mkdir(stableDefaults.configDir, { recursive: true });
      await mkdir(stableDefaults.installRoot, { recursive: true });
      await writeFile(join(stableDefaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');
      await writeFile(join(stableDefaults.installRoot, 'self-host-state.json'), JSON.stringify({ version: '0.3.0-test' }), 'utf8');

      const previewDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      await mkdir(previewDefaults.configDir, { recursive: true });
      await writeFile(join(previewDefaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');

      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');
      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

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
          spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        localInstallPolicy: { runServiceCommands: false, skipHealthCheck: true },
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      const result = await engine.installOrUpdate({
        target: { kind: 'local' },
        channel: 'preview',
        mode: 'user',
        selfHostRelayBinaryOverride: serverBinaryPath,
      });

      expect(result.relayUrl).not.toBe('http://127.0.0.1:3005');

      const status = await engine.readStatus({
        target: { kind: 'local' },
        channel: 'preview',
        mode: 'user',
      });
      expect(status.baseUrl).toBe(result.relayUrl);
    });
  });

  it('reports a warning when older legacy relay state with a different data secret remains beside the canonical preview root', async () => {
    await withTemporaryHome(async (homeDir) => {
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const legacyInstallRoot = join(homeDir, '.happier', 'l1', 'self-host');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');

      await mkdir(defaults.configDir, { recursive: true });
      await mkdir(join(defaults.installRoot, 'data'), { recursive: true });
      await mkdir(join(legacyInstallRoot, 'data'), { recursive: true });
      await mkdir(unitDir, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');
      await writeFile(join(defaults.installRoot, 'self-host-state.json'), JSON.stringify({ version: '0.2.4' }), 'utf8');
      await writeFile(join(defaults.installRoot, 'data', 'handy-master-secret.txt'), 'preview-secret\n', 'utf8');
      await writeFile(join(legacyInstallRoot, 'data', 'handy-master-secret.txt'), 'legacy-secret\n', 'utf8');
      await writeFile(join(defaults.installRoot, 'data', 'happier-server-light.sqlite'), 'preview-db\n', 'utf8');
      await writeFile(join(legacyInstallRoot, 'data', 'happier-server-light.sqlite'), 'legacy-db\n', 'utf8');
      await writeFile(
        join(unitDir, 'happier-server.service'),
        [
          '[Unit]',
          'Description=Happier Relay Runtime',
          '[Service]',
          `WorkingDirectory=${legacyInstallRoot}`,
          'Environment=PORT=3005',
          'Environment=HAPPIER_SERVER_HOST=127.0.0.1',
          `ExecStart=${legacyInstallRoot}/bin/happier-server`,
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(unitDir, 'happier-server-preview.service'),
        [
          '[Unit]',
          'Description=Happier Relay Runtime (happier-server-preview)',
          '[Service]',
          `WorkingDirectory=${defaults.installRoot}`,
          'Environment=PORT=3005',
          'Environment=HAPPIER_SERVER_HOST=127.0.0.1',
          `ExecStart=${defaults.installRoot}/bin/happier-server`,
          '',
        ].join('\n'),
        'utf8',
      );

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
              const unit = String(args.find((value) => String(value).endsWith('.service')) ?? '');
              if (unit === 'happier-server-preview.service') {
                return { status: 0, stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nLoadState=loaded\n', stderr: '' };
              }
              if (unit === 'happier-server.service') {
                return { status: 0, stdout: 'ActiveState=inactive\nSubState=dead\nUnitFileState=disabled\nLoadState=loaded\n', stderr: '' };
              }
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
        channel: 'preview',
        mode: 'user',
      });

      const warnings = (status as Readonly<{ warnings?: readonly string[] }>).warnings ?? [];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(legacyInstallRoot);
      expect(warnings[0]).toMatch(/different data secret/i);
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

        await engine.control({
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
          action: 'start',
        });

        expect(server).not.toBeNull();
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

        await engine.control({
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
          action: 'restart',
        });

        expect(server).not.toBeNull();
      } finally {
        clearTimeout(delayedStart);
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      }
    });
  });

  it('auto-selects a non-colliding URL when another relay lane already uses the default local base URL', async () => {
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

      const result = await engine.installOrUpdate({
        target: { kind: 'local' },
        channel: 'preview',
        mode: 'user',
        selfHostRelayBinaryOverride: previewBinaryPath,
      });

      expect(result.relayUrl).not.toBe('http://127.0.0.1:3005');
    });
  });

  it('fails closed when an active legacy unsuffixed unit with a custom root owns the requested local base URL', async () => {
    await withTemporaryHome(async (homeDir) => {
      const port = await reserveUnusedPort();
      const previewDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const legacyInstallRoot = join(homeDir, '.happier', 'l1', 'self-host');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');

      await mkdir(previewDefaults.installRoot, { recursive: true });
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        join(unitDir, 'happier-server.service'),
        [
          '[Unit]',
          'Description=Happier Self-Host (happier-server)',
          '[Service]',
          `WorkingDirectory=${legacyInstallRoot}`,
          `Environment=PORT=${port}`,
          'Environment=HAPPIER_SERVER_HOST=127.0.0.1',
          `ExecStart=${legacyInstallRoot}/bin/happier-server`,
          '',
        ].join('\n'),
        'utf8',
      );

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
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              const unitArg = args.find((entry) => typeof entry === 'string' && entry.endsWith('.service')) ?? '';
              if (unitArg === 'happier-server.service') {
                return {
                  status: 0,
                  stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nLoadState=loaded\n',
                  stderr: '',
                };
              }
              return { status: 1, stdout: 'LoadState=not-found\n', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
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
        env: { PORT: String(port), HAPPIER_SERVER_HOST: '127.0.0.1' },
      })).rejects.toThrow(/legacy.*happier-server/i);
    });
  });

  it('migrates legacy unsuffixed self-host installs when their state already records the preview lane', async () => {
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
      await writeFile(join(stableDefaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');
      await mkdir(stableDefaults.installRoot, { recursive: true });
      await writeFile(
        join(stableDefaults.installRoot, 'self-host-state.json'),
        JSON.stringify({ channel: 'preview', mode: 'user', version: '0.1.0-preview.legacy' }),
        'utf8',
      );

      const payloadDir = join(homeDir, 'payload-preview');
      await mkdir(payloadDir, { recursive: true });
      const previewBinaryPath = join(payloadDir, 'happier-server');
      await writeFile(previewBinaryPath, '#!/usr/bin/env bash\n', 'utf8');

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
              const unitArg = args.find((entry) => typeof entry === 'string' && entry.endsWith('.service')) ?? '';
              if (unitArg === 'happier-server.service') {
                return { status: 0, stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nLoadState=loaded\n', stderr: '' };
              }
              return { status: 1, stdout: 'LoadState=not-found\n', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
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
      })).resolves.toBeDefined();

      // Migration success signal: the legacy state file was moved under the requested lane's install root.
      // (Non-canonical root files may be pruned by install routines.)
      expect(existsSync(join(previewDefaults.installRoot, 'self-host-state.json'))).toBe(true);
      expect(existsSync(join(stableDefaults.installRoot, 'self-host-state.json'))).toBe(false);
    });
  });
});
