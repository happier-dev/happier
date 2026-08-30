import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeExistingAccountCountForServerComponent } from './startup.mjs';

async function writeProbePackage({ serverDir, packageName, source }) {
  const packageDir = join(serverDir, 'node_modules', ...packageName.split('/'));
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: packageName, type: 'module', main: './index.js' }), 'utf-8');
  await writeFile(join(packageDir, 'index.js'), source, 'utf-8');
}

test('probeExistingAccountCountForServerComponent reads account count from a runtime-style sqlite payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-startup-runtime-probe-'));
  const serverDir = join(root, 'server');
  const generatedDir = join(serverDir, 'generated', 'sqlite-client');
  const dataDir = join(root, 'data');

  try {
    await mkdir(generatedDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(generatedDir, 'index.js'),
      [
        'export class PrismaClient {',
        '  constructor() {',
        '    this.account = { count: async () => 2 };',
        '  }',
        '  async $disconnect() {}',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await probeExistingAccountCountForServerComponent({
      serverComponentName: 'happier-server-light',
      serverDir,
      env: {
        HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
        DATABASE_URL: `file:${join(dataDir, 'happier-server-light.sqlite')}`,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.accountCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime SQLite probing is provider-driven for the full preset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-startup-full-sqlite-probe-'));
  const serverDir = join(root, 'server');
  const generatedDir = join(serverDir, 'generated', 'sqlite-client');
  const dataDir = join(root, 'data');

  try {
    await mkdir(generatedDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(generatedDir, 'index.js'),
      'export class PrismaClient { constructor() { this.account = { count: async () => 6 }; } async $disconnect() {} }\n',
      'utf-8',
    );
    const result = await probeExistingAccountCountForServerComponent({
      serverComponentName: 'happier-server',
      serverDir,
      env: {
        HAPPIER_DB_PROVIDER: 'sqlite',
        HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
      },
    });
    assert.deepEqual(result, { ok: true, accountCount: 6 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime PGlite probing is provider-driven for the full preset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-startup-full-pglite-probe-'));
  const serverDir = join(root, 'server');
  const dbDir = join(root, 'pglite');

  try {
    await mkdir(dbDir, { recursive: true });
    await writeProbePackage({
      serverDir,
      packageName: '@electric-sql/pglite',
      source: 'export class PGlite { constructor() { this.waitReady = Promise.resolve(); } async close() {} }\n',
    });
    await writeProbePackage({
      serverDir,
      packageName: '@electric-sql/pglite-socket',
      source: "export class PGLiteSocketServer { async start() {} getServerConn() { return '127.0.0.1:55432'; } async stop() {} }\n",
    });
    await writeProbePackage({
      serverDir,
      packageName: '@prisma/client',
      source: 'export class PrismaClient { constructor() { this.account = { count: async () => 7 }; } async $disconnect() {} }\n',
    });
    const result = await probeExistingAccountCountForServerComponent({
      serverComponentName: 'happier-server',
      serverDir,
      env: {
        HAPPIER_DB_PROVIDER: 'pglite',
        HAPPIER_SERVER_LIGHT_DB_DIR: dbDir,
      },
    });
    assert.deepEqual(result, { ok: true, accountCount: 7 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('probeExistingAccountCountForServerComponent uses the bounded server-light sqlite pool without mutating caller env', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-startup-runtime-probe-env-'));
  const serverDir = join(root, 'server');
  const generatedDir = join(serverDir, 'generated', 'sqlite-client');
  const dataDir = join(root, 'data');

  try {
    await mkdir(generatedDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(generatedDir, 'index.js'),
      [
        'export class PrismaClient {',
        '  constructor() {',
        '    if (!process.env.DATABASE_URL.includes("socket_timeout=1&connection_limit=1")) {',
        '      throw new Error(`unexpected DATABASE_URL: ${process.env.DATABASE_URL}`);',
        '    }',
        '    this.account = { count: async () => 3 };',
        '  }',
        '  async $disconnect() {}',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    const env = {
      HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
      HAPPIER_SQLITE_BUSY_TIMEOUT_MS: '500',
    };
    const result = await probeExistingAccountCountForServerComponent({
      serverComponentName: 'happier-server-light',
      serverDir,
      env,
    });

    assert.equal(result.ok, true);
    assert.equal(result.accountCount, 3);
    assert.equal(Object.hasOwn(env, 'DATABASE_URL'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
