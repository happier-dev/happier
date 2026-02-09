import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { setupStackNewMonorepoFixture } from './testkit/stack_new_monorepo_testkit.mjs';

test('hstack stack new server flavor defaults and explicit full flavor pin coherent env values', async (t) => {
  const fixture = await setupStackNewMonorepoFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happier-stack-server-flavors-',
  });
  const monoRoot = await fixture.createMonorepoCheckout('main', { includeServerPrisma: true });

  const cases = [
    {
      name: 'default server flavor',
      stackName: 'exp-flavors-light-default',
      args: ['--json'],
      assertEnv(contents) {
        assert.ok(contents.includes('HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\n'), contents);
        assert.ok(contents.includes('HAPPIER_DB_PROVIDER=sqlite\n'), contents);
        assert.ok(
          contents.includes(`HAPPIER_SERVER_LIGHT_DATA_DIR=${join(fixture.storageDir, 'exp-flavors-light-default', 'server-light')}\n`),
          contents
        );
        assert.ok(
          contents.includes(`HAPPIER_SERVER_LIGHT_FILES_DIR=${join(fixture.storageDir, 'exp-flavors-light-default', 'server-light', 'files')}\n`),
          contents
        );
        assert.equal(
          contents.includes(`HAPPIER_SERVER_LIGHT_DB_DIR=${join(fixture.storageDir, 'exp-flavors-light-default', 'server-light', 'pglite')}\n`),
          false,
          contents
        );
      },
    },
    {
      name: 'explicit full server flavor',
      stackName: 'exp-flavors-full-explicit',
      args: ['--server=happier-server', '--no-copy-auth', '--json'],
      assertEnv(contents) {
        assert.ok(contents.includes('HAPPIER_STACK_SERVER_COMPONENT=happier-server\n'), contents);
        assert.ok(contents.includes('HAPPIER_DB_PROVIDER=postgres\n'), contents);
        assert.ok(contents.includes('HAPPIER_STACK_MANAGED_INFRA=1\n'), contents);
        assert.ok(!contents.includes('HAPPIER_SERVER_LIGHT_DATA_DIR='), contents);
      },
    },
  ];

  for (const testCase of cases) {
    const res = await fixture.runStackNew([testCase.stackName, ...testCase.args]);
    assert.equal(
      res.code,
      0,
      `${testCase.name}: expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );

    const contents = await fixture.readStackEnv(testCase.stackName);
    assert.ok(contents.includes(`HAPPIER_STACK_REPO_DIR=${monoRoot}\n`), `${testCase.name}\n${contents}`);
    assert.ok(!contents.includes('HAPPIER_STACK_COMPONENT_DIR_'), `${testCase.name}\n${contents}`);
    testCase.assertEnv(contents);
  }
});
