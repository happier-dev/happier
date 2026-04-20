import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTsxEntrypointLaunchSpec } from './runTsxEntrypoint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');

test('resolveTsxEntrypointLaunchSpec prefers the tsx import hook path over shell-wrapper binaries', () => {
  const spec = resolveTsxEntrypointLaunchSpec({
    cwd: '/repo/packages/tests',
    entrypoint: 'src/testkit/stress/cli/stressComposeCli.ts',
    args: ['up'],
    processExecPath: '/node',
    requireResolve: (request) => {
      if (request === 'tsx/package.json') {
        return '/repo/node_modules/tsx/package.json';
      }
      throw new Error(`Unexpected request: ${request}`);
    },
    existsSync: (path) => path === '/repo/node_modules/tsx/dist/esm/index.mjs',
  });

  assert.deepEqual(spec, {
    command: '/node',
    args: [
      '--import',
      '/repo/node_modules/tsx/dist/esm/index.mjs',
      '/repo/packages/tests/src/testkit/stress/cli/stressComposeCli.ts',
      'up',
    ],
    env: {
      TSX_TSCONFIG_PATH: '/repo/packages/tests/tsconfig.json',
    },
  });
});

test('packages/tests stress compose scripts use the node-safe tsx entrypoint runner', async () => {
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));

  assert.match(
    String(packageJson?.scripts?.['stress:compose:up'] ?? ''),
    /node scripts\/runTsxEntrypoint\.mjs src\/testkit\/stress\/cli\/stressComposeCli\.ts up$/,
  );
  assert.match(
    String(packageJson?.scripts?.['stress:compose:down'] ?? ''),
    /node scripts\/runTsxEntrypoint\.mjs src\/testkit\/stress\/cli\/stressComposeCli\.ts down$/,
  );
  assert.match(
    String(packageJson?.scripts?.['stress:compose:status'] ?? ''),
    /node scripts\/runTsxEntrypoint\.mjs src\/testkit\/stress\/cli\/stressComposeCli\.ts status$/,
  );

  for (const key of ['stress:compose:up', 'stress:compose:down', 'stress:compose:status']) {
    assert.doesNotMatch(String(packageJson?.scripts?.[key] ?? ''), /\btsx\b/);
  }

  assert.match(
    String(packageJson?.scripts?.['test:scripts:self'] ?? ''),
    /\bnode --test\b.*\bscripts\/runTsxEntrypoint\.test\.mjs\b/,
    'expected the script self-test lane to include runTsxEntrypoint.test.mjs',
  );
  assert.match(
    String(packageJson?.scripts?.test ?? ''),
    /\btest:scripts:self\b/,
    'expected the default package test lane to include the script self-test lane',
  );
});
