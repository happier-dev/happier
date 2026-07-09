import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureServerLightSchemaReady } from './startup.mjs';
import { buildServerLightEnv, createServerLightFixture } from './startup_server_light_testkit.mjs';

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

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

test('ensureServerLightSchemaReady builds source server internal workspace dependencies before migration', async (t) => {
  const { binDir, markerPath, root, yarnPath } = await createServerLightFixture(t, {
    prefix: 'hs-startup-light-build-workspaces-',
    serverDirRelative: join('apps', 'server'),
    socketPort: 54326,
  });
  const serverDir = join(root, 'apps', 'server');
  const buildMarkerPath = join(root, 'called-cli-common-build.txt');

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/ui', private: true });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(serverDir, 'package.json'), {
    name: '@happier-dev/server',
    private: true,
    type: 'module',
    dependencies: {
      '@happier-dev/cli-common': '0.0.0',
    },
  });

  const cliCommonDir = join(root, 'packages', 'cli-common');
  await mkdir(cliCommonDir, { recursive: true });
  await writeJson(join(cliCommonDir, 'package.json'), {
    name: '@happier-dev/cli-common',
    private: true,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        default: './dist/index.js',
        types: './dist/index.d.ts',
      },
    },
    scripts: {
      build: 'tsc -p tsconfig.json',
    },
  });

  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) { console.log('1.22.22'); process.exit(0); }",
      `if (args[0] === '-s' && args[1] === 'build' && process.cwd().endsWith(path.join('packages', 'cli-common'))) {`,
      "  const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || path.join(process.cwd(), 'dist');",
      '  fs.mkdirSync(out, { recursive: true });',
      "  fs.writeFileSync(path.join(out, 'index.js'), 'export const ok = true;\\n', 'utf-8');",
      "  fs.writeFileSync(path.join(out, 'index.d.ts'), 'export declare const ok: boolean;\\n', 'utf-8');",
      `  fs.writeFileSync(${JSON.stringify(buildMarkerPath)}, 'ok\\n', 'utf-8');`,
      '  process.exit(0);',
      '}',
      `if (args[0] === '-s' && args[1] === 'migrate:sqlite:deploy') { fs.writeFileSync(${JSON.stringify(markerPath)}, 'ok\\n', 'utf-8'); process.exit(0); }`,
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);

  const env = buildServerLightEnv({ binDir, root });
  const res = await ensureServerLightSchemaReady({ serverDir, env });

  assert.equal(res.ok, true);
  assert.equal(existsSync(buildMarkerPath), true, `expected cli-common build to be invoked (${buildMarkerPath})`);
  assert.equal(existsSync(markerPath), true, `expected migrate:sqlite:deploy to be invoked (${markerPath})`);
});
