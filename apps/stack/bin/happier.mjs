#!/usr/bin/env node

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refreshLocalBundledWorkspacePackages } from './localBundledWorkspacePreflight.mjs';

const cliRootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const separatorIndex = argv.indexOf('--');
const wrapperArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
const runtimeRequested = !wrapperArgs.includes('--source') && (
  wrapperArgs.includes('--runtime')
  || String(process.env.HAPPIER_STACK_RUNTIME_MODE ?? '').trim().toLowerCase() === 'require'
);
if (!runtimeRequested) {
  await refreshLocalBundledWorkspacePackages(cliRootDir, { argv });
}

await import('../scripts/happier_main.mjs');
