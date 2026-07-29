export function createWorkspaceChildBuildEnv(options?: {
  env?: Record<string, string | undefined>;
  heldLockValue?: unknown;
}): Record<string, string | undefined>;
