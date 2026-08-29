import { describe, expect, it, vi } from 'vitest';

describe('RelayHostEngine (local uninstall cleanup)', () => {
  it('preserves Personal Home data while removing only runtime-owned files', async () => {
    const originalPlatform = process.platform;
    const originalGetuid = (process as unknown as { getuid?: (() => number) | undefined }).getuid;

    Object.defineProperty(process, 'platform', { value: 'linux' });
    (process as unknown as { getuid?: (() => number) | undefined }).getuid = () => 501;

    const rmCalls: Array<{ path: string; recursive?: boolean; force?: boolean }> = [];
    const installRoot = '/tmp/happy-home/.happier/self-host';
    const dataDir = `${installRoot}/data`;
    const configDir = `${installRoot}/config`;
    const logDir = `${installRoot}/logs`;

    try {
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return { ...actual, homedir: () => '/tmp/happy-home' };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return { ...actual, spawnSync: () => ({ status: 0, stdout: '', stderr: '' }) };
      });
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return { ...actual, existsSync: (path: string) => path === installRoot };
      });
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
            rmCalls.push({ path, recursive: options?.recursive, force: options?.force });
          },
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({
          binaryPath: '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'stable-1',
        }),
      });

      await engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'stable',
        purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
        action: 'uninstall',
      });

      expect(rmCalls.some((call) => call.path === dataDir)).toBe(false);
      expect(rmCalls.some((call) => call.path === configDir)).toBe(false);
      expect(rmCalls.some((call) => call.path === installRoot && call.recursive === true)).toBe(false);
      expect(rmCalls.some((call) => call.path === logDir && call.recursive === true)).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalGetuid) (process as unknown as { getuid?: (() => number) | undefined }).getuid = originalGetuid;
      else delete (process as unknown as { getuid?: (() => number) | undefined }).getuid;
      vi.resetModules();
      vi.clearAllMocks();
    }
  });

  it('does not recursively remove the install root after safe runtime cleanup', async () => {
    const originalPlatform = process.platform;
    const originalGetuid = (process as unknown as { getuid?: (() => number) | undefined }).getuid;

    Object.defineProperty(process, 'platform', { value: 'darwin' });
    (process as unknown as { getuid?: (() => number) | undefined }).getuid = () => 501;

    const rmCalls: Array<{ path: string; recursive?: boolean; force?: boolean }> = [];
    const installRoot = '/tmp/happy-home/.happier/self-host-dev';

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
          spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
        };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          existsSync: (path: string) => path === installRoot,
        };
      });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
            rmCalls.push({ path, recursive: options?.recursive, force: options?.force });
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

      await engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'dev',
        action: 'uninstall',
      });

      const installRootDeletes = rmCalls.filter((call) => call.path === installRoot && call.recursive === true);
      expect(installRootDeletes).toEqual([]);
      expect(rmCalls.some((call) => call.path === `${installRoot}/logs` && call.recursive === true)).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalGetuid) (process as unknown as { getuid?: (() => number) | undefined }).getuid = originalGetuid;
      else delete (process as unknown as { getuid?: (() => number) | undefined }).getuid;
      vi.resetModules();
      vi.clearAllMocks();
    }
  });

  it('removes the self-host state file explicitly during uninstall', async () => {
    const originalPlatform = process.platform;
    const originalGetuid = (process as unknown as { getuid?: (() => number) | undefined }).getuid;

    Object.defineProperty(process, 'platform', { value: 'darwin' });
    (process as unknown as { getuid?: (() => number) | undefined }).getuid = () => 501;

    const rmCalls: Array<{ path: string; recursive?: boolean; force?: boolean }> = [];
    const installRoot = '/tmp/happy-home/.happier/self-host-dev';
    const statePath = `${installRoot}/self-host-state.json`;

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
          spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
        };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          existsSync: () => false,
        };
      });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
            rmCalls.push({ path, recursive: options?.recursive, force: options?.force });
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

      await engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'dev',
        action: 'uninstall',
      });

      expect(rmCalls.some((call) => call.path === statePath && call.force === true)).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalGetuid) (process as unknown as { getuid?: (() => number) | undefined }).getuid = originalGetuid;
      else delete (process as unknown as { getuid?: (() => number) | undefined }).getuid;
      vi.resetModules();
      vi.clearAllMocks();
    }
  });

  it('uninstalls the legacy unsuffixed scheduled task when the preview lane still owns that install root', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    const invoked: string[] = [];
    const installRoot = 'C:\\Users\\tester\\.happier\\self-host-preview';

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
            invoked.push([cmd, ...(Array.isArray(args) ? args : [])].join(' '));
            if (cmd === 'powershell.exe') {
              const script = String(args?.at(-1) ?? '');
              if (script.includes('$taskName = "happier-server-preview"')) {
                return { status: 0, stdout: '{"exists":false}', stderr: '' };
              }
              if (script.includes('$taskName = "happier-server"')) {
                return { status: 0, stdout: '{"exists":true,"enabled":true,"active":true}', stderr: '' };
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
          existsSync: (path: string) => path.endsWith('happier-server.ps1'),
        };
      });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          readFile: async (path: string) => {
            if (path.endsWith('happier-server.ps1')) {
              return `$ErrorActionPreference = "Stop"\nSet-Location -LiteralPath "${installRoot}"\n`;
            }
            return '';
          },
          rm: async () => undefined,
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({
          binaryPath: '%USERPROFILE%\\.happier\\self-host\\current\\happier-server.exe',
          versionId: 'preview-1',
        }),
      });

      await engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        action: 'uninstall',
      });

      expect(invoked.some((cmd) =>
        cmd.includes('powershell.exe')
        && cmd.includes('Stop-ScheduledTask')
        && cmd.includes('$taskName = "happier-server"'),
      ), invoked.join('\n')).toBe(true);
      expect(invoked.some((cmd) =>
        cmd.includes('powershell.exe')
        && cmd.includes('Unregister-ScheduledTask')
        && cmd.includes('$taskName = "happier-server"'),
      )).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.resetModules();
      vi.clearAllMocks();
    }
  }, 60_000);
});
