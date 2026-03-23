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
  const res = await runNode([join(rootDir, 'scripts', 'dev.mjs'), '--runtime'], {
    cwd: rootDir,
    env: process.env,
  });

  assert.equal(res.code, 1, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr + res.stdout, /does not support runtime mode/i);
});
