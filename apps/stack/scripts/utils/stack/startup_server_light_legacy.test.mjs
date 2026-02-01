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

test('ensureServerLightSchemaReady does not run prisma migrate deploy for legacy happy-server-light checkouts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-startup-sqlite-legacy-'));
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

  // Legacy checkout: no prisma/sqlite/schema.prisma and no prisma/schema.sqlite.prisma.
  // Provide a minimal node_modules @prisma/client so probeAccountCount can succeed.
  await mkdir(join(serverDir, 'node_modules', '@prisma', 'client'), { recursive: true });
  await writeJson(join(serverDir, 'node_modules', '@prisma', 'client', 'package.json'), {
    name: '@prisma/client',
    type: 'module',
    main: './index.js',
  });
  await writeFile(
    join(serverDir, 'node_modules', '@prisma', 'client', 'index.js'),
    [
      'export class PrismaClient {',
      '  constructor() { this.account = { count: async () => 0 }; }',
      '  async $disconnect() {}',
      '}',
    ].join('\n') + '\n',
    'utf-8'
  );

  const marker = join(root, 'called-prisma.txt');

  // Provide a stub `yarn` so ensureYarnReady + pmExecBin are controllable.
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      // ensureYarnReady calls: yarn --version
      "if (args.includes('--version')) { console.log('1.22.22'); process.exit(0); }",
      // pmExecBin calls: yarn run prisma ...
      "if (args[0] === 'run' && args[1] === 'prisma') {",
      `  fs.writeFileSync(${JSON.stringify(marker)}, args.join(' ') + '\\n', 'utf-8');`,
      '  process.exit(0);',
      '}',
      "console.log('ok');",
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    DATABASE_URL: `file:${join(root, 'happy-server-light.sqlite')}`,
  };

  const res = await ensureServerLightSchemaReady({ serverDir, env });
  assert.equal(res.ok, true);
  assert.equal(res.migrated, false);
  assert.equal(res.accountCount, 0);

  assert.equal(existsSync(marker), false, `expected no prisma migrate deploy call, but saw: ${marker}`);
});

