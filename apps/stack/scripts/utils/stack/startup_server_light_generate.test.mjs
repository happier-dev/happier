import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureServerLightSchemaReady } from './startup.mjs';
import { buildServerLightEnv, createServerLightFixture } from './startup_server_light_testkit.mjs';

test('ensureServerLightSchemaReady runs migrate:sqlite:deploy by default when not best-effort', async (t) => {
  const { binDir, markerPath, root, serverDir } = await createServerLightFixture(t, {
    prefix: 'hs-startup-light-migrate-',
    socketPort: 54322,
  });
  const env = buildServerLightEnv({ binDir, root });
  const res = await ensureServerLightSchemaReady({ serverDir, env });
  assert.equal(res.ok, true);
  assert.equal(res.migrated, true);
  assert.equal(res.accountCount, 0);
  assert.equal(existsSync(markerPath), true, `expected migrate:sqlite:deploy to be invoked (${markerPath})`);
});

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function writeEsmPkg({ dir, name, body }) {
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, 'package.json'), { name, type: 'module', main: './index.js' });
  await writeFile(join(dir, 'index.js'), `${body.trim()}\n`, 'utf-8');
}

async function seedServerProbeDeps(serverDir) {
  await mkdir(join(serverDir, 'node_modules'), { recursive: true });
  await writeFile(join(serverDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
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

test('ensureServerLightSchemaReady builds source server internal workspace deps before migration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-startup-light-workspace-deps-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const serverDir = join(root, 'apps', 'server');
  await mkdir(serverDir, { recursive: true });
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await writeJson(join(serverDir, 'package.json'), {
    name: '@happier-dev/server',
    version: '0.0.0',
    type: 'module',
    dependencies: {
      '@happier-dev/cli-common': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeFile(join(serverDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await seedServerProbeDeps(serverDir);

  const cliCommonDir = join(root, 'packages', 'cli-common');
  await mkdir(cliCommonDir, { recursive: true });
  await writeJson(join(cliCommonDir, 'package.json'), {
    name: '@happier-dev/cli-common',
    version: '0.0.0',
    type: 'module',
    exports: {
      './firstPartyRuntime': {
        default: './dist/firstPartyRuntime/index.js',
        types: './dist/firstPartyRuntime/index.d.ts',
      },
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });

  const binDir = join(root, 'bin');
  const markerPath = join(root, 'called-migrate-sqlite-deploy.txt');
  const buildLogPath = join(root, 'build-log.txt');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, 'yarn'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then echo "1.22.22"; exit 0; fi',
      'if [[ "${1:-}" == "-s" && "${2:-}" == "build" && "$(pwd)" == */packages/cli-common ]]; then',
      `  printf '%s\\n' 'cli-common build' >> ${JSON.stringify(buildLogPath)}`,
      '  mkdir -p dist/firstPartyRuntime',
      "  printf '%s\\n' 'export const ok = true;' > dist/firstPartyRuntime/index.js",
      "  printf '%s\\n' 'export declare const ok: boolean;' > dist/firstPartyRuntime/index.d.ts",
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "-s" && "${2:-}" == "migrate:sqlite:deploy" ]]; then',
      `  test -f ${JSON.stringify(join(cliCommonDir, 'dist', 'firstPartyRuntime', 'index.js'))}`,
      `  printf '%s\\n' 'migrated' > ${JSON.stringify(markerPath)}`,
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(join(binDir, 'yarn'), 0o755);

  const env = buildServerLightEnv({ binDir, root });
  const res = await ensureServerLightSchemaReady({ serverDir, env });

  assert.equal(res.ok, true);
  assert.equal(existsSync(markerPath), true, `expected migrate:sqlite:deploy to run after workspace deps build`);
  assert.equal(existsSync(join(cliCommonDir, 'dist', 'firstPartyRuntime', 'index.js')), true);
});
