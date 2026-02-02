import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { ensureServerLightSchemaReady } from './startup.mjs';

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

async function writeEsmPkg({ dir, name, body }) {
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, 'package.json'), { name, type: 'module', main: './index.js' });
  await writeFile(join(dir, 'index.js'), body.trim() + '\n', 'utf-8');
}

test('ensureServerLightSchemaReady creates light data dirs before probing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-startup-light-dirs-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const serverDir = join(root, 'server');
  await mkdir(serverDir, { recursive: true });
  await writeJson(join(serverDir, 'package.json'), { name: 'server', version: '0.0.0' });
  await writeFile(join(serverDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(serverDir, 'node_modules'), { recursive: true });
  await writeFile(join(serverDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  // Stub deps used by the pglite probe (node runs with cwd=serverDir).
  await writeEsmPkg({
    dir: join(serverDir, 'node_modules', '@electric-sql', 'pglite'),
    name: '@electric-sql/pglite',
    body: `
export class PGlite {
  constructor(_dir) { this.waitReady = Promise.resolve(); }
  async close() {}
}
`.trim(),
  });
  await writeEsmPkg({
    dir: join(serverDir, 'node_modules', '@electric-sql', 'pglite-socket'),
    name: '@electric-sql/pglite-socket',
    body: `
export class PGLiteSocketServer {
  constructor(_opts) {}
  async start() {}
  getServerConn() { return '127.0.0.1:54321'; }
  async stop() {}
}
`.trim(),
  });
  await writeEsmPkg({
    dir: join(serverDir, 'node_modules', '@prisma', 'client'),
    name: '@prisma/client',
    body: `
export class PrismaClient {
  constructor() { this.account = { count: async () => 0 }; }
  async $disconnect() {}
}
`.trim(),
  });

  // Minimal stub `yarn` so commandExists('yarn') succeeds.
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      "const args = process.argv.slice(2);",
      "if (args.includes('--version')) { console.log('1.22.22'); process.exit(0); }",
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);

  const dataDir = join(root, 'data');
  const filesDir = join(dataDir, 'files');
  const dbDir = join(dataDir, 'pglite');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
    HAPPIER_SERVER_LIGHT_FILES_DIR: filesDir,
    HAPPIER_SERVER_LIGHT_DB_DIR: dbDir,
  };

  assert.equal(existsSync(dataDir), false);
  assert.equal(existsSync(filesDir), false);
  assert.equal(existsSync(dbDir), false);

  await ensureServerLightSchemaReady({ serverDir, env });

  assert.equal(existsSync(dataDir), true);
  assert.equal(existsSync(filesDir), true);
  assert.equal(existsSync(dbDir), true);
});
