export function createWorkspaceChildBuildEnv(options?: {
  env?: Record<string, string | undefined>;
  heldLockValue?: unknown;
}): Record<string, string | undefined>;
export const WORKSPACE_BUILD_MODE_ENV: 'HAPPIER_WORKSPACE_BUILD_MODE';
export function resolveWorkspaceBuildMode(options?: {
  buildMode?: string;
  env?: Record<string, string | undefined>;
}): 'strict' | 'qa-runtime' | 'source-dev';
