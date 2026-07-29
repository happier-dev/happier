import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNodeCapture } from './testkit/core/run_node_capture.mjs';

async function createMigrationFixture(t, { sourceProvider, targetProvider, targetDatabaseUrl }) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-migrate-provider-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const storageDir = join(root, 'storage');
  const fromEnvPath = join(storageDir, 'from', 'env');
  const toEnvPath = join(storageDir, 'to', 'env');
  await mkdir(join(storageDir, 'from'), { recursive: true });
  await mkdir(join(storageDir, 'to'), { recursive: true });
  await writeFile(fromEnvPath, [
    'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
    ...(sourceProvider == null ? [] : [`HAPPIER_DB_PROVIDER=${sourceProvider}`]),
    '',
  ].join('\n'), 'utf8');
  await writeFile(toEnvPath, [
    'HAPPIER_STACK_SERVER_COMPONENT=happier-server',
    `HAPPIER_DB_PROVIDER=${targetProvider}`,
    ...(targetDatabaseUrl ? [`DATABASE_URL=${targetDatabaseUrl}`] : []),
    '',
  ].join('\n'), 'utf8');
  return {
    env: {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_ENV_FILE: join(root, 'nonexistent-active-env'),
    },
    toEnvPath,
  };
}

async function runMigration(fixture) {
  return await runNodeCapture([
    join(import.meta.dirname, 'migrate.mjs'),
    'light-to-server',
    '--from-stack=from',
    '--to-stack=to',
    '--json',
  ], { cwd: join(import.meta.dirname, '..'), env: fixture.env });
}

test('light-to-server rejects the default SQLite source before side effects', async (t) => {
  const fixture = await createMigrationFixture(t, { sourceProvider: null, targetProvider: 'postgres' });
  const before = await readFile(fixture.toEnvPath, 'utf8');
  const result = await runMigration(fixture);
  assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /supported.*pglite.*postgres|pglite.*postgres.*supported/i);
  assert.equal(await readFile(fixture.toEnvPath, 'utf8'), before);
});

test('light-to-server rejects a MySQL target before side effects', async (t) => {
  const fixture = await createMigrationFixture(t, {
    sourceProvider: 'pglite',
    targetProvider: 'mysql',
    targetDatabaseUrl: 'mysql://operator:secret@db.example.test:3306/happier',
  });
  const before = await readFile(fixture.toEnvPath, 'utf8');
  const result = await runMigration(fixture);
  assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /supported.*pglite.*postgres|pglite.*postgres.*supported/i);
  assert.equal(await readFile(fixture.toEnvPath, 'utf8'), before);
});
