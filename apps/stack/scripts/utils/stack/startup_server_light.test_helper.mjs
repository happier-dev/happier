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
  await writeFile(join(serverDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
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
}

async function writeYarnShim({ root, markerPath }) {
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) { console.log('1.22.22'); process.exit(0); }",
      `if (args[0] === '-s' && args[1] === 'migrate:sqlite:deploy') { fs.writeFileSync(${JSON.stringify(markerPath)}, 'ok\\n', 'utf-8'); process.exit(0); }`,
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  return { binDir, yarnPath };
}

export async function createServerLightFixture(t, { prefix, socketPort }) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const serverDir = join(root, 'server');
  await mkdir(serverDir, { recursive: true });
  await writeJson(join(serverDir, 'package.json'), { name: 'server', version: '0.0.0', type: 'module' });
  await writeFile(join(serverDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await seedServerLightProbeDeps({ serverDir, socketPort });

  const markerPath = join(root, 'called-migrate-sqlite-deploy.txt');
  const yarnShim = await writeYarnShim({ root, markerPath });

  return {
    binDir: yarnShim.binDir,
    markerPath,
    root,
    serverDir,
    yarnPath: yarnShim.yarnPath,
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
