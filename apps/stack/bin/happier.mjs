#!/usr/bin/env node

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refreshLocalBundledWorkspacePackages } from './localBundledWorkspacePreflight.mjs';

const cliRootDir = dirname(dirname(fileURLToPath(import.meta.url)));
await refreshLocalBundledWorkspacePackages(cliRootDir, { argv: process.argv.slice(2) });

await import('../scripts/happier_main.mjs');
