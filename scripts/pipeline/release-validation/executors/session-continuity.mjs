// @ts-check

import {
  resolveCoreE2eSlowSuiteExecution,
  runCoreE2eSlowSuiteValidation,
} from './core-e2e-slow-suite.mjs';

const SESSION_CONTINUITY_TEST_FILES = [
  'suites/core-e2e/session.continuity.fakeClaude.serverRestart.slow.e2e.test.ts',
];

/**
 * @param {{ repoRoot: string; source: { kind: string; ref: string } | null }} params
 */
export function resolveSessionContinuityExecution({ repoRoot, source }) {
  return resolveCoreE2eSlowSuiteExecution({
    repoRoot,
    source,
    suiteId: 'session-continuity',
    testFiles: SESSION_CONTINUITY_TEST_FILES,
  });
}

/**
 * @param {{ repoRoot: string; source: { kind: string; ref: string } | null; exec?: import('./core-e2e-slow-suite.mjs').ExecFileSyncLike }} params
 */
export function runSessionContinuityValidation({ repoRoot, source, exec }) {
  return runCoreE2eSlowSuiteValidation({
    repoRoot,
    source,
    suiteId: 'session-continuity',
    testFiles: SESSION_CONTINUITY_TEST_FILES,
    exec,
  });
}
