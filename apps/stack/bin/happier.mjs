#!/usr/bin/env node

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refreshLocalBundledWorkspacePackages } from './localBundledWorkspacePreflight.mjs';

const cliRootDir = dirname(dirname(fileURLToPath(import.meta.url)));
await refreshLocalBundledWorkspacePackages(cliRootDir);

await import('../scripts/happier_main.mjs');
