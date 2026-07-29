import { join, resolve } from 'node:path';

import { coerceHappyMonorepoRootFromPath } from '../../apps/stack/scripts/utils/paths/paths.mjs';

export function workspacePackageBuildLockSlug(packageDir, packageJson) {
  const raw = String(packageJson?.name ?? '').trim() || resolve(packageDir);
  const slug = raw.replace(/^@/, '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'workspace-package';
}

export function resolveWorkspacePackageBuildLockPath(packageDir, packageJson) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(packageDir);
  const slug = workspacePackageBuildLockSlug(packageDir, packageJson);
  if (monorepoRoot) {
    return join(monorepoRoot, '.project', 'tmp', 'workspace-dist-builds', `${slug}.lock`);
  }
  return join(packageDir, `.dist-build-${slug}.lock`);
}
