// @ts-check

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * @typedef {{ kind: string; ref: string }} ReleaseValidationSource
 * @typedef {(command: string, args: string[], options?: import('node:child_process').ExecFileSyncOptions) => unknown} ExecFileSyncLike
 */

/**
 * @param {{
 *   repoRoot: string;
 *   testFiles: readonly string[];
 * }} params
 */
export function resolveCoreE2eSlowSuiteCommand({ repoRoot, testFiles }) {
  const testsWorkspaceRoot = resolve(repoRoot, 'packages', 'tests');
  return {
    type: 'command',
    command: process.execPath,
    args: [
      resolve(testsWorkspaceRoot, 'scripts', 'run-vitest-with-heartbeat.mjs'),
      '--config',
      resolve(testsWorkspaceRoot, 'vitest.core.slow.config.ts'),
      ...testFiles.map((testFile) => resolve(testsWorkspaceRoot, testFile)),
    ],
    cwd: testsWorkspaceRoot,
  };
}

/**
 * @param {{
 *   repoRoot: string;
 *   source: ReleaseValidationSource | null;
 *   testFiles: readonly string[];
 *   suiteId: string;
 * }} params
 */
export function resolveCoreE2eSlowSuiteExecution({ repoRoot, source, testFiles, suiteId }) {
  if (!source || source.kind !== 'local-build') {
    throw new Error(`${suiteId} currently supports only --source local-build`);
  }

  return resolveCoreE2eSlowSuiteCommand({ repoRoot, testFiles });
}

/**
 * @param {{
 *   repoRoot: string;
 *   source: ReleaseValidationSource | null;
 *   testFiles: readonly string[];
 *   suiteId: string;
 *   exec?: ExecFileSyncLike;
 * }} params
 */
export function runCoreE2eSlowSuiteValidation({ repoRoot, source, testFiles, suiteId, exec = execFileSync }) {
  const execution = resolveCoreE2eSlowSuiteExecution({ repoRoot, source, testFiles, suiteId });
  exec(execution.command, execution.args, {
    cwd: execution.cwd,
    stdio: 'inherit',
  });
}
