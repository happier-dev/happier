import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { resolveRelayRuntimeDefaults } from '../firstPartyRuntime/relayRuntime.js';

describe('RelayHostEngine (local health control)', () => {
  it('treats localized Windows scheduled-task status as active when the task is running', async () => {
    const originalPlatform = process.platform;
    const originalFetch = globalThis.fetch;

    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      })) as unknown as typeof fetch;

      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => 'C:\\Users\\tester',
        };
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'powershell.exe') {
              return {
                status: 0,
                stdout: '{"exists":true,"enabled":true,"active":false,"stateLabel":"En cours","stateValue":4}',
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

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          existsSync: (path: string) => path.includes('self-host-state.json') || path.endsWith('\\bin\\happier-server.exe') || path.endsWith('\\server.env'),
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
              return '{"version":"happier-server-v0.2.4-windows-x64"}\n';
            }
            if (path.endsWith('server.env')) {
              return 'PORT=3005\r\nHAPPIER_SERVER_HOST=127.0.0.1\r\n';
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
        installRemoteComponent: async () => ({ binaryPath: '%USERPROFILE%\\.happier\\self-host\\current\\happier-server.exe', versionId: 'publicdev-1' }),
      });

      const status = await engine.readStatus({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
      });

      expect(status.service).toEqual({ enabled: true, active: true });
      expect(status.healthy).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      globalThis.fetch = originalFetch;
      vi.resetModules();
      vi.clearAllMocks();
    }
  });

  it('falls back to English schtasks output when PowerShell parsing is unavailable on Windows', async () => {
    const originalPlatform = process.platform;
    const originalFetch = globalThis.fetch;
    const commands: string[] = [];

    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      })) as unknown as typeof fetch;

      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => 'C:\\Users\\tester',
        };
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            commands.push([cmd, ...(args ?? [])].join(' '));
            if (cmd === 'powershell.exe') {
              return {
                status: 1,
                stdout: '',
                stderr: 'powershell unavailable',
              };
            }
            if (cmd === 'schtasks') {
              return {
                status: 0,
                stdout: 'Status: Running\r\nScheduled Task State: Enabled\r\n',
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
          existsSync: (path: string) => path.includes('self-host-state.json') || path.endsWith('\\bin\\happier-server.exe') || path.endsWith('\\server.env'),
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
              return '{"version":"happier-server-v0.2.4-windows-x64"}\n';
            }
            if (path.endsWith('server.env')) {
              return 'PORT=3005\r\nHAPPIER_SERVER_HOST=127.0.0.1\r\n';
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
        installRemoteComponent: async () => ({ binaryPath: '%USERPROFILE%\\.happier\\self-host\\current\\happier-server.exe', versionId: 'publicdev-1' }),
      });

      const status = await engine.readStatus({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
      });

      expect(status.service).toEqual({ enabled: true, active: true });
      expect(status.healthy).toBe(true);
      expect(commands.some((command) => command.startsWith('schtasks '))).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      globalThis.fetch = originalFetch;
      vi.resetModules();
      vi.clearAllMocks();
    }
  });

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
                stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nLoadState=loaded\n',
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

  it('uses a long local relay health timeout during restart', async () => {
    const originalPlatform = process.platform;
    const originalFetch = globalThis.fetch;
    const commands: string[] = [];

    Object.defineProperty(process, 'platform', { value: 'linux' });

    try {
      vi.useFakeTimers();
      const healthStartMs = Date.now();
      globalThis.fetch = vi.fn(async () => {
        const ok = Date.now() - healthStartMs >= 35_000;
        return {
          ok,
          status: ok ? 200 : 503,
          json: async () => (ok ? ({ version: '0.1.2' }) : ({})),
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
          spawnSync: (cmd: string, args?: readonly string[]) => {
            commands.push([cmd, ...(Array.isArray(args) ? args : [])].join(' '));
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

      const controlPromise = engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'dev',
        action: 'restart',
      });

      await vi.advanceTimersByTimeAsync(36_000);
      await expect(controlPromise).resolves.toBeUndefined();

      expect(commands.some((command) => command.includes('systemctl --user restart'))).toBe(true);
    } finally {
      vi.useRealTimers();
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

      await vi.advanceTimersByTimeAsync(121_000);

      await rejectionExpectation;
    } finally {
      vi.useRealTimers();
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      globalThis.fetch = originalFetch;
      vi.resetModules();
      vi.clearAllMocks();
    }
  });

  it('translates local systemd user bus failures into an actionable error', async () => {
    const originalPlatform = process.platform;

    Object.defineProperty(process, 'platform', { value: 'linux' });

    try {
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
          spawnSync: () => ({
            status: 1,
            stdout: '',
            stderr: 'Failed to connect to bus: Connection refused',
          }),
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');

      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      const error = await engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'dev',
        action: 'start',
      }).then(() => null, (caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw error;
      }
      expect(error.message).toMatch(/Systemd user service is unavailable\./i);
      expect(error.message).toMatch(/use system mode\./i);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.resetModules();
      vi.clearAllMocks();
    }
  });
});
