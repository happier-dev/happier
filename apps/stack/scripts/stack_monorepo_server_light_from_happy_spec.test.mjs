import test from 'node:test';
import assert from 'node:assert/strict';
import { setupStackNewMonorepoFixture } from './testkit/stack_new_monorepo_testkit.mjs';

test('hstack stack new pins HAPPIER_STACK_REPO_DIR from monorepo path specs', async (t) => {
  const fixture = await setupStackNewMonorepoFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happier-stack-monorepo-spec-',
  });

  const monoRoot = await fixture.createMonorepoCheckout('tmp/leeroy/leeroy-wip', { includeServerPrisma: true });

  const cases = [
    { name: 'absolute monorepo path', stackName: 'exp-mono-spec', repoArg: `--repo=${monoRoot}` },
    { name: 'workspace-relative monorepo path', stackName: 'exp-mono-relative', repoArg: '--repo=./tmp/leeroy/leeroy-wip' },
  ];

  for (const testCase of cases) {
    const res = await fixture.runStackNew([
      testCase.stackName,
      testCase.repoArg,
      '--server=happier-server-light',
      '--no-copy-auth',
      '--json',
    ]);
    assert.equal(
      res.code,
      0,
      `${testCase.name}: expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );

    const contents = await fixture.readStackEnv(testCase.stackName);
    assert.ok(contents.includes(`HAPPIER_STACK_REPO_DIR=${monoRoot}\n`), `${testCase.name}\n${contents}`);
    assert.ok(!contents.includes('HAPPIER_STACK_COMPONENT_DIR_'), `${testCase.name}\n${contents}`);
  }
});
