import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runActivitySurfacesVitestSuite } from './runActivitySurfacesVitestSuite.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptsDir = dirname(scriptPath);
const packageRoot = dirname(scriptsDir);

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
  runStep(process.execPath, ['--test', './scripts/activitySurfacesValidationContract.test.mjs'], {
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
}

function runCli() {
  try {
    runActivitySurfacesCertification();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] === scriptPath) {
  runCli();
}
