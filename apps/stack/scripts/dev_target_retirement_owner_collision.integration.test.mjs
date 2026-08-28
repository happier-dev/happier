import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildRemoteStackStopCommand,
  resolveRemoteStackStatePaths,
} from './utils/dev_targets/remote_commands.mjs';
import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { writeStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import {
  isAlive,
  spawnOwnedSleep,
  waitForProcessAlive,
} from './testkit/stack_stop_sweeps_testkit.mjs';

test('Dev Target retirement fences a co-located controller with the same Stack identity', async (t) => {
  if (process.platform === 'win32') {
    t.skip('this regression exercises POSIX process-environment ownership');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-retirement-owner-collision-'));
  const stackName = 'repo-dev-a1cc5e0671';
  const repoDir = join(root, 'repo');
  const cliHomeDir = join(root, 'cli-home');
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir,
    cliHomeDir,
  };
  const remoteState = resolveRemoteStackStatePaths(target, { stackName });
  const remoteStackName = remoteState.stackName;
  const controllerBaseDir = join(cliHomeDir, 'stack-state', stackName);
  const controllerEnvPath = join(controllerBaseDir, 'env');
  let controller = null;

  t.after(async () => {
    if (controller?.pid && isAlive(controller.pid)) {
      try {
        process.kill(-controller.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(controller.pid, 'SIGKILL');
        } catch {
          // The process may already have exited during a failed assertion.
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  await Promise.all([
    mkdir(join(repoDir, 'apps', 'ui'), { recursive: true }),
    mkdir(join(repoDir, 'apps', 'cli'), { recursive: true }),
    mkdir(join(repoDir, 'apps', 'server'), { recursive: true }),
    mkdir(controllerBaseDir, { recursive: true }),
    mkdir(remoteState.stackBaseDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(repoDir, 'apps', 'ui', 'package.json'), '{}\n'),
    writeFile(join(repoDir, 'apps', 'cli', 'package.json'), '{}\n'),
    writeFile(join(repoDir, 'apps', 'server', 'package.json'), '{}\n'),
    writeFile(controllerEnvPath, [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
      `HAPPIER_STACK_REPO_DIR=${repoDir}`,
      '',
    ].join('\n')),
  ]);
  await writeFile(remoteState.stackEnvPath, [
    `HAPPIER_STACK_STACK=${remoteStackName}`,
    `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
    `HAPPIER_STACK_REPO_DIR=${repoDir}`,
    'HAPPIER_DEV_TARGET_EXECUTION=1',
    '',
  ].join('\n'));

  const retirementCommand = buildRemoteStackStopCommand(target, {
    services: { server: false, expo: false, daemon: true },
    serverUrl: 'http://127.0.0.1:43005',
    activeServerId: 'stack_repo-dev-a1cc5e0671__id_default',
    stackName,
  });
  assert.match(retirementCommand, /HAPPIER_DEV_TARGET_EXECUTION=1/);

  controller = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: controllerEnvPath,
      HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
      HAPPIER_TEST_LABEL: 'co-located-controller',
    },
  });
  await waitForProcessAlive({
    pid: controller.pid,
    label: 'co-located controller',
  });
  await writeStackRuntimeStateFile(join(controllerBaseDir, 'stack.runtime.json'), {
    version: 1,
    stackName,
    startedAt: '2026-08-27T18:15:44.000Z',
    ownerPid: controller.pid,
    processes: {},
  });

  const result = await stopStackWithEnv({
    rootDir: repoDir,
    stackName: remoteStackName,
    baseDir: remoteState.stackBaseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: remoteStackName,
      HAPPIER_STACK_ENV_FILE: remoteState.stackEnvPath,
      HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      HAPPIER_DEV_TARGET_EXECUTION: '1',
    },
    json: true,
    noDocker: true,
  });

  assert.deepEqual(
    {
      selectedOwnerPid: result.runner?.pid ?? null,
      signalledOwner: result.runner?.stopped === true,
    },
    {
      selectedOwnerPid: null,
      signalledOwner: false,
    },
  );
  assert.notEqual(remoteState.stackBaseDir, controllerBaseDir, 'retirement must use a target-specific runtime state path');
  assert.notEqual(remoteStackName, stackName, 'retirement must use a target-specific Stack identity');
  assert.match(retirementCommand, new RegExp(`stack stop .*${remoteStackName}.*--yes --no-docker`));
  assert.equal(isAlive(controller.pid), true, 'remote retirement must not signal the co-located controller');
});
