import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { writeFakeServerDatabaseOwner } from '../../testkit/core/server_database_fixture.mjs';
import { ensureServerLightSchemaReady } from './startup.mjs';

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

async function writeEsmPkg({ dir, name, body }) {
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, 'package.json'), { name, type: 'module', main: './index.js' });
  await writeFile(join(dir, 'index.js'), body.trim() + '\n', 'utf-8');
}

async function writeServerLightProbeStubs(serverDir) {
  const packages = [
    {
      path: join(serverDir, 'node_modules', '@electric-sql', 'pglite'),
      name: '@electric-sql/pglite',
      body: `
export class PGlite {
  constructor(_dir) { this.waitReady = Promise.resolve(); }
  async close() {}
}
`,
    },
    {
      path: join(serverDir, 'node_modules', '@electric-sql', 'pglite-socket'),
      name: '@electric-sql/pglite-socket',
      body: `
export class PGLiteSocketServer {
  constructor(_opts) {}
  async start() {}
  getServerConn() { return '127.0.0.1:54321'; }
  async stop() {}
}
`,
    },
  ];

  for (const pkg of packages) {
    await writeEsmPkg({ dir: pkg.path, name: pkg.name, body: pkg.body });
  }
  await writeFakeServerDatabaseOwner({
    serverDir,
    createClientSource: '  return { account: { count: async () => 0 }, async $disconnect() {} };',
  });
}

async function writePnpmVersionShim(binDir) {
  const pnpmPath = join(binDir, 'pnpm');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    pnpmPath,
    [
      '#!/usr/bin/env node',
      "const args = process.argv.slice(2);",
      "if (args.includes('--version')) { console.log('12.14.0'); process.exit(0); }",
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(pnpmPath, 0o755);
}

async function createServerLightProbeFixture(root) {
  const serverDir = join(root, 'server');
  await mkdir(serverDir, { recursive: true });
  await writeJson(join(serverDir, 'package.json'), { name: 'server', version: '0.0.0', type: 'module' });
  await writeFile(join(serverDir, 'pnpm-lock.yaml'), '# pnpm\n', 'utf-8');
  await writeFile(join(serverDir, 'pnpm-workspace.yaml'), 'packages: []\n');
  await mkdir(join(serverDir, 'node_modules'), { recursive: true });
  await writeFile(join(serverDir, 'node_modules', '.modules.yaml'), 'ok\n', 'utf-8');
  await writeServerLightProbeStubs(serverDir);

  const binDir = join(root, 'bin');
  await writePnpmVersionShim(binDir);
  return { serverDir, binDir };
}

test('ensureServerLightSchemaReady creates sqlite light data dirs before probing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-startup-light-dirs-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const { serverDir, binDir } = await createServerLightProbeFixture(root);

  const dataDir = join(root, 'data');
  const filesDir = join(dataDir, 'files');
  const dbDir = join(dataDir, 'pglite');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
    HAPPIER_SERVER_LIGHT_FILES_DIR: filesDir,
  };

  assert.equal(existsSync(dataDir), false);
  assert.equal(existsSync(filesDir), false);
  assert.equal(existsSync(dbDir), false);

  await ensureServerLightSchemaReady({ serverDir, env });

  assert.equal(existsSync(dataDir), true);
  assert.equal(existsSync(filesDir), true);
  assert.equal(existsSync(dbDir), false);
});
