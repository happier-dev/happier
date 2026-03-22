import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { setupStackNewMonorepoFixture } from './testkit/stack_new_monorepo_testkit.mjs';

test('hstack stack create-dev-auth-seed --json preserves an existing pinned repo dir', async (t) => {
  const fixture = await setupStackNewMonorepoFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-stack-create-dev-auth-seed-repo-pin-',
  });

  await fixture.createMonorepoCheckout('main');
  const devRoot = await fixture.createMonorepoCheckout('dev');
  const stackName = 'exp-dev-auth-seed';

  const created = await fixture.runStackNew([stackName, `--repo=${devRoot}`, '--no-copy-auth', '--json']);
  assert.equal(created.code, 0, `stack new should succeed\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`);

  const before = await fixture.readStackEnv(stackName);
  assert.ok(before.includes(`HAPPIER_STACK_REPO_DIR=${devRoot}\n`), before);

  const reseeded = await runNodeCapture(
    [join(fixture.rootDir, 'scripts', 'stack.mjs'), 'create-dev-auth-seed', stackName, '--non-interactive', '--json'],
    {
      cwd: fixture.rootDir,
      env: fixture.baseEnv,
    }
  );
  assert.equal(
    reseeded.code,
    0,
    `create-dev-auth-seed --json should succeed\nstdout:\n${reseeded.stdout}\nstderr:\n${reseeded.stderr}`
  );

  const after = await fixture.readStackEnv(stackName);
  assert.ok(
    after.includes(`HAPPIER_STACK_REPO_DIR=${devRoot}\n`),
    `expected existing repo pin to survive create-dev-auth-seed --json\n${after}`
  );
});
