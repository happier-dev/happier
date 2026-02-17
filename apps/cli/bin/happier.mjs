#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { existsSync } from 'fs';

function preflightRequiredDependencies(projectRoot) {
  const protocolPackageJsonPath = join(projectRoot, 'node_modules', '@happier-dev', 'protocol', 'package.json');
  if (!existsSync(protocolPackageJsonPath)) {
    console.error('Missing bundled package: @happier-dev/protocol');
    console.error('Reinstall @happier-dev/cli to repair your installation.');
    process.exit(1);
  }
  const require = createRequire(protocolPackageJsonPath);
  const required = ['tweetnacl', 'base64-js', '@noble/hashes/hmac', '@noble/hashes/sha512'];

  for (const dep of required) {
    try {
      require.resolve(dep);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'MODULE_NOT_FOUND') {
        console.error(`Missing required dependency: ${dep}`);
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
