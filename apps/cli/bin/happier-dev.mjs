#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { homedir } from 'os';

import { importPreparedRuntimeEntrypoint } from './_importRuntimeEntrypoint.mjs';

function buildRuntimeInvocationEnv() {
  const invokedPath = String(process.argv[1] ?? '').trim();
  const invokerName = invokedPath
    ? invokedPath.split(/[\\/]/).pop()?.replace(/\.m?js$/i, '').replace(/\.exe$/i, '').trim() ?? ''
    : '';

  return {
    ...process.env,
    ...(invokedPath ? { HAPPIER_CLI_INVOKED_PATH: invokedPath } : {}),
    ...(invokerName ? { HAPPIER_CLI_INVOKER_NAME: invokerName } : {}),
  };
}

// Check if we're already running with the flags
const hasNoWarnings = process.execArgv.includes('--no-warnings');
const hasNoDeprecation = process.execArgv.includes('--no-deprecation');
const wrapperPath = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(wrapperPath));

// Set development environment variables
if (!String(process.env.HAPPIER_HOME_DIR ?? '').trim()) {
  process.env.HAPPIER_HOME_DIR = join(homedir(), '.happier-dev');
}
process.env.HAPPIER_VARIANT = 'dev';

if (!hasNoWarnings || !hasNoDeprecation) {
  // Re-execute with the flags
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--no-deprecation',
        fileURLToPath(new URL('./_importRuntimeEntrypoint.mjs', import.meta.url)),
        wrapperPath,
        projectRoot,
        'index.mjs',
        ...process.argv.slice(2),
      ],
      {
        stdio: 'inherit',
        env: buildRuntimeInvocationEnv(),
      }
    );
    process.exit(0);
  } catch (error) {
    // Exit with the same code as the subprocess
    process.exit(error.status || 1);
  }
} else {
  // Already have the flags, import normally
  Object.assign(process.env, buildRuntimeInvocationEnv());
  await importPreparedRuntimeEntrypoint(projectRoot, 'index.mjs');
}
