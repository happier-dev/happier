import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIVITY_SURFACES_ROLLOUT_LOCAL_EXCLUDED_CHECKS,
  formatActivitySurfacesManualQaScopeNote,
  runActivitySurfacesCertification,
} from './runActivitySurfacesCertification.mjs';

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

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runActivitySurfacesNativeCertification({
  cwd = packageRoot,
  env = process.env,
  spawnSyncImpl = spawnSync,
  runRolloutCertification = runActivitySurfacesCertification,
  pathExistsImpl = pathExists,
  log = console.log,
} = {}) {
  runRolloutCertification({
    cwd,
    env,
    spawnSyncImpl,
  });

  const yarnCommand = process.platform === 'win32' ? 'yarn.cmd' : 'yarn';

  runStep(yarnCommand, ['-s', 'validate:ios:widgets:native-sync'], {
    cwd,
    env,
    spawnSyncImpl,
  });

  if (await pathExistsImpl(join(cwd, 'ios'))) {
    runStep(yarnCommand, ['-s', 'validate:ios:widgets:generated-project'], {
      cwd,
      env,
      spawnSyncImpl,
    });
    runStep(yarnCommand, ['-s', 'validate:ios:widgets:simulator-build-smoke'], {
      cwd,
      env,
      spawnSyncImpl,
    });
  } else {
    log(
      "Skipping native-only generated iOS widget project and simulator build-smoke validation because 'ios/' is not present. Default certify:activity-surfaces intentionally excludes simulator smoke. Run 'expo prebuild -p ios --no-install' first if you need generated-project or simulator smoke coverage.",
    );
  }

  runStep('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml'], {
    cwd,
    env,
    spawnSyncImpl,
  });
  runStep('cargo', ['test', 'activity_overlay', '--lib', '--manifest-path', 'src-tauri/Cargo.toml'], {
    cwd,
    env,
    spawnSyncImpl,
  });
  runStep(yarnCommand, ['-s', 'test:native-e2e:activity-surfaces'], {
    cwd,
    env,
    spawnSyncImpl,
  });

  const includedChecks = [
    'certify:activity-surfaces',
    'validate:ios:widgets:native-sync',
  ];
  const skippedChecks = [];

  if (await pathExistsImpl(join(cwd, 'ios'))) {
    includedChecks.push(
      'validate:ios:widgets:generated-project',
      'validate:ios:widgets:simulator-build-smoke',
    );
  } else {
    skippedChecks.push(
      'validate:ios:widgets:generated-project',
      'validate:ios:widgets:simulator-build-smoke',
    );
  }

  includedChecks.push(
    'cargo_check',
    'cargo_test_activity_overlay',
    'test:native-e2e:activity-surfaces',
  );

  return {
    lane: 'native_tightening',
    includedChecks,
    excludedChecks: ACTIVITY_SURFACES_ROLLOUT_LOCAL_EXCLUDED_CHECKS.filter((entry) =>
      ![
        'validate:ios:widgets:native-sync',
        'validate:ios:widgets:generated-project',
        'validate:ios:widgets:simulator-build-smoke',
        'cargo_check',
        'cargo_test_activity_overlay',
        'test:native-e2e:activity-surfaces',
      ].includes(entry),
    ),
    skippedChecks,
  };
}

async function runCli() {
    try {
        const report = await runActivitySurfacesNativeCertification();
        console.log(
            [
                'Activity-surfaces native-tightening certification passed.',
                formatActivitySurfacesManualQaScopeNote(report),
                `included=${report.includedChecks.join(',')}`,
                `excluded=${report.excludedChecks.join(',')}`,
                `skipped=${report.skippedChecks.join(',') || 'none'}`,
            ].join(' '),
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

if (process.argv[1] === scriptPath) {
    await runCli();
}
