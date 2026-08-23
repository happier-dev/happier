import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildPublicSdkTarballValidationPlan,
  parsePublicSdkTarballValidationArgs,
  validatePublicSdkTarballs,
} from './validate-public-sdk-tarballs.mjs';

test('one post-pack phase sends each public probe the exact emitted archive paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-public-sdk-tarballs-'));
  const pluginSdkTarball = join(root, 'plugin-sdk.tgz');
  const pluginUiTarball = join(root, 'plugin-ui.tgz');
  const sdkTarball = join(root, 'sdk.tgz');
  const calls = [];
  try {
    await Promise.all([
      writeFile(pluginSdkTarball, 'plugin-sdk'),
      writeFile(pluginUiTarball, 'plugin-ui'),
      writeFile(sdkTarball, 'sdk'),
    ]);

    await validatePublicSdkTarballs({
      repoRoot: root,
      pluginSdkTarball,
      pluginUiTarball,
      sdkTarball,
      env: { NODE_AUTH_TOKEN: 'do-not-forward', PATH: '/usr/bin' },
      execFileSyncImpl: (command, args, options) => {
        calls.push({ command, args, options });
      },
    });

    assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
      {
        command: process.execPath,
        args: [
          join(root, 'packages/tests/pluginSdkConsumers/run-probes.mjs'),
          `--tarball=${pluginSdkTarball}`,
        ],
      },
      {
        command: process.execPath,
        args: [
          join(root, 'packages/plugin-ui/scripts/validateExternalAuthoringFixture.mjs'),
          '--sdk-tarball', pluginSdkTarball,
          '--plugin-ui-tarball', pluginUiTarball,
        ],
      },
      {
        command: process.execPath,
        args: [
          join(root, 'packages/sdk/scripts/validateNodeNextConsumer.mjs'),
          '--tarball', sdkTarball,
        ],
      },
    ]);
    assert.equal(calls[0].options.env.NODE_AUTH_TOKEN, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the post-pack phase rejects a half-specified plugin pair before probing', () => {
  assert.throws(
    () => parsePublicSdkTarballValidationArgs(['--plugin-sdk-tarball', '/candidate/plugin-sdk.tgz']),
    /must be supplied together/u,
  );
});

test('the post-pack phase supports the independently selectable pair and SDK targets', () => {
  const repoRoot = '/candidate';
  const pluginPairPlan = buildPublicSdkTarballValidationPlan({
    repoRoot,
    pluginSdkTarball: '/candidate/plugin-sdk.tgz',
    pluginUiTarball: '/candidate/plugin-ui.tgz',
  });
  assert.deepEqual(
    pluginPairPlan.map(({ label }) => label),
    [
      'Plugin SDK NodeNext and Vite consumers',
      'Plugin UI external-author, targeted, and Metro/RNW consumers',
    ],
  );

  const sdkPlan = buildPublicSdkTarballValidationPlan({
    repoRoot,
    sdkTarball: '/candidate/sdk.tgz',
  });
  assert.deepEqual(sdkPlan.map(({ label }) => label), ['SDK NodeNext consumer']);
});
