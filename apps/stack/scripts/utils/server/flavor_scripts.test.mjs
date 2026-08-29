import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveServerDevScript,
  resolveServerStartScript,
} from './flavor_scripts.mjs';
import { resolvePrismaClientImportForDbProvider } from './prisma_client_import.mjs';

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

test('resolveServer*Script uses dedicated light preset scripts when available', async () => {
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

test('resolveServer*Script falls back to legacy scripts when dedicated light preset scripts are absent', async () => {
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
    assert.ok(spec.startsWith('file:'), `expected file: URL import spec, got: ${spec}`);
    assert.ok(spec.endsWith('/generated/sqlite-client/index.js'));
  });
});

test('resolvePrismaClientImportForDbProvider fails closed when a provider-specific client is absent', async () => {
  await withServerDir(async (dir) => {
    assert.throws(
      () => resolvePrismaClientImportForDbProvider({ serverDir: dir, provider: 'sqlite' }),
      /Missing generated Prisma client for sqlite/,
    );
    assert.throws(
      () => resolvePrismaClientImportForDbProvider({ serverDir: dir, provider: 'unknown' }),
      /Unsupported database provider/,
    );
  });
});
