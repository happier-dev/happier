#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

import { importPreparedRuntimeEntrypoint } from './_importRuntimeEntrypoint.mjs';

// Ensure Node flags to reduce noisy warnings on stdout (which could interfere with MCP)
const hasNoWarnings = process.execArgv.includes('--no-warnings');
const hasNoDeprecation = process.execArgv.includes('--no-deprecation');
const wrapperPath = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(wrapperPath));
const relativeEntrypoint = join('mcp', 'bridges', 'remoteMcpStdioBridge.mjs');

if (!hasNoWarnings || !hasNoDeprecation) {
  try {
    execFileSync(process.execPath, [
      '--no-warnings',
      '--no-deprecation',
      fileURLToPath(new URL('./_importRuntimeEntrypoint.mjs', import.meta.url)),
      wrapperPath,
      projectRoot,
      relativeEntrypoint,
      ...process.argv.slice(2),
    ], {
      stdio: 'inherit',
      env: process.env,
    });
    process.exit(0);
  } catch (error) {
    process.exit(error.status || 1);
  }
} else {
  // Already have desired flags; import module directly
  await importPreparedRuntimeEntrypoint(projectRoot, relativeEntrypoint);
}
