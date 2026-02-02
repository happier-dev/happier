import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureServerLightSchemaReady } from './startup.mjs';

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

async function writeEsmPkg({ dir, name, body }) {
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, 'package.json'), { name, type: 'module', main: './index.js' });
  await writeFile(join(dir, 'index.js'), body.trim() + '\n', 'utf-8');
}

test('ensureServerLightSchemaReady runs migrate:light:deploy (pglite) when not best-effort', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-startup-light-migrate-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const serverDir = join(root, 'server');
  await mkdir(serverDir, { recursive: true });
  await writeJson(join(serverDir, 'package.json'), { name: 'server', version: '0.0.0', type: 'module' });
  await writeFile(join(serverDir, 'yarn.lock'), '# yarn\n', 'utf-8');

  // Mark deps as installed so ensureDepsInstalled doesn't attempt a real install.
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
  getServerConn() { return '127.0.0.1:54322'; }
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

  const marker = join(root, 'called-migrate-light-deploy.txt');

  // Provide a stub `yarn` in PATH so migrate:light:deploy can be observed without real dependencies.
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
      `if (args[0] === '-s' && args[1] === 'migrate:light:deploy') { fs.writeFileSync(${JSON.stringify(marker)}, 'ok\\n', 'utf-8'); process.exit(0); }`,
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);

  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${binDir}:${oldPath ?? ''}`;
    const dataDir = join(root, 'data');
    const env = {
      ...process.env,
      HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
      HAPPIER_SERVER_LIGHT_FILES_DIR: join(dataDir, 'files'),
      HAPPIER_SERVER_LIGHT_DB_DIR: join(dataDir, 'pglite'),
    };
    const res = await ensureServerLightSchemaReady({ serverDir, env });
    assert.equal(res.ok, true);
    assert.equal(res.migrated, true);
    assert.equal(res.accountCount, 0);
    assert.equal(existsSync(marker), true, `expected migrate:light:deploy to be invoked (${marker})`);
  } finally {
    process.env.PATH = oldPath;
  }
});
