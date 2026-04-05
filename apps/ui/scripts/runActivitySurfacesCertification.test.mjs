import test from 'node:test';
import assert from 'node:assert/strict';

import { runActivitySurfacesCertification } from './runActivitySurfacesCertification.mjs';

test('runActivitySurfacesCertification keeps the core certification scope limited to contract, narrowed typecheck, and focused vitest coverage', () => {
  const recordedCalls = [];

  runActivitySurfacesCertification({
    cwd: '/tmp/happier-ui',
    runVitestSuite({ cwd, env, spawnSyncImpl }) {
      spawnSyncImpl(process.execPath, ['vitest-suite-stub'], {
        cwd,
        env,
        stdio: 'inherit',
      });
    },
    spawnSyncImpl(command, args, options) {
      recordedCalls.push({ command, args, options });
      return {
        status: 0,
        error: undefined,
      };
    },
  });

  assert.deepEqual(
    recordedCalls.map(({ command, args, options }) => ({
      command,
      args,
      cwd: options.cwd,
    })),
    [
      {
        command: process.execPath,
        args: ['--test', './scripts/activitySurfacesValidationContract.test.mjs'],
        cwd: '/tmp/happier-ui',
      },
      {
        command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn',
        args: ['-s', 'typecheck:activity-surfaces'],
        cwd: '/tmp/happier-ui',
      },
      {
        command: process.execPath,
        args: ['vitest-suite-stub'],
        cwd: '/tmp/happier-ui',
      },
    ],
  );
});
