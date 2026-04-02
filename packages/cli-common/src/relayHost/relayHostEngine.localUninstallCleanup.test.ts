import { describe, expect, it, vi } from 'vitest';

describe('RelayHostEngine (local uninstall cleanup)', () => {
  it('retries removing the install root when the first removal fails', async () => {
    const originalPlatform = process.platform;
    const originalGetuid = (process as unknown as { getuid?: (() => number) | undefined }).getuid;

    Object.defineProperty(process, 'platform', { value: 'darwin' });
    (process as unknown as { getuid?: (() => number) | undefined }).getuid = () => 501;

    const rmCalls: Array<{ path: string; recursive?: boolean; force?: boolean }> = [];
    const installRoot = '/tmp/happy-home/.happier/self-host-dev';
    let installRootRmAttempts = 0;

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
          existsSync: (path: string) => {
            if (path === installRoot) {
              return installRootRmAttempts < 2;
            }
            return false;
          },
        };
      });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
            rmCalls.push({ path, recursive: options?.recursive, force: options?.force });
            if (path === installRoot) {
              installRootRmAttempts += 1;
              if (installRootRmAttempts === 1) {
                throw new Error('rm failed');
              }
            }
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

      const installRootDeletes = rmCalls.filter((call) => call.path === installRoot);
      expect(installRootDeletes.length).toBeGreaterThanOrEqual(2);
      expect(installRootDeletes.every((call) => call.force === true && call.recursive === true)).toBe(true);
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
});
