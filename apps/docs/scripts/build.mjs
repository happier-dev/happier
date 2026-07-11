import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execYarn } from '../../../scripts/workspaces/execYarnCommand.mjs';

const require = createRequire(import.meta.url);
const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveNextCliPath() {
  return require.resolve('next/dist/bin/next');
}

export function runDocsBuild({
  packageRoot = defaultPackageRoot,
  processExecPath = process.execPath,
  execYarnImpl = execYarn,
  resolveNextCliPathImpl = resolveNextCliPath,
  spawnSyncImpl = spawnSync,
} = {}) {
  execYarnImpl(['-s', 'types:check'], { cwd: packageRoot, stdio: 'inherit' });
  const result = spawnSyncImpl(
    processExecPath,
    [resolveNextCliPathImpl(), 'build', '--webpack'],
    { cwd: packageRoot, env: process.env, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`Next build failed with code ${result.status ?? 'unknown'}`);
  }
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntrypoint) runDocsBuild();
