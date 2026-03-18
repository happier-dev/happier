import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createRuntimeSnapshotStartFixture, runtimeSnapshotEnv, runNode, stackRootDirFromMeta } from './testkit/runtime_snapshot_start_testkit.mjs';

test('hstack start --json reports runtime launch mode and runtime-backed ui build dir', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotStartFixture(t);

  const env = runtimeSnapshotEnv({ fixture, rootDir });
  const res = await runNode([join(rootDir, 'scripts', 'run.mjs'), '--json'], { cwd: rootDir, env });

  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.mode, 'start');
  assert.equal(parsed.launchMode, 'runtime');
  assert.equal(parsed.runtimeSnapshotId, fixture.snapshotId);
  assert.equal(parsed.uiBuildDir, join(fixture.stackDir, 'runtime', 'current', 'ui'));
});
