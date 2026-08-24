// @ts-check

import { isAbsolute, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveCoreE2eSlowSuiteCommand } from './core-e2e-slow-suite.mjs';

const SDK_DUAL_ORIGIN_TEST_FILES = [
  'suites/core-e2e/externalActions.dualOrigin.packedSdk.slow.e2e.test.ts',
];

// This matches the exact candidate fixture's per-test upper bound: five
// session flows at 630s plus 300s non-session headroom.
export const SDK_DUAL_ORIGIN_VALIDATION_TIMEOUT_MS = 3_450_000;

/**
 * @typedef {{ kind: string; ref: string }} ReleaseValidationSource
 * @typedef {(command: string, args: string[], options?: import('node:child_process').ExecFileSyncOptions) => unknown} ExecFileSyncLike
 */

/**
 * @param {ReleaseValidationSource | null} source
 * @returns {string}
 */
function requireSdkCandidateTarball(source) {
  if (!source || source.kind !== 'local-pack') {
    throw new Error('sdk-dual-origin requires --source local-pack with the exact SDK candidate tarball');
  }
  const tarballPath = String(source.ref ?? '').trim();
  if (!isAbsolute(tarballPath)) {
    throw new Error('sdk-dual-origin requires an absolute SDK candidate tarball path');
  }
  if (!tarballPath.endsWith('.tgz')) {
    throw new Error('sdk-dual-origin requires an SDK candidate .tgz tarball');
  }
  return resolve(tarballPath);
}

/**
 * @param {{ repoRoot: string; source: ReleaseValidationSource | null }} params
 */
export function resolveSdkDualOriginExecution({ repoRoot, source }) {
  const tarballPath = requireSdkCandidateTarball(source);
  return {
    ...resolveCoreE2eSlowSuiteCommand({
      repoRoot,
      testFiles: SDK_DUAL_ORIGIN_TEST_FILES,
    }),
    env: {
      HAPPIER_RELEASE_VALIDATION_SDK_TARBALL: tarballPath,
    },
  };
}

/**
 * @param {{
 *   repoRoot: string;
 *   source: ReleaseValidationSource | null;
 *   env?: NodeJS.ProcessEnv;
 *   exec?: ExecFileSyncLike;
 * }} params
 */
export function runSdkDualOriginValidation({
  repoRoot,
  source,
  env = process.env,
  exec = execFileSync,
}) {
  const execution = resolveSdkDualOriginExecution({ repoRoot, source });
  exec(execution.command, execution.args, {
    cwd: execution.cwd,
    env: {
      ...env,
      ...execution.env,
    },
    stdio: 'inherit',
    timeout: SDK_DUAL_ORIGIN_VALIDATION_TIMEOUT_MS,
  });
}
