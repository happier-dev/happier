import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createRuntimeSnapshotStartFixture, runtimeSnapshotEnv, runNode, stackRootDirFromMeta } from './testkit/runtime_snapshot_start_testkit.mjs';

test('hstack stack runtime <name> activate forwards into the runtime activate command for named stacks', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotStartFixture(t);

  const env = runtimeSnapshotEnv({ fixture, rootDir });
  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', fixture.stackName, 'activate', '--json'],
    { cwd: rootDir, env },
  );

  assert.notEqual(res.code, 0, `expected non-zero exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr + res.stdout, /no web artifact is available for activation/i);
});
