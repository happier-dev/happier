import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildPublicSdkTarballValidationPlan,
  parsePublicSdkTarballValidationArgs,
  resolvePublicSdkTarballValidationTimeoutMs,
  validatePublicSdkTarballs,
} from './validate-public-sdk-tarballs.mjs';
import { SDK_DUAL_ORIGIN_VALIDATION_TIMEOUT_MS } from '../release-validation/executors/sdk-dual-origin.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const testsWorkspaceRoot = resolve(repoRoot, 'packages', 'tests');
const candidateFixture = resolve(
  testsWorkspaceRoot,
  'suites',
  'core-e2e',
  'externalActions.dualOrigin.packedSdk.slow.e2e.test.ts',
);

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
      {
        command: process.execPath,
        args: [
          join(root, 'packages/tests/scripts/run-vitest-with-heartbeat.mjs'),
          '--config',
          join(root, 'packages/tests/vitest.core.slow.config.ts'),
          join(root, 'packages/tests/suites/core-e2e/externalActions.dualOrigin.packedSdk.slow.e2e.test.ts'),
        ],
      },
    ]);
    assert.equal(calls[0].options.env.NODE_AUTH_TOKEN, undefined);
    assert.equal(calls[3].options.env.HAPPIER_RELEASE_VALIDATION_SDK_TARBALL, sdkTarball);
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
  const candidateRoot = '/candidate';
  const pluginPairPlan = buildPublicSdkTarballValidationPlan({
    repoRoot: candidateRoot,
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
    repoRoot: candidateRoot,
    sdkTarball: '/candidate/sdk.tgz',
  });
  assert.deepEqual(sdkPlan.map(({ label }) => label), ['SDK NodeNext consumer']);
});

test('SDK candidate validation runs the exact tarball through the existing dual-origin fixture', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'happier-sdk-candidate-validation-'));
  const sdkTarball = join(temporaryRoot, 'happier-dev-sdk-candidate.tgz');
  await writeFile(sdkTarball, 'fixture', 'utf8');
  /** @type {Array<{ command: string; args: string[]; options: import('node:child_process').ExecFileSyncOptions }>} */
  const calls = [];

  try {
    await validatePublicSdkTarballs({
      repoRoot,
      sdkTarball,
      env: { PATH: process.env.PATH ?? '' },
      execFileSyncImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return '';
      },
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, [
      resolve(repoRoot, 'packages', 'sdk', 'scripts', 'validateNodeNextConsumer.mjs'),
      '--tarball',
      sdkTarball,
    ]);
    assert.deepEqual(calls[1].args, [
      resolve(testsWorkspaceRoot, 'scripts', 'run-vitest-with-heartbeat.mjs'),
      '--config',
      resolve(testsWorkspaceRoot, 'vitest.core.slow.config.ts'),
      candidateFixture,
    ]);
    assert.equal(calls[1].options.cwd, testsWorkspaceRoot);
    assert.equal(
      calls[1].options.env?.HAPPIER_RELEASE_VALIDATION_SDK_TARBALL,
      sdkTarball,
    );
    assert.equal(calls[1].options.timeout, SDK_DUAL_ORIGIN_VALIDATION_TIMEOUT_MS);
    assert.equal(
      resolvePublicSdkTarballValidationTimeoutMs({ repoRoot, sdkTarball }),
      (10 * 60_000) + SDK_DUAL_ORIGIN_VALIDATION_TIMEOUT_MS,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
