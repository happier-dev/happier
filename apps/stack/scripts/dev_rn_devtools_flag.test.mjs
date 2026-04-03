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
  const res = await runNode([join(rootDir, 'scripts', 'dev.mjs'), '--json', '--rn-devtools', '--no-daemon', '--no-server', '--server-url=https://api.example.com'], {
    cwd: rootDir,
    env: process.env,
  });

  assert.equal(res.code, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.openReactNativeDevtools, true);
});

