import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { preflightSourceRuntimeMigrations } from './preflightSourceRuntimeMigrations.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

test('PGlite preflight preserves its incumbent-owned exclusive migration lifecycle', async () => {
  // Any attempt to open the database or resolve a sidecar would fail: this
  // provider must wait for the existing exclusive restart to release its lock.
  await preflightSourceRuntimeMigrations({ server: { dbProvider: 'pglite',
    serverDir: 'not-an-accessible-database', migration: { mode: 'external', command: 'must-not-run' } }, env: {} });
});

test('retained server preflight deploys current source migrations and propagates a failed deploy', async t => {
  const { root: repoDir } = await createTempFixture(t, { prefix: 'hstack-retained-migration-' });
  const { packageManager } = JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8'));
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, packageManager }));
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  for (const app of ['ui', 'cli', 'server']) {
    await mkdir(join(repoDir, 'apps', app), { recursive: true });
    await writeFile(join(repoDir, 'apps', app, 'package.json'), JSON.stringify({
      name: `fixture-${app}`, scripts: { 'migrate:deploy': 'node migrate-fixture.mjs' },
    }));
  }
  const serverDir = join(repoDir, 'apps/server');
  const marker = join(serverDir, 'deployed');
  const script = join(serverDir, 'migrate-fixture.mjs');
  await writeFile(script, "import { writeFile } from 'node:fs/promises'; await writeFile('deployed', process.env.HAPPIER_DB_PROVIDER);\n");
  const request = { currentServerDir: serverDir, stackBaseDir: repoDir, env: { ...process.env, HAPPIER_DB_PROVIDER: 'sqlite' },
    server: { lastGreen: true, serverComponent: 'happier-server-light', dbProvider: 'sqlite',
      serverDir: join(repoDir, 'old-server'), entrypoint: join(repoDir, 'old-server/main.mjs'),
      migration: { mode: 'external', command: 'must-not-run-old-migrations' } } };
  await preflightSourceRuntimeMigrations(request);
  assert.equal(await readFile(marker, 'utf8'), 'sqlite');
  await writeFile(script, 'process.exitCode = 1;\n');
  await assert.rejects(preflightSourceRuntimeMigrations(request));
});

test('ordinary retained startup leaves migration deployment to the current source refresh', async () => {
  await preflightSourceRuntimeMigrations({ stackBaseDir: tmpdir(), env: { HAPPIER_DB_PROVIDER: 'sqlite' },
    server: { lastGreen: true, serverComponent: 'happier-server-light', dbProvider: 'sqlite',
      serverDir: 'not-a-server-directory', migration: { mode: 'external', command: 'must-not-run' } } });
});
