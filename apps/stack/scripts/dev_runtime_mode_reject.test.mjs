import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNode } from './testkit/runtime_snapshot_testkit.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('hstack dev rejects runtime mode flags', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  for (const runtimeArg of ['--runtime', '--runtime=source', '--runtime=built']) {
    const res = await runNode([join(rootDir, 'scripts', 'dev.mjs'), runtimeArg], {
      cwd: rootDir,
      env: process.env,
    });
    assert.equal(res.code, 1, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stderr + res.stdout, /does not support runtime mode/i);
  }
});

test('hstack dev rejects a stack persisted in controlled source snapshot mode', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const res = await runNode([join(rootDir, 'scripts/dev.mjs'), '--json'], { cwd: rootDir,
    env: { ...process.env, HAPPIER_STACK_RUNTIME_MODE: 'source-snapshot', HAPPIER_STACK_NO_DEV_TARGETS: '1' } });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr + res.stdout, /controlled runtime.*hstack start/i);
});

test('hstack dev rejects a stack persisted in controlled runtime require mode', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const res = await runNode([join(rootDir, 'scripts', 'dev.mjs'), '--json'], {
    cwd: rootDir,
    env: {
      ...process.env,
      HAPPIER_STACK_RUNTIME_MODE: 'require',
    },
  });

  assert.equal(res.code, 1, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr + res.stdout, /controlled runtime.*hstack start/i);
});
