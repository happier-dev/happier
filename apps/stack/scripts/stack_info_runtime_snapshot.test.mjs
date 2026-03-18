import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createRuntimeSnapshotStartFixture, runtimeSnapshotEnv, runNode, stackRootDirFromMeta } from './testkit/runtime_snapshot_start_testkit.mjs';

test('hstack stack info <name> --json reports the active runtime snapshot', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotStartFixture(t);

  const env = runtimeSnapshotEnv({ fixture, rootDir });
  const res = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'info', fixture.stackName, '--json'], { cwd: rootDir, env });

  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.stackName, fixture.stackName);
  assert.equal(parsed.runtime.activeSnapshotId, fixture.snapshotId);
  assert.equal(parsed.runtime.snapshotPath, fixture.snapshotDir);
  assert.equal(parsed.runtime.valid, true);
  assert.equal(parsed.runtime.mode, 'prefer');
  assert.equal(parsed.ports.server, fixture.serverPort);
});
