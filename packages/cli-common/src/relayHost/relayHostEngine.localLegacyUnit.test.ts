import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

describe('RelayHostEngine (local legacy service name compatibility)', () => {
  it('falls back to the legacy unsuffixed systemd unit when the channel-suffixed unit is missing', async () => {
    const originalPlatform = process.platform;
    const originalFetch = globalThis.fetch;

    Object.defineProperty(process, 'platform', { value: 'linux' });

    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ version: '0.2.1' }),
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
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              const unit = String(args.find((value) => value.endsWith('.service')) ?? '');
              if (unit === 'happier-server-preview.service') {
                return {
                  status: 0,
                  stdout: 'LoadState=not-found\nUnitFileState=\nActiveState=inactive\nSubState=dead\n',
                  stderr: '',
                };
              }
              if (unit === 'happier-server.service') {
                return {
                  status: 0,
                  stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n',
                  stderr: '',
                };
              }
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          existsSync: (path: string) =>
            path.includes('self-host-state.json')
            || path.endsWith('/bin/happier-server')
            || path.endsWith('/server.env')
            || path.endsWith('/happier-server.service'),
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
              return '{"version":"0.2.1"}\n';
            }
            if (path.endsWith('happier-server.service')) {
              return '[Service]\nWorkingDirectory=/tmp/happy-home/.happier/self-host-preview\n';
            }
            if (path.endsWith('server.env')) {
              return 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n';
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
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'preview-1' }),
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
  }, 60_000);

  it('controls the legacy unsuffixed systemd unit when the channel-suffixed unit is missing', async () => {
    const originalPlatform = process.platform;
    const originalFetch = globalThis.fetch;

    Object.defineProperty(process, 'platform', { value: 'linux' });

    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ version: '0.2.1' }),
      })) as unknown as typeof fetch;

      const invoked: string[] = [];
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
            invoked.push([cmd, ...(Array.isArray(args) ? args : [])].join(' '));
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              const unit = String(args.find((value) => value.endsWith('.service')) ?? '');
              if (unit === 'happier-server-preview.service') {
                return {
                  status: 0,
                  stdout: 'LoadState=not-found\nUnitFileState=\nActiveState=inactive\nSubState=dead\n',
                  stderr: '',
                };
              }
              if (unit === 'happier-server.service') {
                return {
                  status: 0,
                  stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n',
                  stderr: '',
                };
              }
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          existsSync: (path: string) =>
            path.includes('self-host-state.json')
            || path.endsWith('/bin/happier-server')
            || path.endsWith('/server.env')
            || path.endsWith('/happier-server.service'),
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
            if (path.endsWith('server.env')) {
              return 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n';
            }
            if (path.endsWith('happier-server.service')) {
              return '[Service]\nWorkingDirectory=/tmp/happy-home/.happier/self-host-preview\n';
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
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'preview-1' }),
      });

      await expect(engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        action: 'start',
      })).resolves.toBeUndefined();

      expect(invoked.some((cmd) => cmd.includes('systemctl --user start happier-server.service'))).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      globalThis.fetch = originalFetch;
      vi.resetModules();
      vi.clearAllMocks();
    }
  }, 60_000);

  it('falls back to the legacy unsuffixed launchd label when the channel-suffixed label is missing', async () => {
    const originalPlatform = process.platform;
    const originalFetch = globalThis.fetch;

    Object.defineProperty(process, 'platform', { value: 'darwin' });

    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ version: '0.2.1' }),
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
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'launchctl' && Array.isArray(args) && args[0] === 'list') {
              const label = String(args[1] ?? '');
              if (label === 'happier-server-preview') {
                return { status: 1, stdout: '', stderr: '' };
              }
              if (label === 'happier-server') {
                return { status: 0, stdout: '', stderr: '' };
              }
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          existsSync: (path: string) =>
            path.endsWith('/server.env')
            || path.endsWith('/Library/LaunchAgents/happier-server.plist'),
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
            if (path.endsWith('happier-server.plist')) {
              return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>happier-server</string>
    <key>WorkingDirectory</key>
    <string>/tmp/happy-home/.happier/self-host-preview</string>
  </dict>
</plist>
`;
            }
            if (path.endsWith('server.env')) {
              return 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n';
            }
            return '';
          },
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');

      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'darwin', arch: 'arm64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'preview-1' }),
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
  }, 60_000);

  it('controls the legacy unsuffixed launchd label when the channel-suffixed label is missing', async () => {
    const originalPlatform = process.platform;
    const originalFetch = globalThis.fetch;

    Object.defineProperty(process, 'platform', { value: 'darwin' });

    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ version: '0.2.1' }),
      })) as unknown as typeof fetch;

      const invoked: string[] = [];
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
            invoked.push([cmd, ...(Array.isArray(args) ? args : [])].join(' '));
            if (cmd === 'launchctl' && Array.isArray(args) && args[0] === 'list') {
              const label = String(args[1] ?? '');
              if (label === 'happier-server-preview') {
                return { status: 1, stdout: '', stderr: '' };
              }
              if (label === 'happier-server') {
                return { status: 0, stdout: '', stderr: '' };
              }
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          existsSync: (path: string) =>
            path.endsWith('/server.env')
            || path.endsWith('/Library/LaunchAgents/happier-server.plist'),
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
            if (path.endsWith('server.env')) {
              return 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n';
            }
            if (path.endsWith('happier-server.plist')) {
              return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>happier-server</string>
    <key>WorkingDirectory</key>
    <string>/tmp/happy-home/.happier/self-host-preview</string>
  </dict>
</plist>
`;
            }
            return '';
          },
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');

      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'darwin', arch: 'arm64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'preview-1' }),
      });

      await expect(engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        action: 'start',
      })).resolves.toBeUndefined();

      expect(invoked.some((cmd) => cmd.includes('launchctl bootstrap gui/') && cmd.includes('happier-server.plist'))).toBe(true);
      expect(invoked.some((cmd) => cmd.includes('gui/') && cmd.includes('/happier-server'))).toBe(true);
      expect(
        invoked.some(
          (cmd) =>
            (cmd.includes('launchctl bootstrap') || cmd.includes('launchctl kickstart'))
            && cmd.includes('happier-server-preview'),
        ),
      ).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      globalThis.fetch = originalFetch;
      vi.resetModules();
      vi.clearAllMocks();
    }
  }, 60_000);

  it('falls back to the legacy unsuffixed scheduled task when the channel-suffixed task is missing', async () => {
    const originalPlatform = process.platform;

    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
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
            if (cmd === 'schtasks' && Array.isArray(args) && args[0] === '/Query') {
              const taskName = String(args[args.indexOf('/TN') + 1] ?? '');
              if (taskName === 'Happier\\happier-server-preview') {
                return { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.\r\n' };
              }
              if (taskName === 'Happier\\happier-server') {
                return { status: 0, stdout: 'Status: Ready\r\nScheduled Task State: Enabled\r\n', stderr: '' };
              }
            }
            if (cmd === 'powershell.exe' && Array.isArray(args) && args.includes('-Command')) {
              const commandText = String(args[args.indexOf('-Command') + 1] ?? '');
              const taskNameMatch = commandText.match(/\$taskName = "([^"]+)"/u);
              const taskName = taskNameMatch?.[1] ?? '';
              if (taskName === 'happier-server-preview') {
                return {
                  status: 0,
                  stdout: '{"exists":false,"enabled":false,"active":false,"stateLabel":"not_installed"}\n',
                  stderr: '',
                };
              }
              if (taskName === 'happier-server') {
                return {
                  status: 0,
                  stdout: '{"exists":true,"enabled":true,"active":false,"stateLabel":"Ready"}\n',
                  stderr: '',
                };
              }
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          existsSync: (path: string) =>
            path.endsWith('\\server.env')
            || path.endsWith('\\.happier\\services\\happier-server.ps1'),
        };
      });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          readFile: async (path: string) => {
            if (path.endsWith('happier-server.ps1')) {
              return '$ErrorActionPreference = "Stop"\nSet-Location -LiteralPath "C:\\Users\\tester\\.happier\\self-host-preview"\n';
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
        installRemoteComponent: async () => ({ binaryPath: '%USERPROFILE%\\.happier\\self-host\\current\\happier-server.exe', versionId: 'preview-1' }),
      });

      const status = await engine.readStatus({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
      });

      expect(status.service).toEqual({ enabled: true, active: false });
      expect(status.healthy).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.resetModules();
      vi.clearAllMocks();
    }
  }, 60_000);

  it('controls the legacy unsuffixed scheduled task when the channel-suffixed task is missing', async () => {
    const originalPlatform = process.platform;
    const originalFetch = globalThis.fetch;

    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ version: '0.2.1' }),
      })) as unknown as typeof fetch;

      const invoked: string[] = [];
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
            invoked.push([cmd, ...(Array.isArray(args) ? args : [])].join(' '));
            if (cmd === 'schtasks' && Array.isArray(args) && args[0] === '/Query') {
              const taskName = String(args[args.indexOf('/TN') + 1] ?? '');
              if (taskName === 'Happier\\happier-server-preview') {
                return { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.\r\n' };
              }
              if (taskName === 'Happier\\happier-server') {
                return { status: 0, stdout: 'Status: Running\r\nScheduled Task State: Enabled\r\n', stderr: '' };
              }
            }
            if (cmd === 'powershell.exe' && Array.isArray(args) && args.includes('-Command')) {
              const commandText = String(args[args.indexOf('-Command') + 1] ?? '');
              const taskNameMatch = commandText.match(/\$taskName = "([^"]+)"/u);
              const taskName = taskNameMatch?.[1] ?? '';
              if (taskName === 'happier-server-preview') {
                return {
                  status: 0,
                  stdout: '{"exists":false,"enabled":false,"active":false,"stateLabel":"not_installed"}\n',
                  stderr: '',
                };
              }
              if (taskName === 'happier-server') {
                return {
                  status: 0,
                  stdout: '{"exists":true,"enabled":true,"active":true,"stateLabel":"Running"}\n',
                  stderr: '',
                };
              }
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          existsSync: (path: string) =>
            path.endsWith('\\server.env')
            || path.endsWith('\\.happier\\services\\happier-server.ps1'),
        };
      });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          readFile: async (path: string) => {
            if (path.endsWith('server.env')) {
              return 'PORT=3005\r\nHAPPIER_SERVER_HOST=127.0.0.1\r\n';
            }
            if (path.endsWith('happier-server.ps1')) {
              return '$ErrorActionPreference = "Stop"\nSet-Location -LiteralPath "C:\\Users\\tester\\.happier\\self-host-preview"\n';
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
        installRemoteComponent: async () => ({ binaryPath: '%USERPROFILE%\\.happier\\self-host\\current\\happier-server.exe', versionId: 'preview-1' }),
      });

      await expect(engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        action: 'restart',
      })).resolves.toBeUndefined();

      expect(invoked.some((cmd) => cmd.includes('schtasks /Run /TN Happier\\happier-server'))).toBe(true);
      expect(invoked.some((cmd) => cmd.includes('schtasks /Run /TN Happier\\happier-server-preview'))).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      globalThis.fetch = originalFetch;
      vi.resetModules();
      vi.clearAllMocks();
    }
  }, 60_000);
});
