import { describe, expect, it, vi } from 'vitest';

describe('RelayHostEngine (Personal Home purpose)', () => {
  it('refuses erase without a Personal Home purpose and explicit confirmation', async () => {
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

    await expect(engine.control({
      target: { kind: 'local' },
      mode: 'user',
      channel: 'stable',
      action: 'erase',
    })).rejects.toThrow('Personal Home purpose is required');

    await expect(engine.control({
      target: { kind: 'local' },
      mode: 'user',
      channel: 'stable',
      purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
      action: 'erase',
    })).rejects.toThrow('Explicit confirmation is required');
  });

  it('reports canonical origin and persistent layout facts for a managed Personal Home', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return { ...actual, homedir: () => '/tmp/personal-home-engine-test' };
      });
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return { ...actual, existsSync: () => false };
      });
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: () => ({ status: 0, stdout: 'LoadState=not-found\n', stderr: '' }),
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

      const status = await engine.readStatus({
        target: { kind: 'local' },
        channel: 'stable',
        mode: 'user',
        purpose: {
          kind: 'personal-home',
          canonicalServerUrl: 'http://127.0.0.1:43123',
        },
      });

      expect(status.canonicalServerUrl).toBe('http://127.0.0.1:43123');
      expect(status.purpose).toEqual({
        kind: 'personal-home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
      });
      expect(status.layout?.dataDir).toContain('/.happier/self-host/data');
      expect(status.layout?.databasePath).toBe(`${status.layout?.dataDir}/happier-server-light.sqlite`);
      expect(status.dataPresent).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.resetModules();
      vi.clearAllMocks();
    }
  });
});
