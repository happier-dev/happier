export const WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR =
  'HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY';
export const WORKSPACE_BUILD_MODE_ENV = 'HAPPIER_WORKSPACE_BUILD_MODE';
export const WORKSPACE_DIST_CHECK_ONLY_ENV = 'HAPPIER_WORKSPACE_DIST_CHECK_ONLY';

// Source-dev and QA/runtime package builds emit from captured inputs.
// Both retain coherent last-green output; strict mode requires checked output.
// Publication lifecycle entrypoints always force strict compilation.
export function resolveWorkspaceBuildMode({ buildMode, env = {} } = {}) {
  if (/^(?:prepack|pack|publish|prepublishOnly)$/.test(String(env.npm_lifecycle_event ?? ''))) return 'strict';
  const mode = buildMode ?? env[WORKSPACE_BUILD_MODE_ENV] ?? 'strict';
  if (mode !== 'strict' && mode !== 'qa-runtime' && mode !== 'source-dev') throw new Error(`[workspace-build] invalid build mode: ${mode}`);
  return mode;
}

export function resolveWorkspaceTypeScriptCompilerArgs({ compilerArgs = [], env = {}, checkOnly = false } = {}) {
  const buildMode = resolveWorkspaceBuildMode({ env });
  return [
    ...compilerArgs,
    ...(buildMode !== 'strict' ? ['--noCheck', '--incremental'] : []),
    ...(checkOnly ? ['--noEmit', '--incremental'] : []),
    ...(buildMode === 'strict' ? ['--noCheck', 'false'] : []),
  ];
}

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
    WORKSPACE_DIST_CHECK_ONLY_ENV,
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
