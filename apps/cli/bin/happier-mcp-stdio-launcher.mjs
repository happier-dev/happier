#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

import { prepareRuntimeEntrypoint } from './_prepareRuntimeEntrypoint.mjs';

const hasNoWarnings = process.execArgv.includes('--no-warnings');
const hasNoDeprecation = process.execArgv.includes('--no-deprecation');

if (!hasNoWarnings || !hasNoDeprecation) {
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const entrypoint = await prepareRuntimeEntrypoint(projectRoot, join('mcp', 'launchers', 'stdioMcpServerLauncher.mjs'));

  try {
    execFileSync(process.execPath, [
      '--no-warnings',
      '--no-deprecation',
      entrypoint,
      ...process.argv.slice(2),
    ], {
      stdio: 'inherit',
      env: process.env,
    });
  } catch (error) {
    process.exit(error.status || 1);
  }
} else {
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  import(await prepareRuntimeEntrypoint(projectRoot, join('mcp', 'launchers', 'stdioMcpServerLauncher.mjs')));
}
