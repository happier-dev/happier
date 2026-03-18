import { existsSync as defaultExistsSync } from 'node:fs';
import { join, resolve } from 'node:path';

function normalizeAbsolutePath(raw) {
  const value = String(raw ?? '').trim();
  return value ? resolve(value) : '';
}

export function readBundledWorkspaceSyncConfig({ snapshot, existsSync = defaultExistsSync } = {}) {
  const runtimeRoot = normalizeAbsolutePath(snapshot?.launchPath ?? snapshot?.snapshotPath);
  const repoRoot = normalizeAbsolutePath(snapshot?.manifest?.source?.repoDir);
  if (!runtimeRoot || !repoRoot) {
    return null;
  }

  const helperPath = resolve(repoRoot, 'scripts', 'workspaces', 'syncBundledWorkspacePackages.mjs');
  if (!existsSync(helperPath)) {
    return null;
  }

  return {
    repoRoot,
    helperPath,
    targetPackageRoot: join(runtimeRoot, 'cli'),
  };
}
