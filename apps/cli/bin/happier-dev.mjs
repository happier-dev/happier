#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { homedir } from 'os';

import { prepareRuntimeEntrypoint } from './_prepareRuntimeEntrypoint.mjs';

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

// Set development environment variables
process.env.HAPPIER_HOME_DIR = join(homedir(), '.happier-dev');
process.env.HAPPIER_VARIANT = 'dev';

if (!hasNoWarnings || !hasNoDeprecation) {
  // Re-execute with the flags
  const __filename = fileURLToPath(import.meta.url);
  const projectRoot = dirname(dirname(__filename));
  const scriptPath = await prepareRuntimeEntrypoint(projectRoot, 'index.mjs');

  try {
    execFileSync(
      process.execPath,
      ['--no-warnings', '--no-deprecation', scriptPath, ...process.argv.slice(2)],
      {
        stdio: 'inherit',
        env: buildRuntimeInvocationEnv(),
      }
    );
  } catch (error) {
    // Exit with the same code as the subprocess
    process.exit(error.status || 1);
  }
} else {
  // Already have the flags, import normally
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  Object.assign(process.env, buildRuntimeInvocationEnv());
  await import(await prepareRuntimeEntrypoint(projectRoot, 'index.mjs'));
}
