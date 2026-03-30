import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installRemoteFirstPartyComponent,
  resolveRemoteInstalledFirstPartyBinaryPath,
} from './install_remote_first_party_component.mjs';

test('installRemoteFirstPartyComponent uploads a verified payload and promotes it with self __install-payload', async () => {
  const remoteCommands = [];
  const scpCopies = [];

  const result = await installRemoteFirstPartyComponent(
    {
      componentId: 'hstack',
      channel: 'preview',
      target: 'dev@example.test',
    },
    {
      now: () => 1700000000000,
      runRemoteJson: async () => ({ platform: 'linux', arch: 'x64' }),
      preparePayload: async () => ({
        componentId: 'hstack',
        channel: 'preview',
        versionId: '1.2.3',
        payloadRoot: '/tmp/local/hstack-linux-x64',
        source: 'https://example.test/hstack.tgz',
        cleanup: async () => undefined,
      }),
      runRemoteText: async ({ command }) => {
        remoteCommands.push(command);
      },
      runScp: async ({ localPath, remoteTarget }) => {
        scpCopies.push({ localPath, remoteTarget });
      },
    },
  );

  assert.deepEqual(scpCopies, [
    {
      localPath: '/tmp/local/hstack-linux-x64',
      remoteTarget: 'dev@example.test:$HOME/.happier/bootstrap-staging/hstack-1.2.3-1700000000000',
    },
  ]);
  assert.ok(!remoteCommands.join('\n').includes('curl -fsSL https://happier.dev/install'));
  assert.match(remoteCommands.at(-1) ?? '', /self __install-payload/);
  assert.match(remoteCommands.at(-1) ?? '', /--component 'hstack'/);
  assert.deepEqual(result, {
    binaryPath: '$HOME/.happier/stack-preview/current/hstack',
    versionId: '1.2.3',
    source: 'https://example.test/hstack.tgz',
  });
});

test('resolveRemoteInstalledFirstPartyBinaryPath uses the verified install root for publicdev channels', () => {
  assert.equal(
    resolveRemoteInstalledFirstPartyBinaryPath({
      componentId: 'hstack',
      channel: 'publicdev',
    }),
    '$HOME/.happier/stack-dev/current/hstack',
  );
});
