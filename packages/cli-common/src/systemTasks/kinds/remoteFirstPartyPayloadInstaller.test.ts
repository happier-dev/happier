import { describe, expect, it } from 'vitest';

import { installRemoteFirstPartyComponent } from './remoteFirstPartyPayloadInstaller.js';

describe('installRemoteFirstPartyComponent', () => {
  it('uses a $HOME-based remote home dir and executes the installer directly (not via bash)', async () => {
    const remoteTextCommands: string[] = [];
    const copiedRemotePaths: string[] = [];

    await installRemoteFirstPartyComponent(
      {
        componentId: 'happier-cli',
        channel: 'preview',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async ({ remoteCommand }) => {
          remoteTextCommands.push(remoteCommand);
          return { status: 0, stdout: '', stderr: '' };
        },
        copyLocalDirectoryToRemote: async ({ remotePath }) => {
          copiedRemotePaths.push(remotePath);
        },
        preparePayload: async () => ({
          componentId: 'happier-cli',
          channel: 'preview',
          versionId: 'preview-1',
          payloadRoot: '/tmp/payload-root',
          source: 'https://example.test/payload.tar.gz',
          cleanup: async () => undefined,
        }),
        now: () => 123,
      },
    );

    expect(copiedRemotePaths).toEqual([
      '$HOME/.happier/bootstrap-staging/happier-cli-preview-1-123',
    ]);
    expect(remoteTextCommands.some((command) => command.includes('mkdir -p $HOME/.happier'))).toBe(true);
    expect(remoteTextCommands.some((command) => command.includes('HAPPIER_HOME_DIR=$HOME/.happier'))).toBe(true);
    expect(remoteTextCommands.some((command) => command.includes('chmod +x $HOME/.happier'))).toBe(true);
    expect(remoteTextCommands.some((command) => command.includes(' self __install-payload'))).toBe(true);
    expect(remoteTextCommands.some((command) => command.includes('bash $HOME/.happier'))).toBe(false);
    expect(remoteTextCommands.some((command) => command.includes('pipefail'))).toBe(false);
  });

  it('rejects remoteHomeDir values that are unsafe to embed in shell commands', async () => {
    await expect(
      installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
          remoteHomeDir: '$HOME/.happier; rm -rf /',
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
          copyLocalDirectoryToRemote: async () => undefined,
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'preview-1',
            payloadRoot: '/tmp/payload-root',
            source: 'https://example.test/payload.tar.gz',
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      ),
    ).rejects.toThrow(/remote home dir/i);
  });
});
