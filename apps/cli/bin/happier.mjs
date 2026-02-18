#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { createRequire } from 'module';

function preflightRequiredDependencies(projectRoot) {
  const cliRequire = createRequire(import.meta.url);
  let protocolEntryPath;
  try {
    protocolEntryPath = cliRequire.resolve('@happier-dev/protocol');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')
    ) {
      console.error('Missing bundled package: @happier-dev/protocol');
      console.error('Reinstall @happier-dev/cli to repair your installation.');
      process.exit(1);
    }
    throw error;
  }

  const protocolRequire = createRequire(protocolEntryPath);

  // `tweetnacl` is a direct runtime dependency of the CLI.
  // `base64-js` and `@noble/hashes/*` are runtime dependencies of `@happier-dev/protocol` and may be
  // vendored under the bundled protocol package's node_modules when installed via `npm`.
  const required = [
    { name: 'tweetnacl', resolveWith: cliRequire },
    { name: 'base64-js', resolveWith: protocolRequire },
    { name: '@noble/hashes/hmac', resolveWith: protocolRequire },
    { name: '@noble/hashes/sha512', resolveWith: protocolRequire },
  ];

  for (const dep of required) {
    try {
      dep.resolveWith.resolve(dep.name);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'MODULE_NOT_FOUND') {
        console.error(`Missing required dependency: ${dep.name}`);
        console.error('Reinstall @happier-dev/cli to repair your installation.');
        process.exit(1);
      }
      throw error;
    }
  }
}

// Check if we're already running with the flags
const hasNoWarnings = process.execArgv.includes('--no-warnings');
const hasNoDeprecation = process.execArgv.includes('--no-deprecation');

if (!hasNoWarnings || !hasNoDeprecation) {
  // Get path to the actual CLI entrypoint
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  preflightRequiredDependencies(projectRoot);
  const entrypoint = join(projectRoot, 'dist', 'index.mjs');
  
  // Execute the actual CLI directly with the correct flags
  try {
    execFileSync(process.execPath, [
      '--no-warnings',
      '--no-deprecation',
      entrypoint,
      ...process.argv.slice(2)
    ], {
      stdio: 'inherit',
      env: process.env
    });
  } catch (error) {
    // execFileSync throws if the process exits with non-zero
    process.exit(error.status || 1);
  }
} else {
  // We're running Node with the flags we wanted, import the CLI entrypoint
  // module to avoid creating a new process.
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  preflightRequiredDependencies(projectRoot);
  import("../dist/index.mjs");
}
