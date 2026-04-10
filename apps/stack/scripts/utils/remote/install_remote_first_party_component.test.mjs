import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installRemoteFirstPartyComponent,
  resolveRemoteInstalledFirstPartyBinaryPath,
} from './install_remote_first_party_component.mjs';

test('installRemoteFirstPartyComponent uploads a verified payload and promotes it with self __install-payload', async () => {
  const remoteCommands = [];
  const scpCopies = [];
  const payloadRootParent = await mkdtemp(join(tmpdir(), 'remote-first-party-payload-'));
  const payloadRoot = join(payloadRootParent, 'hstack-linux-x64');
  await mkdir(payloadRoot, { recursive: true });
  await writeFile(join(payloadRoot, 'hstack'), '#!/bin/sh\nexit 0\n', 'utf8');

  try {
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
          payloadRoot,
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

    assert.equal(scpCopies.length, 1);
    assert.match(scpCopies[0]?.localPath ?? '', /hstack-linux-x64\.tar$/);
    assert.match(
      scpCopies[0]?.remoteTarget ?? '',
      /^dev@example\.test:(\$HOME\/)?\.?happier\/bootstrap-staging\/hstack-1\.2\.3-1700000000000\/hstack-linux-x64\.tar$/,
    );
    assert.ok(!remoteCommands.join('\n').includes('curl -fsSL https://happier.dev/install'));
    assert.match(remoteCommands.at(-1) ?? '', /tar -xf/);
    assert.doesNotMatch(remoteCommands.at(-1) ?? '', /self __install-payload/);
    assert.deepEqual(result, {
      binaryPath: '$HOME/.happier/stack-preview/current/hstack',
      versionId: '1.2.3',
      source: 'https://example.test/hstack.tgz',
    });
  } finally {
    await rm(payloadRootParent, { recursive: true, force: true });
  }
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
