import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyServerComponentFlavorEnv,
  resolveServerDevScript,
  resolveServerStartScript,
} from './flavor_scripts.mjs';
import { resolvePrismaClientImportForDbProvider } from './prisma_client_import.mjs';

test('applyServerComponentFlavorEnv overrides ambient flavor with the admitted component', () => {
  const fullEnv = { HAPPIER_SERVER_FLAVOR: 'light', HAPPY_SERVER_FLAVOR: 'light' };
  assert.equal(applyServerComponentFlavorEnv({ serverComponentName: 'happier-server', targetEnv: fullEnv }), 'full');
  assert.deepEqual(fullEnv, { HAPPIER_SERVER_FLAVOR: 'full', HAPPY_SERVER_FLAVOR: 'full' });

  const lightEnv = { HAPPIER_SERVER_FLAVOR: 'full', HAPPY_SERVER_FLAVOR: 'full' };
  assert.equal(applyServerComponentFlavorEnv({ serverComponentName: 'happier-server-light', targetEnv: lightEnv }), 'light');
  assert.deepEqual(lightEnv, { HAPPIER_SERVER_FLAVOR: 'light', HAPPY_SERVER_FLAVOR: 'light' });
});

test('applyServerComponentFlavorEnv rejects an unknown admitted component', () => {
  assert.throws(
    () => applyServerComponentFlavorEnv({ serverComponentName: 'other-server', targetEnv: {} }),
    /Unsupported server component/,
  );
});

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

async function withServerDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'hs-flavor-scripts-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeServerScriptsPackageJson(dir, scripts) {
  await writeJson(join(dir, 'package.json'), { scripts });
}

test('resolveServer*Script uses light scripts when unified light flavor is detected', async () => {
  await withServerDir(async (dir) => {
    await writeServerScriptsPackageJson(dir, {
      'start:light': 'node x',
      'dev:light': 'node y',
      'migrate:light:deploy': 'node z',
    });
    assert.equal(resolveServerDevScript({ serverComponentName: 'happier-server-light', serverDir: dir, prismaPush: true }), 'dev:light');
    assert.equal(resolveServerDevScript({ serverComponentName: 'happier-server-light', serverDir: dir, prismaPush: false }), 'dev:light');
    assert.equal(resolveServerStartScript({ serverComponentName: 'happier-server-light', serverDir: dir }), 'start:light');
  });
});

test('resolveServer*Script falls back to legacy scripts for non-unified happier-server-light', async () => {
  await withServerDir(async (dir) => {
    await writeServerScriptsPackageJson(dir, { start: 'node start', dev: 'node dev' });
    assert.equal(resolveServerDevScript({ serverComponentName: 'happier-server-light', serverDir: dir, prismaPush: true }), 'dev');
    assert.equal(resolveServerDevScript({ serverComponentName: 'happier-server-light', serverDir: dir, prismaPush: false }), 'start');
    assert.equal(resolveServerStartScript({ serverComponentName: 'happier-server-light', serverDir: dir }), 'start');
  });
});

test('resolveServer*Script returns start for happier-server', async () => {
  await withServerDir(async (dir) => {
    await writeServerScriptsPackageJson(dir, { start: 'node start', dev: 'node dev' });
    assert.equal(resolveServerDevScript({ serverComponentName: 'happier-server', serverDir: dir, prismaPush: true }), 'start');
    assert.equal(resolveServerDevScript({ serverComponentName: 'happier-server', serverDir: dir, prismaPush: false }), 'start');
    assert.equal(resolveServerStartScript({ serverComponentName: 'happier-server', serverDir: dir }), 'start');
  });
});

test('resolvePrismaClientImportForDbProvider returns the default client for postgres-compatible providers', async () => {
  await withServerDir(async (dir) => {
    assert.equal(resolvePrismaClientImportForDbProvider({ serverDir: dir, provider: 'postgres' }), '@prisma/client');
    assert.equal(resolvePrismaClientImportForDbProvider({ serverDir: dir, provider: 'pglite' }), '@prisma/client');
  });
});

test('resolvePrismaClientImportForDbProvider returns generated provider clients when present', async () => {
  await withServerDir(async (dir) => {
    await mkdir(join(dir, 'generated', 'sqlite-client'), { recursive: true });
    await writeFile(join(dir, 'generated', 'sqlite-client', 'index.js'), 'export class PrismaClient {}\n', 'utf-8');
    const spec = resolvePrismaClientImportForDbProvider({ serverDir: dir, provider: 'sqlite' });
    assert.ok(spec.startsWith('file:'));
    assert.ok(spec.endsWith('/generated/sqlite-client/index.js'));
  });
});
