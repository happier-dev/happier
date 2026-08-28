import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildPublicSdkPublicationTarballValidationPlan,
  validatePublicSdkPublicationTarballs,
} from './validate-public-sdk-publication-tarballs.mjs';

test('the publication gate clean-installs and executes each selected exported archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-public-sdk-publication-'));
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

    await validatePublicSdkPublicationTarballs({
      repoRoot: root,
      pluginSdkTarball,
      pluginUiTarball,
      sdkTarball,
      env: { PATH: '/usr/bin', NODE_AUTH_TOKEN: 'must-not-cross-the-boundary' },
      execFileSyncImpl(command, args, options) {
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
    assert.equal(calls.every(({ options }) => options.env.NODE_AUTH_TOKEN === undefined), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the publication gate requires the Plugin SDK pair and exact regular archives', async () => {
  assert.throws(
    () => buildPublicSdkPublicationTarballValidationPlan({
      repoRoot: '/repo',
      pluginSdkTarball: '/candidate/plugin-sdk.tgz',
    }),
    /requires both pair archives/u,
  );

  const root = await mkdtemp(join(tmpdir(), 'happier-public-sdk-publication-missing-'));
  try {
    await assert.rejects(
      validatePublicSdkPublicationTarballs({
        repoRoot: root,
        sdkTarball: join(root, 'missing.tgz'),
        execFileSyncImpl() {},
      }),
      /does not exist/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
