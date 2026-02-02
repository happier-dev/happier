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

test('ensureServerLightSchemaReady creates stack sqlite data dirs before probing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-startup-sqlite-dirs-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const serverDir = join(root, 'server');
  await mkdir(serverDir, { recursive: true });
  await writeJson(join(serverDir, 'package.json'), { name: 'server', version: '0.0.0' });
  await writeFile(join(serverDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(serverDir, 'node_modules'), { recursive: true });
  await writeFile(join(serverDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  await mkdir(join(serverDir, 'prisma', 'sqlite'), { recursive: true });
  await writeFile(join(serverDir, 'prisma', 'sqlite', 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');

  // Provide the generated client so we don't need to run prisma generate in this test.
  await mkdir(join(serverDir, 'generated', 'sqlite-client'), { recursive: true });
  await writeFile(
    join(serverDir, 'generated', 'sqlite-client', 'index.js'),
    ['export class PrismaClient {', '  constructor() { this.account = { count: async () => 0 }; }', '  async $disconnect() {}', '}'].join('\n') +
      '\n',
    'utf-8'
  );

  // Minimal stub `yarn` so commandExists('yarn') succeeds.
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(yarnPath, ['#!/usr/bin/env node', "console.log('1.22.22');"].join('\n') + '\n', 'utf-8');
  await chmod(yarnPath, 0o755);

  const dataDir = join(root, 'data');
  const filesDir = join(dataDir, 'files');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
    HAPPIER_SERVER_LIGHT_FILES_DIR: filesDir,
    DATABASE_URL: `file:${join(dataDir, 'happier-server-light.sqlite')}`,
  };

  assert.equal(existsSync(dataDir), false);
  assert.equal(existsSync(filesDir), false);

  await ensureServerLightSchemaReady({ serverDir, env });

  assert.equal(existsSync(dataDir), true);
  assert.equal(existsSync(filesDir), true);
});
