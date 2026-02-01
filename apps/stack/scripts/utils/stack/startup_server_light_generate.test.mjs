import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ensureServerLightSchemaReady } from './startup.mjs';

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

test('ensureServerLightSchemaReady runs prisma generate when unified sqlite client is missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-startup-sqlite-generate-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const serverDir = join(root, 'server');
  await mkdir(serverDir, { recursive: true });
  await writeJson(join(serverDir, 'package.json'), { name: 'server', version: '0.0.0' });
  await writeFile(join(serverDir, 'yarn.lock'), '# yarn\n', 'utf-8');

  // Mark deps as installed so ensureDepsInstalled doesn't attempt a real install.
  await mkdir(join(serverDir, 'node_modules'), { recursive: true });
  await writeFile(join(serverDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  // Unified light detection + expected schema path.
  await mkdir(join(serverDir, 'prisma', 'sqlite'), { recursive: true });
  await writeFile(join(serverDir, 'prisma', 'sqlite', 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');

  // generated/sqlite-client exists, but the entrypoint is missing (this triggers ERR_MODULE_NOT_FOUND).
  await mkdir(join(serverDir, 'generated', 'sqlite-client'), { recursive: true });

  // Provide a stub `yarn` in PATH so pmExecBin("prisma", ...) succeeds without real dependencies.
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      "const { writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const cwd = process.cwd();',
      'const out = join(cwd, "generated", "sqlite-client", "index.js");',
      'const text = [',
      "  'export class PrismaClient {',",
      "  '  constructor() { this.account = { count: async () => 0 }; }',",
      "  '  async $disconnect() {}',",
      "  '}',",
      "].join('\\n') + '\\n';",
      'writeFileSync(out, text, "utf-8");',
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);

  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${binDir}:${oldPath ?? ''}`;
    const res = await ensureServerLightSchemaReady({ serverDir, env: process.env });
    assert.equal(res.ok, true);
    assert.equal(res.migrated, true);
    assert.equal(res.accountCount, 0);
  } finally {
    process.env.PATH = oldPath;
  }
});
