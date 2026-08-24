import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import {
  resolveSdkDualOriginExecution,
  runSdkDualOriginValidation,
  SDK_DUAL_ORIGIN_VALIDATION_TIMEOUT_MS,
} from '../pipeline/release-validation/executors/sdk-dual-origin.mjs';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const testsWorkspaceRoot = resolve(repoRoot, 'packages', 'tests');
const vitestRunner = resolve(testsWorkspaceRoot, 'scripts', 'run-vitest-with-heartbeat.mjs');
const vitestConfig = resolve(testsWorkspaceRoot, 'vitest.core.slow.config.ts');
const candidateTarball = resolve('/tmp', 'happier-dev-sdk-candidate.tgz');

test('sdk-dual-origin plans only the existing packed SDK dual-origin fixture for an exact local tarball', () => {
  const execution = resolveSdkDualOriginExecution({
    repoRoot,
    source: { kind: 'local-pack', ref: candidateTarball },
  });

  assert.deepEqual(execution, {
    type: 'command',
    command: process.execPath,
    args: [
      vitestRunner,
      '--config',
      vitestConfig,
      resolve(testsWorkspaceRoot, 'suites', 'core-e2e', 'externalActions.dualOrigin.packedSdk.slow.e2e.test.ts'),
    ],
    cwd: testsWorkspaceRoot,
    env: {
      HAPPIER_RELEASE_VALIDATION_SDK_TARBALL: candidateTarball,
    },
  });
});

test('sdk-dual-origin rejects anything other than an absolute exact local-pack tarball', () => {
  assert.throws(
    () => resolveSdkDualOriginExecution({
      repoRoot,
      source: { kind: 'local-build', ref: 'HEAD' },
    }),
    /local-pack/i,
  );
  assert.throws(
    () => resolveSdkDualOriginExecution({
      repoRoot,
      source: { kind: 'local-pack', ref: 'dist/sdk.tgz' },
    }),
    /absolute/i,
  );
});

test('sdk-dual-origin execution forwards the exact candidate tarball to the existing fixture', () => {
  /** @type {Array<{ command: string; args: string[]; options?: unknown }>} */
  const calls = [];

  runSdkDualOriginValidation({
    repoRoot,
    source: { kind: 'local-pack', ref: candidateTarball },
    exec: (command, args, options) => {
      calls.push({ command, args, options });
      return '';
    },
  });

  assert.deepEqual(calls, [{
    command: process.execPath,
    args: [
      vitestRunner,
      '--config',
      vitestConfig,
      resolve(testsWorkspaceRoot, 'suites', 'core-e2e', 'externalActions.dualOrigin.packedSdk.slow.e2e.test.ts'),
    ],
    options: {
      cwd: testsWorkspaceRoot,
      env: {
        ...process.env,
        HAPPIER_RELEASE_VALIDATION_SDK_TARBALL: candidateTarball,
      },
      stdio: 'inherit',
      timeout: SDK_DUAL_ORIGIN_VALIDATION_TIMEOUT_MS,
    },
  }]);
});

test('sdk-dual-origin execution accepts the candidate validator sanitized environment', () => {
  /** @type {Array<{ command: string; args: string[]; options?: unknown }>} */
  const calls = [];

  runSdkDualOriginValidation({
    repoRoot,
    source: { kind: 'local-pack', ref: candidateTarball },
    env: { PATH: '/safe/bin' },
    exec: (command, args, options) => {
      calls.push({ command, args, options });
      return '';
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, {
    cwd: testsWorkspaceRoot,
    env: {
      PATH: '/safe/bin',
      HAPPIER_RELEASE_VALIDATION_SDK_TARBALL: candidateTarball,
    },
    stdio: 'inherit',
    timeout: SDK_DUAL_ORIGIN_VALIDATION_TIMEOUT_MS,
  });
});
