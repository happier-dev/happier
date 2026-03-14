import { existsSync as defaultExistsSync } from 'node:fs';
import { resolve } from 'node:path';

export function resolveBundledWorkspaceSyncModulePath(cliRootDir, { existsSync = defaultExistsSync } = {}) {
  const cliRoot = String(cliRootDir ?? '').trim();
  if (!cliRoot) return null;

  const candidate = resolve(cliRoot, '..', '..', 'scripts', 'workspaces', 'syncBundledWorkspacePackages.mjs');
  return existsSync(candidate) ? candidate : null;
}
