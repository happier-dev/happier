import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runActivitySurfacesVitestSuite } from './runActivitySurfacesVitestSuite.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptsDir = dirname(scriptPath);
const packageRoot = dirname(scriptsDir);

export const ACTIVITY_SURFACES_VALIDATION_NODE_TEST_FILES = [
  './scripts/activitySurfacesValidationContract.test.mjs',
  './scripts/runActivitySurfacesCertification.test.mjs',
  './scripts/runActivitySurfacesNativeCertification.test.mjs',
  './scripts/runActivitySurfacesReleaseReadiness.test.mjs',
  './scripts/qa/tauriActivitySurfacesMcpQa.test.mjs',
  './scripts/validateExpoWidgetsNativeSync.test.mjs',
  './scripts/validateExpoWidgetsGeneratedProject.test.mjs',
  './scripts/validateExpoWidgetsSimulatorBuildSmoke.test.mjs',
];

export const ACTIVITY_SURFACES_ROLLOUT_LOCAL_INCLUDED_CHECKS = [
  'validation_contract_tests',
  'typecheck:activity-surfaces',
  'test:activity-surfaces',
];

export const ACTIVITY_SURFACES_ROLLOUT_LOCAL_EXCLUDED_CHECKS = [
  'test:native-e2e:activity-surfaces',
  'validate:ios:widgets:native-sync',
  'validate:ios:widgets:generated-project',
  'validate:ios:widgets:simulator-build-smoke',
  'cargo_check',
  'cargo_test_activity_overlay',
  'apps/ui typecheck',
  'live_manual_qa',
];

export function formatActivitySurfacesManualQaScopeNote(report) {
  return report.excludedChecks.includes('live_manual_qa') ? 'manual_qa=excluded' : 'manual_qa=included';
}

function runStep(command, args, { cwd = packageRoot, env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl(command, args, {
    cwd,
    env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: ${[command, ...args].join(' ')}`);
  }
}

export function runActivitySurfacesCertification({
  cwd = packageRoot,
  env = process.env,
  spawnSyncImpl = spawnSync,
  runVitestSuite = runActivitySurfacesVitestSuite,
} = {}) {
  runStep(process.execPath, ['--test', ...ACTIVITY_SURFACES_VALIDATION_NODE_TEST_FILES], {
    cwd,
    env,
    spawnSyncImpl,
  });
  runStep(process.platform === 'win32' ? 'yarn.cmd' : 'yarn', ['-s', 'typecheck:activity-surfaces'], {
    cwd,
    env,
    spawnSyncImpl,
  });
  runVitestSuite({
    cwd,
    env,
    spawnSyncImpl,
  });

  return {
    lane: 'rollout_local',
    includedChecks: [...ACTIVITY_SURFACES_ROLLOUT_LOCAL_INCLUDED_CHECKS],
    excludedChecks: [...ACTIVITY_SURFACES_ROLLOUT_LOCAL_EXCLUDED_CHECKS],
  };
}

function runCli() {
  try {
    const report = runActivitySurfacesCertification();
    console.log(
      [
        'Activity-surfaces rollout-local certification passed.',
        formatActivitySurfacesManualQaScopeNote(report),
        `included=${report.includedChecks.join(',')}`,
        `excluded=${report.excludedChecks.join(',')}`,
      ].join(' '),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] === scriptPath) {
  runCli();
}
