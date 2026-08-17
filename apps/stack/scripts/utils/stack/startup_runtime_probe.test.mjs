import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getAccountCountForServerComponent,
  probeExistingAccountCountForServerComponent,
} from './startup.mjs';

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

test('best-effort account count reuses the existing runtime probe without dependency preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stack-startup-best-effort-runtime-probe-'));
  const serverDir = join(root, 'server');
  const generatedDir = join(serverDir, 'generated', 'sqlite-client');
  const dataDir = join(root, 'data');

  try {
    await mkdir(generatedDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(serverDir, 'package.json'),
      JSON.stringify({ name: '@test/runtime-server', private: true, type: 'module' }) + '\n',
      'utf-8',
    );
    await writeFile(join(serverDir, 'yarn.lock'), '# intentionally not installed\n', 'utf-8');
    await writeFile(
      join(generatedDir, 'index.js'),
      [
        'export class PrismaClient {',
        '  constructor() {',
        '    this.account = { count: async () => 4 };',
        '  }',
        '  async $disconnect() {}',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await getAccountCountForServerComponent({
      serverComponentName: 'happier-server-light',
      serverDir,
      env: {
        HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
        DATABASE_URL: `file:${join(dataDir, 'happier-server-light.sqlite')}`,
        // If the best-effort path starts dependency preparation, this fixture has no
        // package manifest or package-manager binary and the probe cannot succeed.
        PATH: '',
      },
      bestEffort: true,
    });

    assert.deepEqual(result, { ok: true, accountCount: 4 });
    assert.equal(existsSync(join(serverDir, 'node_modules')), false);
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
        '    if (!process.env.DATABASE_URL.includes("socket_timeout=1&connection_limit=4")) {',
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
