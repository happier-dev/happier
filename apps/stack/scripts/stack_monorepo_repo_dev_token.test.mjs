import test from 'node:test';
import assert from 'node:assert/strict';
import { setupStackNewMonorepoFixture } from './testkit/stack_new_monorepo_testkit.mjs';

test('hstack stack new repo selectors pin workspace dev monorepo checkout', async (t) => {
  const fixture = await setupStackNewMonorepoFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-stack-dev-token-',
  });

  await fixture.createMonorepoCheckout('main');
  const devRoot = await fixture.createMonorepoCheckout('dev');

  const cases = [
    { name: '--repo=dev token', stackName: 'exp-dev-token', repoArg: '--repo=dev' },
    { name: '--repo=<abs dev path>', stackName: 'exp-dev-abs', repoArg: `--repo=${devRoot}` },
  ];

  for (const testCase of cases) {
    const res = await fixture.runStackNew([testCase.stackName, testCase.repoArg, '--no-copy-auth', '--json']);
    assert.equal(
      res.code,
      0,
      `${testCase.name}: expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );

    const contents = await fixture.readStackEnv(testCase.stackName);
    assert.ok(contents.includes(`HAPPIER_STACK_REPO_DIR=${devRoot}\n`), `${testCase.name}\n${contents}`);
    assert.ok(!contents.includes('HAPPIER_STACK_COMPONENT_DIR_'), `${testCase.name}\n${contents}`);
  }
});
