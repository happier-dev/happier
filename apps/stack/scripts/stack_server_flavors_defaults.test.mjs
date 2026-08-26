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
    {
      name: 'explicit full mysql server flavor',
      stackName: 'exp-flavors-full-mysql',
      args: [
        '--server=happier-server',
        '--db-provider=mysql',
        '--database-url=mysql://operator:secret@db.example.test:3306/happier',
        '--no-copy-auth',
        '--json',
      ],
      assertEnv(contents) {
        assert.ok(contents.includes('HAPPIER_STACK_SERVER_COMPONENT=happier-server\n'), contents);
        assert.ok(contents.includes('HAPPIER_DB_PROVIDER=mysql\n'), contents);
        assert.ok(contents.includes('DATABASE_URL=mysql://operator:secret@db.example.test:3306/happier\n'), contents);
        assert.ok(contents.includes('HAPPIER_STACK_MANAGED_INFRA=1\n'), contents);
        assert.doesNotMatch(contents, /^HAPPIER_STACK_PG_/m);
      },
    },
    {
      name: 'explicit full external postgres server flavor',
      stackName: 'exp-flavors-full-external-postgres',
      args: [
        '--server=happier-server',
        '--db-provider=postgres',
        '--database-url=postgresql://operator:secret@db.example.test:5432/happier?sslmode=require',
        '--no-copy-auth',
        '--json',
      ],
      assertEnv(contents) {
        assert.ok(contents.includes('HAPPIER_STACK_SERVER_COMPONENT=happier-server\n'), contents);
        assert.ok(contents.includes('HAPPIER_DB_PROVIDER=postgres\n'), contents);
        assert.ok(
          contents.includes('DATABASE_URL=postgresql://operator:secret@db.example.test:5432/happier?sslmode=require\n'),
          contents,
        );
        assert.ok(contents.includes('HAPPIER_STACK_MANAGED_INFRA=1\n'), contents);
        assert.doesNotMatch(contents, /^HAPPIER_STACK_PG_/m);
      },
    },
    {
      name: 'light preset with external postgres',
      stackName: 'exp-flavors-light-postgres',
      args: [
        '--server=happier-server-light',
        '--db-provider=postgres',
        '--database-url=postgresql://operator:secret@db.example.test:5432/happier',
        '--no-copy-auth',
        '--json',
      ],
      assertEnv(contents) {
        assert.match(contents, /^HAPPIER_STACK_SERVER_COMPONENT=happier-server-light$/m);
        assert.match(contents, /^HAPPIER_DB_PROVIDER=postgres$/m);
        assert.match(contents, /^DATABASE_URL=postgresql:\/\/operator:secret@db\.example\.test:5432\/happier$/m);
        assert.doesNotMatch(contents, /^HAPPIER_STACK_MANAGED_INFRA=/m);
      },
    },
    {
      name: 'full preset with sqlite',
      stackName: 'exp-flavors-full-sqlite',
      args: [
        '--server=happier-server',
        '--db-provider=sqlite',
        '--no-copy-auth',
        '--json',
      ],
      assertEnv(contents) {
        assert.match(contents, /^HAPPIER_STACK_SERVER_COMPONENT=happier-server$/m);
        assert.match(contents, /^HAPPIER_DB_PROVIDER=sqlite$/m);
        assert.match(contents, /^HAPPIER_STACK_MANAGED_INFRA=1$/m);
        assert.match(contents, /^HAPPIER_SERVER_LIGHT_DATA_DIR=/m);
        assert.doesNotMatch(contents, /^HAPPIER_STACK_PG_/m);
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

test('hstack stack new preserves explicit empty DB provider presence and rejects it', async (t) => {
  const fixture = await setupStackNewMonorepoFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happier-stack-provider-empty-',
  });
  await fixture.createMonorepoCheckout('main', { includeServerPrisma: true });

  const direct = await fixture.runStackNew([
    'empty-provider-direct',
    '--server=happier-server',
    '--db-provider=',
    '--no-copy-auth',
    '--json',
  ]);
  assert.notEqual(direct.code, 0, `stdout:\n${direct.stdout}\nstderr:\n${direct.stderr}`);
  assert.match(`${direct.stdout}\n${direct.stderr}`, /invalid --db-provider/i);

  const forwarded = await (await import('./testkit/core/run_node_capture.mjs')).runNodeCapture(
    [
      join(fixture.rootDir, 'scripts', 'stack.mjs'),
      'pr',
      'empty-provider-forwarded',
      '--repo=123',
      '--server=happier-server',
      '--db-provider=',
      '--json',
    ],
    { cwd: fixture.rootDir, env: fixture.baseEnv },
  );
  assert.notEqual(forwarded.code, 0, `stdout:\n${forwarded.stdout}\nstderr:\n${forwarded.stderr}`);
  assert.match(`${forwarded.stdout}\n${forwarded.stderr}`, /invalid --db-provider/i);
});
