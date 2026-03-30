#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const entrypoint = join(rootDir, 'dist', 'bin', 'hsetup.js');

if (!existsSync(entrypoint)) {
  runSourceFallback();
} else {
  try {
    const moduleExports = await import(pathToFileURL(entrypoint).href);

    if (typeof moduleExports.runHsetupCli !== 'function') {
      throw new Error('dist/bin/hsetup.js does not export runHsetupCli');
    }

    const exitCode = await moduleExports.runHsetupCli(process.argv.slice(2));
    process.exitCode = exitCode;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code ?? '') : '';
    if (code !== 'ERR_MODULE_NOT_FOUND') {
      throw error;
    }
    runSourceFallback();
  }
}

function runSourceFallback() {
  const tsxCliPath = join(rootDir, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const sourceEntrypoint = join(rootDir, 'src', 'bin', 'hsetup.ts');
  const result = spawnSync(process.execPath, [tsxCliPath, sourceEntrypoint, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
