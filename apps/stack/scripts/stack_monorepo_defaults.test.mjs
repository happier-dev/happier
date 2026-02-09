import test from 'node:test';
import assert from 'node:assert/strict';
import { setupStackNewMonorepoFixture } from './testkit/stack_new_monorepo_testkit.mjs';

test('hstack stack new defaults repo token variants to workspace main monorepo checkout', async (t) => {
  const fixture = await setupStackNewMonorepoFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happy-stacks-stack-monorepo-defaults-',
  });
  const mainMonorepoRoot = await fixture.createMonorepoCheckout('main');

  const cases = [
    { name: 'implicit default repo', stackName: 'exp-test', args: [] },
    { name: '--repo=main token', stackName: 'exp-main-token', args: ['--repo=main', '--no-copy-auth'] },
    { name: '--repo=default token', stackName: 'exp-default-token', args: ['--repo=default', '--no-copy-auth'] },
  ];

  for (const testCase of cases) {
    const res = await fixture.runStackNew([testCase.stackName, ...testCase.args, '--json']);
    assert.equal(
      res.code,
      0,
      `${testCase.name}: expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );

    const contents = await fixture.readStackEnv(testCase.stackName);
    assert.ok(contents.includes(`HAPPIER_STACK_REPO_DIR=${mainMonorepoRoot}\n`), `${testCase.name}\n${contents}`);
    assert.ok(!contents.includes('HAPPIER_STACK_COMPONENT_DIR_'), `${testCase.name}\n${contents}`);
  }
});
