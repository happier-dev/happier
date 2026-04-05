import test from 'node:test';
import assert from 'node:assert/strict';

import { runActivitySurfacesNativeCertification } from './runActivitySurfacesNativeCertification.mjs';

test('runActivitySurfacesNativeCertification runs the rollout certification, iOS validation, simulator smoke, and desktop native checks in order', async () => {
  const recordedCalls = [];

  await runActivitySurfacesNativeCertification({
    cwd: '/tmp/happier-ui',
    runRolloutCertification({ cwd, env, spawnSyncImpl }) {
      spawnSyncImpl(process.platform === 'win32' ? 'yarn.cmd' : 'yarn', ['-s', 'certify:activity-surfaces'], {
        cwd,
        env,
        stdio: 'inherit',
      });
    },
    pathExistsImpl: async (path) => path === '/tmp/happier-ui/ios',
    spawnSyncImpl(command, args, options) {
      recordedCalls.push({ command, args, options });
      return {
        status: 0,
        error: undefined,
      };
    },
    log() {},
  });

  assert.deepEqual(
    recordedCalls.map(({ command, args, options }) => ({
      command,
      args,
      cwd: options.cwd,
    })),
    [
      {
        command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn',
        args: ['-s', 'certify:activity-surfaces'],
        cwd: '/tmp/happier-ui',
      },
      {
        command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn',
        args: ['-s', 'validate:ios:widgets:native-sync'],
        cwd: '/tmp/happier-ui',
      },
      {
        command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn',
        args: ['-s', 'validate:ios:widgets:generated-project'],
        cwd: '/tmp/happier-ui',
      },
      {
        command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn',
        args: ['-s', 'validate:ios:widgets:simulator-build-smoke'],
        cwd: '/tmp/happier-ui',
      },
      {
        command: 'cargo',
        args: ['check', '--manifest-path', 'src-tauri/Cargo.toml'],
        cwd: '/tmp/happier-ui',
      },
      {
        command: 'cargo',
        args: ['test', 'activity_overlay', '--lib', '--manifest-path', 'src-tauri/Cargo.toml'],
        cwd: '/tmp/happier-ui',
      },
    ],
  );
});

test('runActivitySurfacesNativeCertification skips generated-project and simulator-smoke validation when ios is absent', async () => {
  const recordedCalls = [];
  const recordedLogs = [];

  await runActivitySurfacesNativeCertification({
    cwd: '/tmp/happier-ui',
    runRolloutCertification({ cwd, env, spawnSyncImpl }) {
      spawnSyncImpl(process.platform === 'win32' ? 'yarn.cmd' : 'yarn', ['-s', 'certify:activity-surfaces'], {
        cwd,
        env,
        stdio: 'inherit',
      });
    },
    pathExistsImpl: async () => false,
    spawnSyncImpl(command, args, options) {
      recordedCalls.push({ command, args, options });
      return {
        status: 0,
        error: undefined,
      };
    },
    log(message) {
      recordedLogs.push(message);
    },
  });

  assert.equal(
    recordedCalls.some(
      ({ command, args }) =>
        command === (process.platform === 'win32' ? 'yarn.cmd' : 'yarn') &&
        args[0] === '-s' &&
        ['validate:ios:widgets:generated-project', 'validate:ios:widgets:simulator-build-smoke'].includes(args[1]),
    ),
    false,
  );
  assert.deepEqual(recordedLogs, [
    "Skipping native-only generated iOS widget project and simulator build-smoke validation because 'ios/' is not present. Default certify:activity-surfaces intentionally excludes simulator smoke. Run 'expo prebuild -p ios --no-install' first if you need generated-project or simulator smoke coverage.",
  ]);
});
