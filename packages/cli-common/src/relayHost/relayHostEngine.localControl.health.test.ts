import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { resolveRelayRuntimeDefaults } from '../firstPartyRuntime/relayRuntime.js';

describe('RelayHostEngine (local health control)', () => {
  it('reports the local relay as unhealthy when the service is active but the health probe fails', async () => {
    const originalPlatform = process.platform;
    const originalFetch = globalThis.fetch;
    const expectedRuntimeDir = `/run/user/${typeof process.getuid === 'function' ? process.getuid() : ''}`;

    Object.defineProperty(process, 'platform', { value: 'linux' });

    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      })) as unknown as typeof fetch;

      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => '/tmp/happy-home',
        };
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              expect(options?.env?.XDG_RUNTIME_DIR).toBe(expectedRuntimeDir);
              expect(options?.env?.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${expectedRuntimeDir}/bus`);
              return {
                status: 0,
                stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\n',
                stderr: '',
              };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          existsSync: (path: string) => path.includes('self-host-state.json') || path.endsWith('/bin/happier-server') || path.endsWith('/server.env'),
        };
      });

      vi.doMock('node:net', async () => {
        const actual = await vi.importActual<typeof import('node:net')>('node:net');
        return {
          ...actual,
          createConnection: () => {
            const socket = new EventEmitter() as EventEmitter & {
              setTimeout: (timeoutMs: number) => void;
              destroy: () => void;
            };
            socket.setTimeout = (_timeoutMs: number) => undefined;
            socket.destroy = () => undefined;
            process.nextTick(() => socket.emit('connect'));
            return socket;
          },
        };
      });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          readFile: async (path: string) => {
            if (path.endsWith('self-host-state.json')) {
              return '{"version":"0.1.2"}\n';
            }
            if (path.endsWith('server.env')) {
              return 'PORT=24851\nHAPPIER_SERVER_HOST=127.0.0.1\n';
            }
            return '';
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
        mode: 'user',
        channel: 'dev',
      });

      expect(status.service).toEqual({ enabled: true, active: true });
      expect(status.healthy).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      globalThis.fetch = originalFetch;
      vi.resetModules();
      vi.clearAllMocks();
    }
  });

  it('waits for the local relay health probe after starting the service', async () => {
    const originalPlatform = process.platform;
    const originalFetch = globalThis.fetch;
    const commands: string[] = [];
    const systemctlRuntimeDirs: string[] = [];
    const defaults = resolveRelayRuntimeDefaults({
      platform: 'linux',
      mode: 'user',
      channel: 'publicdev',
      homeDir: '/tmp/happy-home',
    });

    Object.defineProperty(process, 'platform', { value: 'linux' });

    try {
      const fetchCalls: string[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        fetchCalls.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: '0.1.2' }),
        } as Response;
      }) as unknown as typeof fetch;

      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => '/tmp/happy-home',
        };
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
            commands.push([cmd, ...(Array.isArray(args) ? args : [])].join(' '));
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('--user')) {
              systemctlRuntimeDirs.push(String(options?.env?.XDG_RUNTIME_DIR ?? ''));
              expect(options?.env?.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${options?.env?.XDG_RUNTIME_DIR}/bus`);
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      vi.doMock('node:net', async () => {
        const actual = await vi.importActual<typeof import('node:net')>('node:net');
        return {
          ...actual,
          createConnection: () => {
            const socket = new EventEmitter() as EventEmitter & {
              setTimeout: (timeoutMs: number) => void;
              destroy: () => void;
            };
            socket.setTimeout = (_timeoutMs: number) => undefined;
            socket.destroy = () => undefined;
            process.nextTick(() => socket.emit('connect'));
            return socket;
          },
        };
      });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          readFile: async (path: string) => path.endsWith('server.env')
            ? 'PORT=24851\nHAPPIER_SERVER_HOST=127.0.0.1\n'
            : '',
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');

      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      await expect(engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'dev',
        action: 'start',
      })).resolves.toBeUndefined();

      expect(commands.some((command) => command.includes(`systemctl --user start ${defaults.serviceName}.service`))).toBe(true);
      expect(systemctlRuntimeDirs).toContain(`/run/user/${typeof process.getuid === 'function' ? process.getuid() : ''}`);
      expect(fetchCalls).toContain('http://127.0.0.1:24851/health');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      globalThis.fetch = originalFetch;
      vi.resetModules();
      vi.clearAllMocks();
    }
  });

  it('rejects local restart when the relay never becomes healthy again', async () => {
    const originalPlatform = process.platform;
    const originalFetch = globalThis.fetch;

    Object.defineProperty(process, 'platform', { value: 'linux' });

    try {
      vi.useFakeTimers();
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      })) as unknown as typeof fetch;

      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => '/tmp/happy-home',
        };
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
        };
      });

      vi.doMock('node:net', async () => {
        const actual = await vi.importActual<typeof import('node:net')>('node:net');
        return {
          ...actual,
          createConnection: () => {
            const socket = new EventEmitter() as EventEmitter & {
              setTimeout: (timeoutMs: number) => void;
              destroy: () => void;
            };
            socket.setTimeout = (_timeoutMs: number) => undefined;
            socket.destroy = () => undefined;
            process.nextTick(() => socket.emit('connect'));
            return socket;
          },
        };
      });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          readFile: async (path: string) => path.endsWith('server.env')
            ? 'PORT=24851\nHAPPIER_SERVER_HOST=127.0.0.1\n'
            : '',
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');

      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      const controlPromise = engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'dev',
        action: 'restart',
      });
      const rejectionExpectation = expect(controlPromise).rejects.toThrow(/healthy/i);

      await vi.advanceTimersByTimeAsync(31_000);

      await rejectionExpectation;
    } finally {
      vi.useRealTimers();
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      globalThis.fetch = originalFetch;
      vi.resetModules();
      vi.clearAllMocks();
    }
  });
});
