import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNode } from './testkit/runtime_snapshot_testkit.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('hstack dev --json reports React Native DevTools open when requested', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const res = await runNode([join(rootDir, 'scripts', 'dev.mjs'), '--json', '--rn-devtools', '--no-daemon', '--no-server', '--no-dev-targets', '--server-url=https://api.example.com'], {
    cwd: rootDir,
    env: process.env,
  });

  assert.equal(res.code, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.openReactNativeDevtools, true);
});

test('hstack dev --json reports daemon disabled by HAPPIER_STACK_DAEMON=0', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const res = await runNode(
    [
      join(rootDir, 'scripts', 'dev.mjs'),
      '--json',
      '--no-ui',
      '--no-server',
      '--no-dev-targets',
      '--server-url=https://api.example.com',
    ],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_DAEMON: '0',
      },
    },
  );

  assert.equal(res.code, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.startDaemon, false);
});

test('hstack run and dev agree that a whitespace-padded daemon zero disables startup', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const env = {
    ...process.env,
    HAPPIER_STACK_DAEMON: ' 0 ',
  };
  const [runResult, devResult] = await Promise.all([
    runNode([join(rootDir, 'scripts', 'run.mjs'), '--json', '--no-ui'], {
      cwd: rootDir,
      env,
    }),
    runNode(
      [
        join(rootDir, 'scripts', 'dev.mjs'),
        '--json',
        '--no-ui',
        '--no-server',
        '--no-dev-targets',
        '--server-url=https://api.example.com',
      ],
      {
        cwd: rootDir,
        env,
      },
    ),
  ]);

  assert.equal(runResult.code, 0, `stdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`);
  assert.equal(devResult.code, 0, `stdout:\n${devResult.stdout}\nstderr:\n${devResult.stderr}`);
  assert.equal(JSON.parse(runResult.stdout).startDaemon, false);
  assert.equal(JSON.parse(devResult.stdout).startDaemon, false);
});
