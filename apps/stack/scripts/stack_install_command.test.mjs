import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStackInstallPlan } from './stack/stack_install_command.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const stackScript = join(scriptsDir, 'stack.mjs');

test('hstack stack install dry-run plans runtime, service, and desktop installation', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-install-plan-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const res = spawnSync(
    process.execPath,
    [
      stackScript,
      'install',
      'local-prod',
      '--repo=/repo/happier',
      '--port=4305',
      '--dry-run',
      '--json',
      '--desktop-platform=darwin',
    ],
    {
      cwd: dirname(scriptsDir),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: join(tmp, 'stacks'),
      },
    },
  );

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^\s*\{/, res.stdout);
  const payload = JSON.parse(res.stdout);

  assert.equal(payload.ok, true);
  assert.equal(payload.stackName, 'local-prod');
  assert.equal(payload.dryRun, true);
  assert.deepEqual(
    payload.steps.map((step) => step.id),
    ['create-stack', 'build-runtime', 'set-runtime-mode', 'build-desktop', 'install-service', 'restart-service', 'install-desktop'],
  );
  assert.equal(payload.desktop.productName, 'Happier (local-prod)');
  assert.equal(payload.desktop.identifier, 'com.happier.stack.local-prod');
  assert.equal(payload.desktop.serverUrl, 'http://127.0.0.1:4305');
});

test('buildStackInstallPlan skips desktop steps when disabled on non-macOS platforms', async () => {
  const plan = await buildStackInstallPlan({
    rootDir: '/repo/apps/stack',
    stackName: 'linux-prod',
    argv: ['--port=4310', '--no-desktop'],
    platform: 'linux',
    stackExists: () => false,
  });

  assert.equal(plan.desktopMode, 'none');
  assert.equal(plan.desktop, null);
  assert.deepEqual(
    plan.steps.map((step) => step.id),
    ['create-stack', 'build-runtime', 'set-runtime-mode', 'install-service', 'restart-service'],
  );
});

test('hstack stack install dry-run plans repo updates for existing stacks', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-install-existing-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const storageDir = join(tmp, 'stacks');
  const stackName = 'existing-prod';
  const stackDir = join(storageDir, stackName);
  await mkdir(stackDir, { recursive: true });
  await writeFile(
    join(stackDir, 'env'),
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      'HAPPIER_STACK_SERVER_PORT=4309',
      'HAPPIER_STACK_REPO_DIR=/old/repo',
    ].join('\n'),
    'utf-8',
  );

  const res = spawnSync(
    process.execPath,
    [
      stackScript,
      'install',
      stackName,
      '--repo=/next/repo',
      '--dry-run',
      '--json',
      '--no-desktop',
    ],
    {
      cwd: dirname(scriptsDir),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
      },
    },
  );

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^\s*\{/, res.stdout);
  const payload = JSON.parse(res.stdout);
  const updateStep = payload.steps.find((step) => step.id === 'update-stack-env');

  assert.deepEqual(updateStep.envUpdates, [
    { key: 'HAPPIER_STACK_SERVER_PORT', value: '4309' },
    { key: 'HAPPIER_STACK_REPO_DIR', value: '/next/repo' },
  ]);
});
