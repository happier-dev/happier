export const WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR =
  'HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY';

export function createWorkspaceChildBuildEnv({ env = process.env, heldLockValue } = {}) {
  const childEnv = { ...env };
  // This path belongs to the package whose lifecycle script is currently running. Passing it to a
  // dependency build makes unrelated workspaces overwrite the parent's staged output directory.
  // Environment names are case-insensitive on Windows, so clear every output and lease alias before
  // selectively installing the current canonical lease below.
  const clearedNames = new Set([
    'HAPPIER_WORKSPACE_DIST_OUTPUT_DIR',
    'HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD',
    WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR,
  ].map((name) => name.toLowerCase()));
  for (const name of Object.keys(childEnv)) {
    if (clearedNames.has(name.toLowerCase())) {
      delete childEnv[name];
    }
  }

  const normalizedHeldLockValue = String(heldLockValue ?? '').trim();
  if (normalizedHeldLockValue) {
    childEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD = normalizedHeldLockValue;
  }
  return childEnv;
}
