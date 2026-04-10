import { describe, expect, it } from 'vitest';

describe('RelayHostEngine (remote launchd control)', () => {
  it('uses the remote uid when restarting a user launchd relay over ssh', async () => {
    const remoteCommands: string[] = [];
    const { createRelayHostEngine } = await import('./relayHostEngine.js');

    const engine = createRelayHostEngine({
      resolveRemoteReleaseTarget: async () => ({ os: 'darwin', arch: 'arm64' }),
      runRemoteText: async ({ remoteCommand }) => {
        remoteCommands.push(remoteCommand);
        if (remoteCommand.includes('server.env')) {
          return { status: 0, stdout: 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', stderr: '' };
        }
        if (remoteCommand.includes('if [ -f ')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({
        binaryPath: '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    await expect(engine.control({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      mode: 'user',
      channel: 'preview',
      action: 'restart',
    })).resolves.toBeUndefined();

    expect(remoteCommands[0]).toContain('launchctl kickstart -k');
    expect(remoteCommands[0]).toContain('gui/$(id -u)/happier-server-preview');
    expect(remoteCommands[0]).not.toContain(`gui/${typeof process.getuid === 'function' ? process.getuid() : 0}/happier-server-preview`);
  });
});
