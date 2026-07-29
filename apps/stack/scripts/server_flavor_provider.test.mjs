import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNode } from './testkit/runtime_snapshot_testkit.mjs';

const stackRootDir = join(import.meta.dirname, '..');
const flavorScript = join(stackRootDir, 'scripts', 'server_flavor.mjs');

async function switchFlavor(t, {
  initialProvider,
  target,
  initialComponent = 'happier-server-light',
  databaseUrl,
  databaseUrlInProcess,
  expectCode = 0,
}) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-server-flavor-provider-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const storageDir = join(root, 'stacks');
  const envPath = join(storageDir, 'main', 'env');
  await mkdir(join(storageDir, 'main'), { recursive: true });
  const providerLine = initialProvider === undefined ? '' : `HAPPIER_DB_PROVIDER=${initialProvider}\n`;
  const databaseUrlLine = databaseUrl === undefined ? '' : `DATABASE_URL=${databaseUrl}\n`;
  await writeFile(envPath, `HAPPIER_STACK_SERVER_COMPONENT=${initialComponent}\n${providerLine}${databaseUrlLine}`, 'utf8');

  const result = await runNode([flavorScript, 'use', target, '--json'], {
    cwd: stackRootDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: 'main',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_ENV_FILE: envPath,
      ...(databaseUrlInProcess === undefined ? {} : { DATABASE_URL: databaseUrlInProcess }),
    },
  });
  assert.equal(result.code, expectCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return { contents: await readFile(envPath, 'utf8'), result };
}

test('server flavor writer replaces incompatible or absent providers with the target default', async (t) => {
  for (const initialProvider of [undefined, 'sqlite', 'pglite']) {
    const { contents } = await switchFlavor(t, { initialProvider, target: 'full' });
    assert.match(contents, /HAPPIER_STACK_SERVER_COMPONENT=happier-server\n/);
    assert.match(contents, /HAPPIER_DB_PROVIDER=postgres\n/);
  }

  const { contents: light } = await switchFlavor(t, {
    initialProvider: 'mysql',
    initialComponent: 'happier-server',
    databaseUrl: 'mysql://operator:secret@db.example.test:3306/happier',
    target: 'light',
  });
  assert.match(light, /HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\n/);
  assert.match(light, /HAPPIER_DB_PROVIDER=sqlite\n/);
  assert.doesNotMatch(light, /^DATABASE_URL=/m);
});

test('server flavor writer rejects explicitly empty or unknown provider metadata', async (t) => {
  for (const initialProvider of ['', 'unsupported']) {
    const { contents, result } = await switchFlavor(t, { initialProvider, target: 'full', expectCode: 1 });
    assert.match(`${result.stdout}\n${result.stderr}`, /invalid DB provider/i);
    assert.match(contents, /^HAPPIER_STACK_SERVER_COMPONENT=happier-server-light$/m);
    assert.doesNotMatch(contents, /^HAPPIER_STACK_SERVER_COMPONENT=happier-server$/m);
  }
});

test('server flavor writer preserves compatible explicit providers', async (t) => {
  const databaseUrl = 'mysql://operator:secret@db.example.test:3306/happier';
  const { contents: mysql } = await switchFlavor(t, {
    initialProvider: 'mysql',
    initialComponent: 'happier-server',
    databaseUrl,
    target: 'full',
  });
  assert.match(mysql, /HAPPIER_DB_PROVIDER=mysql\n/);
  assert.match(mysql, new RegExp(`^DATABASE_URL=${databaseUrl}$`, 'm'));

  const { contents: shellMysql } = await switchFlavor(t, {
    initialProvider: 'mysql',
    initialComponent: 'happier-server',
    databaseUrlInProcess: databaseUrl,
    target: 'full',
  });
  assert.match(shellMysql, new RegExp(`^DATABASE_URL=${databaseUrl}$`, 'm'));

  const { contents: pglite } = await switchFlavor(t, { initialProvider: 'pglite', target: 'light' });
  assert.match(pglite, /HAPPIER_DB_PROVIDER=pglite\n/);
});

test('server flavor writer fails closed when preserving MySQL without DATABASE_URL', async (t) => {
  const { contents, result } = await switchFlavor(t, {
    initialProvider: 'mysql',
    initialComponent: 'happier-server',
    target: 'full',
    expectCode: 1,
  });
  assert.match(`${result.stdout}\n${result.stderr}`, /mysql.*DATABASE_URL|DATABASE_URL.*mysql/i);
  assert.match(contents, /^HAPPIER_STACK_SERVER_COMPONENT=happier-server$/m);
  assert.match(contents, /^HAPPIER_DB_PROVIDER=mysql$/m);
});

test('server flavor writer removes incompatible MySQL URL when selecting full Postgres', async (t) => {
  const { contents } = await switchFlavor(t, {
    initialProvider: 'sqlite',
    databaseUrl: 'mysql://stale:secret@db.example.test:3306/happier',
    target: 'full',
  });
  assert.match(contents, /^HAPPIER_DB_PROVIDER=postgres$/m);
  assert.doesNotMatch(contents, /^DATABASE_URL=/m);

  const { contents: lightUrlContents } = await switchFlavor(t, {
    initialProvider: 'pglite',
    databaseUrl: 'file:/tmp/stale-light-database',
    target: 'full',
  });
  assert.match(lightUrlContents, /^HAPPIER_DB_PROVIDER=postgres$/m);
  assert.doesNotMatch(lightUrlContents, /^DATABASE_URL=/m);
});
