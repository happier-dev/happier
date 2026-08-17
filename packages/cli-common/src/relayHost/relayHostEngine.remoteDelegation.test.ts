import { describe, expect, it } from 'vitest';

import { createRelayHostEngine } from './relayHostEngine.js';

describe('RelayHostEngine remote installation ownership', () => {
  it('delegates installation to the canonical remote CLI installer', async () => {
    const installedComponents: string[] = [];
    const commands: string[] = [];
    const engine = createRelayHostEngine({
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => {
        installedComponents.push(componentId);
        return {
          binaryPath: '$HOME/.happier/cli-dev/current/happier',
          versionId: 'cli-dev-1',
        };
      },
      runRemoteText: async ({ remoteCommand }) => {
        commands.push(remoteCommand);
        if (remoteCommand.includes('relay host install')) {
          return {
            status: 0,
            stdout: `${JSON.stringify({
              ok: true,
              kind: 'relay_host_install',
              data: { relayUrl: 'http://127.0.0.1:3005', mode: 'user' },
            })}\n`,
            stderr: '',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    await expect(engine.installOrUpdate({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
      env: { PORT: '3005' },
    })).resolves.toEqual({ relayUrl: 'http://127.0.0.1:3005', mode: 'user' });

    expect(installedComponents).toEqual(['happier-cli']);
    expect(commands.some((command) => command.includes('relay host install'))).toBe(true);
    expect(commands.some((command) => command.includes('--env') && command.includes('PORT=3005'))).toBe(true);
    expect(commands.some((command) => command.includes('self-host-state.json'))).toBe(false);
    expect(commands.some((command) => command.includes('systemctl'))).toBe(false);
  });

  it('forwards an explicit local server payload through the canonical remote installer', async () => {
    const installations: Array<{ componentId: string; localBinaryPath?: string }> = [];
    let installCommand = '';
    const engine = createRelayHostEngine({
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId, localBinaryPath }) => {
        installations.push({ componentId, ...(localBinaryPath ? { localBinaryPath } : {}) });
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/cli-preview/current/happier'
            : '/home/remote/.happier/happier-server/preview/current/bin/happier-server',
          versionId: 'preview-1',
        };
      },
      runRemoteText: async ({ remoteCommand }) => {
        installCommand = remoteCommand;
        return {
          status: 0,
          stdout: `${JSON.stringify({
            ok: true,
            kind: 'relay_host_install',
            data: { relayUrl: 'http://127.0.0.1:3005', mode: 'system' },
          })}\n`,
          stderr: '',
        };
      },
    });

    await engine.installOrUpdate({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'preview',
      mode: 'system',
      selfHostRelayBinaryOverride: '/tmp/local/happier-server',
    });

    expect(installations).toEqual([
      { componentId: 'happier-cli' },
      { componentId: 'happier-server', localBinaryPath: '/tmp/local/happier-server' },
    ]);
    expect(installCommand).toContain('--server-binary');
    expect(installCommand).toContain('/home/remote/.happier/happier-server/preview/current/bin/happier-server');
    expect(installCommand).toContain('--mode system');
  });

  it('surfaces the canonical remote installer error instead of interpreting partial output', async () => {
    const engine = createRelayHostEngine({
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({
        binaryPath: '$HOME/.happier/cli/current/happier',
        versionId: 'stable-1',
      }),
      runRemoteText: async () => ({
        status: 1,
        stdout: `${JSON.stringify({
          ok: false,
          kind: 'relay_host',
          error: { message: 'predecessor recovery could not be verified' },
        })}\n`,
        stderr: 'remote command failed',
      }),
    });

    await expect(engine.installOrUpdate({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'stable',
      mode: 'user',
    })).rejects.toThrow('predecessor recovery could not be verified');
  });
});
