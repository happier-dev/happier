#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const entrypoint = join(rootDir, 'dist', 'bin', 'hsetup.js');

if (!existsSync(entrypoint)) {
  throw new Error(`Bootstrap packaged entrypoint is missing: ${entrypoint}`);
} else {
  const moduleExports = await import(pathToFileURL(entrypoint).href);

  if (typeof moduleExports.runHsetupCli !== 'function') {
    throw new Error('dist/bin/hsetup.js does not export runHsetupCli');
  }

  const exitCode = await moduleExports.runHsetupCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
