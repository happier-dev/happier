import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { spawnRuntimeServerAfterMigration } from './runServerRuntimeMigration.mjs';
import { preflightSourceRuntimeMigrations } from './preflightSourceRuntimeMigrations.mjs';

const base = '20260101000000_base';
const pending = '20260102000000_pending';
const future = '20260103000000_future';

async function fixture(t, expected, applied) {
  const files = await createTempFixture(t, { prefix: 'hstack-shared-db-gate-' });
  const serverDir = files.path('server');
  for (const name of expected) {
    const dir = join(serverDir, 'prisma/sqlite/migrations', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'migration.sql'), 'SELECT 1;\n');
  }
  const databasePath = files.path('source.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE _prisma_migrations (migration_name TEXT, checksum TEXT, finished_at TEXT, rolled_back_at TEXT)');
  for (const row of applied) {
    db.prepare('INSERT INTO _prisma_migrations VALUES (?, ?, ?, ?)').run(
      typeof row === 'string' ? row : row.name, '',
      typeof row === 'string' ? 'done' : row.finished, typeof row === 'string' ? null : row.rolledBack);
  }
  db.close();
  const env = { HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'source-owner', HAPPIER_DB_PROVIDER: 'sqlite',
    DATABASE_URL: pathToFileURL(databasePath).href, RUN_MIGRATIONS: '0', HAPPIER_STACK_PRISMA_MIGRATE: '0' };
  const serverLaunchSpec = { serverDir, command: process.execPath, args: [], migration: { mode: 'disabled' } };
  const launches = [];
  const start = () => spawnRuntimeServerAfterMigration({ serverLaunchSpec, env, children: [],
    spawnProcImpl: label => { launches.push(label); return { pid: 123 }; } });
  return { start, launches, databasePath, serverDir, env };
}

test('shared consumer refuses missing migrations before spawning and leaves the real source ledger unchanged', async t => {
  const f = await fixture(t, [base, pending], [base]);
  await assert.rejects(f.start(), error => {
    assert.equal(error.code, 'ESHAREDDBMIGRATIONSMISSING');
    assert.equal(error.sourceStack, 'source-owner');
    assert.deepEqual(error.missingMigrations, [pending]);
    assert.ok(error.message.includes(pending));
    assert.ok(error.message.includes('source-owner'));
    assert.ok(!error.message.includes(f.env.DATABASE_URL));
    return true;
  });
  assert.deepEqual(f.launches, []);
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  try { assert.deepEqual(db.prepare('SELECT migration_name FROM _prisma_migrations').all().map(row => row.migration_name), [base]); }
  finally { db.close(); }
});

for (const [relationship, applied] of [['equal', [base]], ['source ahead', [base, future]]]) {
  test(`shared consumer starts when the source migration set is ${relationship}`, async t => {
    const f = await fixture(t, [base], applied);
    assert.equal((await f.start()).pid, 123);
    assert.deepEqual(f.launches, ['server']);
  });
}

test('unfinished and rolled-back ledger records do not satisfy a shared consumer', async t => {
  const f = await fixture(t, [base, pending], [
    { name: base, finished: null, rolledBack: null },
    { name: pending, finished: 'done', rolledBack: 'rolled back' },
  ]);
  await assert.rejects(f.start(), error => error.code === 'ESHAREDDBMIGRATIONSMISSING'
    && JSON.stringify(error.missingMigrations) === JSON.stringify([base, pending]));
  assert.deepEqual(f.launches, []);
});

test('own-database starts perform no shared migration admission', async () => {
  const launches = [];
  const server = await spawnRuntimeServerAfterMigration({ serverLaunchSpec: {
    serverDir: 'not-a-server-directory', command: process.execPath, args: [], migration: { mode: 'disabled' },
  }, env: {}, children: [], spawnProcImpl: label => { launches.push(label); return { pid: 456 }; } });
  assert.equal(server.pid, 456);
  assert.deepEqual(launches, ['server']);
});

test('retained preflight checks the current consumer catalog and never deploys its source database', async t => {
  const f = await fixture(t, [base, pending], [base]);
  const sourceEnvPath = join(f.serverDir, 'source.env');
  const sourceDataDir = join(f.serverDir, 'server-light');
  await mkdir(sourceDataDir);
  await writeFile(join(sourceDataDir, 'handy-master-secret.txt'), randomUUID());
  await writeFile(sourceEnvPath, `HAPPIER_DB_PROVIDER=sqlite\nDATABASE_URL=${f.env.DATABASE_URL}\n`);
  const request = { currentServerDir: f.serverDir, stackBaseDir: f.serverDir,
    env: { ...f.env, HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: sourceEnvPath },
    server: { lastGreen: true, serverComponent: 'happier-server-light', dbProvider: 'sqlite',
      serverDir: join(f.serverDir, 'older'), migration: { mode: 'disabled' } } };
  await assert.rejects(preflightSourceRuntimeMigrations(request), error =>
    error.code === 'ESHAREDDBMIGRATIONSMISSING' && JSON.stringify(error.missingMigrations) === JSON.stringify([pending]));
  const db = new DatabaseSync(f.databasePath);
  db.prepare('INSERT INTO _prisma_migrations VALUES (?, ?, ?, ?)').run(pending, '', 'done', null);
  db.close();
  await preflightSourceRuntimeMigrations(request);
});

test('an admitted shared consumer never runs a deploy even when the launch spec requests one', async t => {
  const f = await fixture(t, [base], [base]);
  const launches = [];
  await spawnRuntimeServerAfterMigration({ serverLaunchSpec: {
    serverDir: f.serverDir, command: process.execPath, args: [],
    migration: { mode: 'external', command: 'must-not-run' },
  }, env: f.env, children: [], spawnProcImpl: label => { launches.push(label); return { pid: 789 }; } });
  assert.deepEqual(launches, ['server']);
});

test('a setup failure never guesses failedMigration from a pending ledger entry', async t => {
  const f = await fixture(t, [base, pending], [base]);
  const scripts = join(f.serverDir, 'scripts');
  await mkdir(scripts);
  const command = join(scripts, 'migrate.mjs');
  await writeFile(command, 'throw new Error("setup failed before migration execution");');
  await assert.rejects(spawnRuntimeServerAfterMigration({ serverLaunchSpec: {
    serverDir: f.serverDir, command: process.execPath, args: [],
    migration: { mode: 'external', command, cwd: f.serverDir },
  }, env: { ...f.env, HAPPIER_STACK_SHARED_DB_SOURCE_STACK: '' }, children: [],
  spawnProcImpl: () => ({ completion: Promise.resolve({ code: 1, signal: null }) }),
  }), error => error.code === 'ERUNTIMESERVERMIGRATIONFAILED' && error.failedMigration === null);
});

test('unreadable ledger refuses safely instead of reporting an applied migration', async t => {
  const f = await fixture(t, [base], [base]);
  const db = new DatabaseSync(f.databasePath);
  db.exec('DROP TABLE _prisma_migrations');
  db.close();
  await assert.rejects(f.start(), error => error.code === 'ESHAREDDBMIGRATIONSTATUSUNAVAILABLE'
    && !error.message.includes(f.env.DATABASE_URL));
  assert.deepEqual(f.launches, []);
});
