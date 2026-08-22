import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const trackedEnvKeys = [
  'HOME',
  'USERPROFILE',
  'PATH',
  'HAPPIER_SELF_HOST_INSTALL_ROOT',
  'HAPPIER_SELF_HOST_CONFIG_DIR',
  'HAPPIER_SELF_HOST_DATA_DIR',
  'HAPPIER_SELF_HOST_LOG_DIR',
  'HAPPIER_SQLITE_CONNECTION_LIMIT',
  'HAPPY_SQLITE_CONNECTION_LIMIT',
] as const;

const previousEnv = new Map<string, string | undefined>();

function patchEnv(patch: Partial<Record<(typeof trackedEnvKeys)[number], string | undefined>>): void {
  for (const key of trackedEnvKeys) {
    if (!previousEnv.has(key)) {
      previousEnv.set(key, process.env[key]);
    }
    const value = patch[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  for (const key of trackedEnvKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  previousEnv.clear();
});

describe('readLiveRelayRuntimeStatus', () => {
  it('treats localized Windows scheduled-task status as active when the task is running', async () => {
    const scopedHomeDir = await mkdtemp(path.join(tmpdir(), 'happier-relay-runtime-win-home-'));
    const installRoot = path.join(scopedHomeDir, 'self-host', 'install');
    const configDir = path.join(scopedHomeDir, 'self-host', 'config');
    const originalPlatform = process.platform;
    const originalFetch = globalThis.fetch;

    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      patchEnv({
        HOME: scopedHomeDir,
        USERPROFILE: scopedHomeDir,
        PATH: 'C:\\Windows\\System32',
        HAPPIER_SELF_HOST_INSTALL_ROOT: '~/self-host/install',
        HAPPIER_SELF_HOST_CONFIG_DIR: '~/self-host/config',
        HAPPIER_SELF_HOST_DATA_DIR: '~/self-host/data',
        HAPPIER_SELF_HOST_LOG_DIR: '~/self-host/logs',
      });

      await mkdir(installRoot, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await writeFile(
        path.join(installRoot, 'relay-runtime-state.json'),
        `${JSON.stringify({ version: 'happier-server-v0.2.4-windows-x64' })}\n`,
        'utf8',
      );
      await writeFile(path.join(configDir, 'server.env'), 'PORT=3005\r\nHOST=127.0.0.1\r\n', 'utf8');

      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      })) as unknown as typeof fetch;

      vi.doMock('@happier-dev/cli-common/process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
        return {
          ...actual,
          commandExistsOnPath: () => true,
        };
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string) => {
            if (cmd === 'powershell.exe') {
              return {
                status: 0,
                stdout: '{"exists":true,"enabled":true,"active":true,"stateLabel":"Running"}',
                stderr: '',
              };
            }
            if (cmd === 'schtasks') {
              return {
                status: 0,
                stdout: 'Statut: En cours\r\nStatut de la tâche planifiée: Activée\r\n',
                stderr: '',
              };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      vi.doMock('node:net', async () => {
        const actual = await vi.importActual<typeof import('node:net')>('node:net');
        const createConnection = () => {
          const socket = new EventEmitter() as EventEmitter & {
            setTimeout: (timeoutMs: number, handler?: () => void) => void;
            destroy: () => void;
            removeAllListeners: () => EventEmitter;
          };
          socket.setTimeout = (_timeoutMs: number, _handler?: () => void) => undefined;
          socket.destroy = () => undefined;
          process.nextTick(() => socket.emit('connect'));
          return socket;
        };
        return {
          ...actual,
          createConnection,
          default: {
            ...actual,
            createConnection,
          },
        };
      });

      const { readLiveRelayRuntimeStatus } = await import('./liveRelayRuntime');
      const status = await readLiveRelayRuntimeStatus({
        platform: 'win32',
        mode: 'user',
        channel: 'preview',
        homeDir: scopedHomeDir,
      });

      expect(status.service.enabled).toBe(true);
      expect(status.service.active).toBe(true);
      expect(status.service.stateLabel).toBe('Running');
      expect(status.health.reachable).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      globalThis.fetch = originalFetch;
      vi.resetModules();
      vi.clearAllMocks();
      await rm(scopedHomeDir, { recursive: true, force: true });
    }
  });
});

describe('startLiveRelayRuntime', () => {
  it.each([
    {
      scenario: 'the canonical server-light default when no override is configured',
      connectionLimit: undefined,
      expectedConnectionLimit: '4',
    },
    {
      scenario: 'an explicit server-light override',
      connectionLimit: '1',
      expectedConnectionLimit: '1',
    },
  ])('writes $scenario', async ({ connectionLimit, expectedConnectionLimit }) => {
    const scopedHomeDir = await mkdtemp(path.join(tmpdir(), 'happier-relay-runtime-sqlite-default-'));
    const installRoot = path.join(scopedHomeDir, 'self-host', 'install');
    const configDir = path.join(scopedHomeDir, 'self-host', 'config');

    try {
      patchEnv({
        HOME: scopedHomeDir,
        USERPROFILE: scopedHomeDir,
        PATH: process.env.PATH,
        HAPPIER_SELF_HOST_INSTALL_ROOT: installRoot,
        HAPPIER_SELF_HOST_CONFIG_DIR: configDir,
        HAPPIER_SELF_HOST_DATA_DIR: path.join(scopedHomeDir, 'self-host', 'data'),
        HAPPIER_SELF_HOST_LOG_DIR: path.join(scopedHomeDir, 'self-host', 'logs'),
        HAPPIER_SQLITE_CONNECTION_LIMIT: connectionLimit,
        HAPPY_SQLITE_CONNECTION_LIMIT: undefined,
      });

      vi.doMock('@happier-dev/cli-common/service', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@happier-dev/cli-common/service')>();
        return {
          ...actual,
          applyServicePlan: vi.fn(async () => undefined),
        };
      });

      const { startLiveRelayRuntime } = await import('./liveRelayRuntime');
      await startLiveRelayRuntime({
        platform: process.platform,
        mode: 'user',
        channel: 'stable',
        homeDir: scopedHomeDir,
      });

      const renderedEnv = await readFile(path.join(configDir, 'server.env'), 'utf8');
      expect(renderedEnv).toContain(`connection_limit=${expectedConnectionLimit}`);
    } finally {
      vi.resetModules();
      vi.clearAllMocks();
      await rm(scopedHomeDir, { recursive: true, force: true });
    }
  });
});
