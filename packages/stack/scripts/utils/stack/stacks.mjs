import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getLegacyStorageRoot, getStacksStorageRoot } from '../paths/paths.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from '../env/sandbox.mjs';
import { resolveStackEnvPath } from '../paths/paths.mjs';

export async function listAllStackNames() {
  const names = new Set(['main']);
  const allowLegacy = !isSandboxed() || sandboxAllowsGlobalSideEffects();
  const roots = [
    // New layout: ~/.happy/stacks/<name>/env
    getStacksStorageRoot(),
    // Legacy layout: ~/.happy/local/stacks/<name>/env
    ...(allowLegacy ? [join(getLegacyStorageRoot(), 'stacks')] : []),
  ];

  for (const root of roots) {
    let entries = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      if (!name || name.startsWith('.')) continue;
      const envPath = join(root, name, 'env');
      if (existsSync(envPath)) {
        names.add(name);
      }
    }
  }

  return Array.from(names).sort();
}

export function stackExistsSync(stackName) {
  const name = String(stackName ?? '').trim() || 'main';
  if (name === 'main') return true;
  return existsSync(resolveStackEnvPath(name).envPath);
}
