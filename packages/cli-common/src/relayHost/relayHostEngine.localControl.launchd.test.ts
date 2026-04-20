import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

async function mockLaunchdLocalControlModules(params: Readonly<{
  calls: Array<{ cmd: string; args: readonly string[] }>;
  spawnSync?: (cmd: string, args: readonly string[]) => Readonly<{ status: number; stdout: string; stderr: string }>;
}>): Promise<void> {
  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
      ...actual,
      spawnSync: (cmd: string, args?: readonly string[]) => {
        const normalizedArgs = Array.isArray(args) ? args : [];
        params.calls.push({ cmd, args: normalizedArgs });
        return params.spawnSync?.(cmd, normalizedArgs) ?? { status: 0, stdout: '', stderr: '' };
      },
    };
  });

  vi.doMock('../firstPartyRuntime/relayRuntime.js', async () => {
    const actual = await vi.importActual<typeof import('../firstPartyRuntime/relayRuntime.js')>('../firstPartyRuntime/relayRuntime.js');
    return {
      ...actual,
      checkRelayRuntimeHealth: async ({ host, port, path }: Readonly<{ host: string; port: number; path: string }>) => ({
        reachable: true,
        portOpen: true,
        pingOk: true,
        url: `http://${host}:${port}${path}`,
        statusCode: 200,
        version: 'test-version',
      }),
    };
  });
}

describe('RelayHostEngine (local launchd control)', () => {
  it('bootstraps the launchd service when starting the local relay runtime', async () => {
    const originalPlatform = process.platform;
    const originalGetuid = (process as unknown as { getuid?: (() => number) | undefined }).getuid;

    Object.defineProperty(process, 'platform', { value: 'darwin' });
    (process as unknown as { getuid?: (() => number) | undefined }).getuid = () => 501;

    const calls: Array<{ cmd: string; args: readonly string[] }> = [];

    try {
      await mockLaunchdLocalControlModules({ calls });

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
        channel: 'stable',
        action: 'start',
      });

      const launchctlCalls = calls.filter((call) => call.cmd === 'launchctl').map((call) => call.args.join(' '));
      expect(launchctlCalls).toContain(`bootstrap gui/501 ${join(homedir(), 'Library', 'LaunchAgents', 'happier-server.plist')}`);
      expect(launchctlCalls).toContain('enable gui/501/happier-server');
      expect(launchctlCalls).toContain('kickstart -k gui/501/happier-server');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalGetuid) (process as unknown as { getuid?: (() => number) | undefined }).getuid = originalGetuid;
      else delete (process as unknown as { getuid?: (() => number) | undefined }).getuid;
      vi.doUnmock('node:child_process');
      vi.doUnmock('../firstPartyRuntime/relayRuntime.js');
      vi.resetModules();
      vi.clearAllMocks();
    }
  });

  it('bootstraps the launchd service when restarting the local relay runtime', async () => {
    const originalPlatform = process.platform;
    const originalGetuid = (process as unknown as { getuid?: (() => number) | undefined }).getuid;

    Object.defineProperty(process, 'platform', { value: 'darwin' });
    (process as unknown as { getuid?: (() => number) | undefined }).getuid = () => 501;

    const calls: Array<{ cmd: string; args: readonly string[] }> = [];

    try {
      await mockLaunchdLocalControlModules({ calls });

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
        channel: 'stable',
        action: 'restart',
      });

      const launchctlCalls = calls.filter((call) => call.cmd === 'launchctl').map((call) => call.args.join(' '));
      expect(launchctlCalls).toContain('kickstart -k gui/501/happier-server');
      expect(launchctlCalls).not.toContain(`bootstrap gui/501 ${join(homedir(), 'Library', 'LaunchAgents', 'happier-server.plist')}`);
      expect(launchctlCalls).not.toContain(`load -w ${join(homedir(), 'Library', 'LaunchAgents', 'happier-server.plist')}`);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalGetuid) (process as unknown as { getuid?: (() => number) | undefined }).getuid = originalGetuid;
      else delete (process as unknown as { getuid?: (() => number) | undefined }).getuid;
      vi.doUnmock('node:child_process');
      vi.doUnmock('../firstPartyRuntime/relayRuntime.js');
      vi.resetModules();
      vi.clearAllMocks();
    }
  });

  it('falls back to bootstrapping launchd when restart kickstart fails', async () => {
    const originalPlatform = process.platform;
    const originalGetuid = (process as unknown as { getuid?: (() => number) | undefined }).getuid;

    Object.defineProperty(process, 'platform', { value: 'darwin' });
    (process as unknown as { getuid?: (() => number) | undefined }).getuid = () => 501;

    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    let kickstartFailedOnce = false;

    try {
      await mockLaunchdLocalControlModules({
        calls,
        spawnSync: (cmd, normalizedArgs) => {
          if (cmd === 'launchctl' && normalizedArgs.join(' ') === 'kickstart -k gui/501/happier-server' && !kickstartFailedOnce) {
            kickstartFailedOnce = true;
            return { status: 5, stdout: '', stderr: 'kickstart failed' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
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
        channel: 'stable',
        action: 'restart',
      });

      const launchctlCalls = calls.filter((call) => call.cmd === 'launchctl').map((call) => call.args.join(' '));
      expect(launchctlCalls).toContain(`bootstrap gui/501 ${join(homedir(), 'Library', 'LaunchAgents', 'happier-server.plist')}`);
      expect(launchctlCalls).toContain('enable gui/501/happier-server');
      expect(launchctlCalls).toContain('kickstart -k gui/501/happier-server');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalGetuid) (process as unknown as { getuid?: (() => number) | undefined }).getuid = originalGetuid;
      else delete (process as unknown as { getuid?: (() => number) | undefined }).getuid;
      vi.doUnmock('node:child_process');
      vi.doUnmock('../firstPartyRuntime/relayRuntime.js');
      vi.resetModules();
      vi.clearAllMocks();
    }
  });

  it('bootstraps the system launchd service when starting the relay runtime in system mode', async () => {
    const originalPlatform = process.platform;
    const originalGetuid = (process as unknown as { getuid?: (() => number) | undefined }).getuid;

    Object.defineProperty(process, 'platform', { value: 'darwin' });
    (process as unknown as { getuid?: (() => number) | undefined }).getuid = () => 0;

    const calls: Array<{ cmd: string; args: readonly string[] }> = [];

    try {
      await mockLaunchdLocalControlModules({ calls });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');

      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      await engine.control({
        target: { kind: 'local' },
        mode: 'system',
        channel: 'stable',
        action: 'start',
      });

      const launchctlCalls = calls.filter((call) => call.cmd === 'launchctl').map((call) => call.args.join(' '));
      expect(launchctlCalls).toContain('bootstrap system /Library/LaunchDaemons/happier-server.plist');
      expect(launchctlCalls).toContain('enable system/happier-server');
      expect(launchctlCalls).toContain('kickstart -k system/happier-server');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalGetuid) (process as unknown as { getuid?: (() => number) | undefined }).getuid = originalGetuid;
      else delete (process as unknown as { getuid?: (() => number) | undefined }).getuid;
      vi.doUnmock('node:child_process');
      vi.doUnmock('../firstPartyRuntime/relayRuntime.js');
      vi.resetModules();
      vi.clearAllMocks();
    }
  });

  it('bootstraps the system launchd service when restarting the relay runtime in system mode', async () => {
    const originalPlatform = process.platform;
    const originalGetuid = (process as unknown as { getuid?: (() => number) | undefined }).getuid;

    Object.defineProperty(process, 'platform', { value: 'darwin' });
    (process as unknown as { getuid?: (() => number) | undefined }).getuid = () => 0;

    const calls: Array<{ cmd: string; args: readonly string[] }> = [];

    try {
      await mockLaunchdLocalControlModules({ calls });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');

      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
      });

      await engine.control({
        target: { kind: 'local' },
        mode: 'system',
        channel: 'stable',
        action: 'restart',
      });

      const launchctlCalls = calls.filter((call) => call.cmd === 'launchctl').map((call) => call.args.join(' '));
      expect(launchctlCalls).toContain('kickstart -k system/happier-server');
      expect(launchctlCalls).not.toContain('bootstrap system /Library/LaunchDaemons/happier-server.plist');
      expect(launchctlCalls).not.toContain('load -w /Library/LaunchDaemons/happier-server.plist');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalGetuid) (process as unknown as { getuid?: (() => number) | undefined }).getuid = originalGetuid;
      else delete (process as unknown as { getuid?: (() => number) | undefined }).getuid;
      vi.doUnmock('node:child_process');
      vi.doUnmock('../firstPartyRuntime/relayRuntime.js');
      vi.resetModules();
      vi.clearAllMocks();
    }
  });

  it('falls back to system bootstrapping when restart kickstart fails in system mode', async () => {
    const originalPlatform = process.platform;
    const originalGetuid = (process as unknown as { getuid?: (() => number) | undefined }).getuid;

    Object.defineProperty(process, 'platform', { value: 'darwin' });
    (process as unknown as { getuid?: (() => number) | undefined }).getuid = () => 0;

    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    let kickstartFailedOnce = false;

    try {
      await mockLaunchdLocalControlModules({
        calls,
        spawnSync: (cmd, normalizedArgs) => {
          if (cmd === 'launchctl' && normalizedArgs.join(' ') === 'kickstart -k system/happier-server' && !kickstartFailedOnce) {
            kickstartFailedOnce = true;
            return { status: 5, stdout: '', stderr: 'kickstart failed' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
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
        mode: 'system',
        channel: 'stable',
        action: 'restart',
      });

      const launchctlCalls = calls.filter((call) => call.cmd === 'launchctl').map((call) => call.args.join(' '));
      expect(launchctlCalls).toContain('bootstrap system /Library/LaunchDaemons/happier-server.plist');
      expect(launchctlCalls).toContain('enable system/happier-server');
      expect(launchctlCalls).toContain('kickstart -k system/happier-server');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalGetuid) (process as unknown as { getuid?: (() => number) | undefined }).getuid = originalGetuid;
      else delete (process as unknown as { getuid?: (() => number) | undefined }).getuid;
      vi.doUnmock('node:child_process');
      vi.doUnmock('../firstPartyRuntime/relayRuntime.js');
      vi.resetModules();
      vi.clearAllMocks();
    }
  });
});
