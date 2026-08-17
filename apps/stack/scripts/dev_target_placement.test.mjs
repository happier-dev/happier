import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runNode } from './testkit/runtime_snapshot_testkit.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('hstack dev projects version 2 target placement without local service duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-placement-'));
  const stackName = 'repo-placement-test';
  const stackDir = join(root, stackName);
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), JSON.stringify({
    version: 2,
    targets: [{
      name: 'mac',
      platform: 'posix',
      ssh: 'mac-target',
      repoDir: '/Users/test/happier-dev',
      cliHomeDir: '/Users/test/.happier/dev-targets/mac',
    }],
    runtimePlacement: {
      server: { mode: 'local' },
      expo: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
      daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
  }, null, 2));
  try {
    const result = await runNode([
      join(packageRoot, 'scripts', 'dev.mjs'),
      '--json',
      '--mobile',
    ], {
      cwd: packageRoot,
      env: {
        ...process.env,
        HAPPIER_STACK_ENV_FILE: '',
        HAPPIER_STACK_REPO_DIR: '',
        HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
        HAPPIER_STACK_RUNTIME_MODE: 'source',
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_STORAGE_DIR: root,
      },
    });
    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.startServer, true);
    assert.equal(output.startDaemon, true);
    assert.deepEqual(
      output.servicePlans.local,
      { server: true, expo: false, daemon: true },
      JSON.stringify(output.servicePlans),
    );
    assert.deepEqual(output.servicePlans.targets[0].services, {
      server: false,
      expo: true,
      daemon: false,
    });
    assert.equal(output.servicePlans.targets[0].commands, true);
    assert.equal(output.executionPolicy.commands.target, 'mac');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hstack dev does not request an owned Expo service when the stack borrows Expo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-borrowed-expo-'));
  const stackName = 'borrowed-expo-consumer';
  const stackDir = join(root, stackName);
  const envPath = join(stackDir, 'env');
  await mkdir(stackDir, { recursive: true });
  await writeFile(envPath, [
    `HAPPIER_STACK_STACK=${stackName}`,
    `HAPPIER_STACK_STORAGE_DIR=${root}`,
    'HAPPIER_STACK_RUNTIME_MODE=source',
    'HAPPIER_STACK_EXPO_SOURCE_STACK=repo-producer',
    '',
  ].join('\n'));
  try {
    const result = await runNode([
      join(packageRoot, 'scripts', 'dev.mjs'),
      '--json',
      '--mobile',
    ], {
      cwd: packageRoot,
      env: {
        ...process.env,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_REPO_DIR: packageRoot,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_STORAGE_DIR: root,
      },
    });
    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.startMobile, true);
    assert.equal(output.startOwnedExpo, false);
    assert.equal(output.expoOwnership, 'borrowed');
    assert.equal(output.servicePlans.local.expo, false);
    assert.equal(output.servicePlans.targets.some((plan) => plan.services.expo), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
