import { spawnSync } from 'node:child_process';
import { existsSync as defaultExistsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { posix, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function resolveTsxEntrypointLaunchSpec(params) {
  const cwd = params.cwd ?? process.cwd();
  const processExecPath = params.processExecPath ?? process.execPath;
  const requireResolve = params.requireResolve ?? createRequire(import.meta.url).resolve;
  const existsSync = params.existsSync ?? defaultExistsSync;
  const platform = params.platform ?? process.platform;
  const path = platform === 'win32' ? win32 : posix;

  const tsxPackageJsonPath = requireResolve('tsx/package.json');
  const tsxImportHookPath = path.join(path.dirname(tsxPackageJsonPath), 'dist', 'esm', 'index.mjs');

  if (!existsSync(tsxImportHookPath)) {
    throw new Error(`tsx import hook could not be resolved: ${tsxImportHookPath}`);
  }

  return {
    command: processExecPath,
    args: [
      '--import',
      // Node reads a bare Windows path here as a URL with scheme `c:` (testkit `toNodeImportSpecifier`).
      platform === 'win32' ? pathToFileURL(tsxImportHookPath, { windows: true }).href : tsxImportHookPath,
      path.resolve(cwd, params.entrypoint),
      ...params.args,
    ],
    env: {
      TSX_TSCONFIG_PATH: path.resolve(cwd, 'tsconfig.json'),
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
