import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

async function writeEsmPkg({ dir, name, body }) {
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, 'package.json'), { name, type: 'module', main: './index.js' });
  await writeFile(join(dir, 'index.js'), body.trim() + '\n', 'utf-8');
}

async function seedServerLightProbeDeps({ serverDir, socketPort }) {
  await mkdir(join(serverDir, 'node_modules'), { recursive: true });
  await writeFile(join(serverDir, 'node_modules', '.modules.yaml'), 'ok\n', 'utf-8');
  await writeEsmPkg({
    dir: join(serverDir, 'node_modules', '@electric-sql', 'pglite'),
    name: '@electric-sql/pglite',
    body: `
export class PGlite {
  constructor(_dir) { this.waitReady = Promise.resolve(); }
  async close() {}
}
`,
  });
  await writeEsmPkg({
    dir: join(serverDir, 'node_modules', '@electric-sql', 'pglite-socket'),
    name: '@electric-sql/pglite-socket',
    body: `
export class PGLiteSocketServer {
  constructor(_opts) {}
  async start() {}
  getServerConn() { return '127.0.0.1:${String(socketPort)}'; }
  async stop() {}
}
`,
  });
  await mkdir(join(serverDir, 'sources', 'storage'), { recursive: true });
  await writeFile(
    join(serverDir, 'sources', 'storage', 'pgliteFramedSocketServer.mjs'),
    `export class FramedPgliteSocketServer {
  constructor(_opts) {}
  async start() {}
  getServerConn() { return '127.0.0.1:${String(socketPort)}'; }
  async stop() {}
}\n`,
    'utf-8',
  );
  await writeEsmPkg({
    dir: join(serverDir, 'node_modules', '@prisma', 'client'),
    name: '@prisma/client',
    body: `
export class PrismaClient {
  constructor() { this.account = { count: async () => 0 }; }
  async $disconnect() {}
}
`,
  });
  const sqliteClientDir = join(serverDir, 'generated', 'sqlite-client');
  await mkdir(sqliteClientDir, { recursive: true });
  await writeFile(
    join(sqliteClientDir, 'index.js'),
    'export class PrismaClient { constructor() { this.account = { count: async () => 0 }; } async $disconnect() {} }\n',
    'utf-8',
  );
}

async function writePnpmShim({ root, markerPath }) {
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const pnpmPath = join(binDir, 'pnpm');
  await writeFile(
    pnpmPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) { console.log('12.14.0'); process.exit(0); }",
      `if (args[0] === 'run' && args[1] === '--silent' && args[2] === 'migrate:deploy') { fs.writeFileSync(${JSON.stringify(markerPath)}, 'ok\\n', 'utf-8'); process.exit(0); }`,
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(pnpmPath, 0o755);
  return { binDir, pnpmPath };
}

export async function createServerLightFixture(t, { prefix, serverDirRelative = 'server', socketPort }) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const serverDir = join(root, serverDirRelative);
  await mkdir(serverDir, { recursive: true });
  await writeJson(join(serverDir, 'package.json'), { name: 'server', version: '0.0.0', type: 'module' });
  await writeFile(join(serverDir, 'pnpm-lock.yaml'), '# pnpm\n', 'utf-8');
  await writeFile(join(serverDir, 'pnpm-workspace.yaml'), "packages:\n");
  await seedServerLightProbeDeps({ serverDir, socketPort });

  const markerPath = join(root, 'called-migrate-sqlite-deploy.txt');
  const pnpmShim = await writePnpmShim({ root, markerPath });

  return {
    binDir: pnpmShim.binDir,
    markerPath,
    root,
    serverDir,
    pnpmPath: pnpmShim.pnpmPath,
  };
}

export function buildServerLightEnv({ binDir, root, extraEnv = {} }) {
  const dataDir = join(root, 'data');
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
    HAPPIER_SERVER_LIGHT_FILES_DIR: join(dataDir, 'files'),
    HAPPIER_SERVER_LIGHT_DB_DIR: join(dataDir, 'pglite'),
    ...extraEnv,
  };
}
