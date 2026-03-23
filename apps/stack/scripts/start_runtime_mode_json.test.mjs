import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeSnapshotFixture, runNode } from './testkit/runtime_snapshot_testkit.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('hstack start --json --runtime reports runtime-backed launch paths', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t);

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'run.mjs'), '--json', '--runtime'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.mode, 'start');
  assert.equal(parsed.launchMode, 'runtime');
  assert.equal(parsed.runtimeSnapshotId, 'snap-1');
  assert.equal(parsed.cliDir, join(fixture.stackDir, 'runtime', 'current', 'cli'));
  assert.equal(parsed.serverDir, join(fixture.stackDir, 'runtime', 'current', 'server'));
  assert.equal(parsed.uiBuildDir, join(fixture.stackDir, 'runtime', 'current', 'ui'));
});
