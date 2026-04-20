import { spawnSync } from 'node:child_process';
import { existsSync as defaultExistsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveTsxEntrypointLaunchSpec(params) {
  const cwd = params.cwd ?? process.cwd();
  const processExecPath = params.processExecPath ?? process.execPath;
  const requireResolve = params.requireResolve ?? createRequire(import.meta.url).resolve;
  const existsSync = params.existsSync ?? defaultExistsSync;

  const tsxPackageJsonPath = requireResolve('tsx/package.json');
  const tsxPackageDir = dirname(tsxPackageJsonPath);
  const tsxImportHookPath = join(tsxPackageDir, 'dist', 'esm', 'index.mjs');

  if (!existsSync(tsxImportHookPath)) {
    throw new Error(`tsx import hook could not be resolved: ${tsxImportHookPath}`);
  }

  return {
    command: processExecPath,
    args: [
      '--import',
      tsxImportHookPath,
      resolve(cwd, params.entrypoint),
      ...params.args,
    ],
    env: {
      TSX_TSCONFIG_PATH: resolve(cwd, 'tsconfig.json'),
    },
  };
}

function main() {
  const [entrypoint, ...args] = process.argv.slice(2);
  if (!entrypoint) {
    throw new Error('Usage: node scripts/runTsxEntrypoint.mjs <entrypoint.ts> [...args]');
  }

  const spec = resolveTsxEntrypointLaunchSpec({
    cwd: process.cwd(),
    entrypoint,
    args,
  });

  const result = spawnSync(spec.command, spec.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...spec.env,
    },
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

const currentFilePath = fileURLToPath(import.meta.url);
const entrypointPath = process.argv[1] ? resolve(process.argv[1]) : '';

if (entrypointPath === currentFilePath) {
  main();
}
