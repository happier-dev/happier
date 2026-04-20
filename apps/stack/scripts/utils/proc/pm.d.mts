export type WorkspaceBuildResult = {
  ok: boolean;
  built: string[];
  skipped: string[];
};

export function ensureWorkspacePackagesBuiltForComponent(
  componentDir: string,
  options?: {
    quiet?: boolean;
    env?: NodeJS.ProcessEnv;
  },
): Promise<WorkspaceBuildResult>;

export function isCliDistBuildLockActive(
  lockPath: string,
  options?: {
    staleAfterMs?: number;
    nowMs?: number;
  },
): boolean;
