// @ts-check

import {
  resolveCoreE2eSlowSuiteExecution,
  runCoreE2eSlowSuiteValidation,
} from './core-e2e-slow-suite.mjs';

const DAEMON_CONTINUITY_TEST_FILES = [
  'suites/core-e2e/daemon.continuity.fakeClaude.reattach.slow.e2e.test.ts',
];

/**
 * @param {{ repoRoot: string; source: { kind: string; ref: string } | null }} params
 */
export function resolveDaemonContinuityExecution({ repoRoot, source }) {
  return resolveCoreE2eSlowSuiteExecution({
    repoRoot,
    source,
    suiteId: 'daemon-continuity',
    testFiles: DAEMON_CONTINUITY_TEST_FILES,
  });
}

/**
 * @param {{ repoRoot: string; source: { kind: string; ref: string } | null; exec?: import('./core-e2e-slow-suite.mjs').ExecFileSyncLike }} params
 */
export function runDaemonContinuityValidation({ repoRoot, source, exec }) {
  return runCoreE2eSlowSuiteValidation({
    repoRoot,
    source,
    suiteId: 'daemon-continuity',
    testFiles: DAEMON_CONTINUITY_TEST_FILES,
    exec,
  });
}
