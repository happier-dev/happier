import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { createLoadSentinel, sentinelGraphs } from './load-sentinel.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
async function sample(t, root, id) {
  const graph = sentinelGraphs().find(graph => graph.id === id);
  assert.ok(graph, `${id} is part of every sentinel pass`);
  const results = [], posts = [];
  await createLoadSentinel({ repoDir: root, graphs: [graph], signal: t.signal,
    waitForQuiet: async () => {}, onResult: result => results.push(result),
    post: async notice => posts.push(notice) }).request();
  const result = results.at(-1);
  assert.ok(result.startedAt && result.endedAt);
  assert.ok(result.elapsedMs >= 0);
  return { result, posts };
}

test('schema-sync probe detects stale sqlite and mysql projections through canonical owner', async t => {
  const fixture = await createTempFixture(t);
  for (const path of ['scripts/runTsx.mjs', 'scripts/resolveTsxCliInvocation.mjs',
    'scripts/resolveServerRepoRoot.mjs', 'scripts/schemaSync.ts',
    'sources/app/kv/userKvKeyStorage.ts']) {
    const dest = fixture.path('apps/server', path);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(repo, 'apps/server', path), dest);
  }
  await symlink(join(repo, 'node_modules'), fixture.path('node_modules'), 'junction');
  for (const path of ['prisma/sqlite', 'prisma/mysql', 'sources/storage'])
    await mkdir(fixture.path('apps/server', path), { recursive: true });
  await writeFile(fixture.path('apps/server/tsconfig.json'), '{"compilerOptions":{"module":"esnext"}}');
  await writeFile(fixture.path('apps/server/package.json'), '{"type":"module"}');
  await writeFile(fixture.path('apps/server/prisma/schema.prisma'),
    'datasource db {\n provider = "postgresql"\n}\n\nenum Mode {\n active\n}\nmodel Item {\n id String @id\n}\n');
  execFileSync(process.execPath, ['scripts/runTsx.mjs', '--tsconfig', 'tsconfig.json', 'scripts/schemaSync.ts', '--quiet'],
    { cwd: fixture.path('apps/server'), stdio: 'pipe' });
  assert.equal((await sample(t, fixture.root, 'schema-sync')).result.status, 'passed');
  for (const provider of ['sqlite', 'mysql']) {
    const path = fixture.path('apps/server/prisma', provider, 'schema.prisma');
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('id String @id', 'id Int @id'));
    const { result, posts } = await sample(t, fixture.root, 'schema-sync');
    assert.equal(result.status, 'failed');
    assert.equal(posts.length, 1);
    assert.match(posts[0], /URGENT/);
    await writeFile(path, original);
    // Observe the repair: a sentinel never re-alarms a graph it recorded red.
    assert.equal((await sample(t, fixture.root, 'schema-sync')).result.status, 'passed');
  }
  assert.equal((await sample(t, fixture.root, 'schema-sync')).result.status, 'passed');
});

test('migration probe detects tracked deleted directories and missing SQL without checking content', async t => {
  const fixture = await createTempFixture(t);
  const paths = ['apps/server/prisma/migrations', 'apps/server/prisma/sqlite/migrations',
    'apps/server/prisma/mysql/migrations'].map(root => `${root}/20261110114500_fixture/migration.sql`);
  for (const path of paths) {
    await mkdir(dirname(fixture.path(path)), { recursive: true });
    await writeFile(fixture.path(path), 'SELECT 1;');
  }
  const git = (...args) => execFileSync('git', args, { cwd: fixture.root, stdio: 'pipe' });
  git('init'); git('add', '--', ...paths);
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture migrations');
  assert.equal((await sample(t, fixture.root, 'tracked-migrations')).result.status, 'passed');
  for (const path of paths) {
    await rm(fixture.path(path));
    const { result, posts } = await sample(t, fixture.root, 'tracked-migrations');
    assert.equal(result.status, 'failed');
    assert.equal(result.firstFailingModule, path);
    assert.equal(posts.length, 1);
    assert.match(posts[0], /URGENT/);
    await writeFile(fixture.path(path), 'SELECT 2;');
    assert.equal((await sample(t, fixture.root, 'tracked-migrations')).result.status, 'passed');
  }
  await rm(dirname(fixture.path(paths[0])), { recursive: true });
  assert.equal((await sample(t, fixture.root, 'tracked-migrations')).result.status, 'failed');
});
