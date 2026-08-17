export type WorkspaceBuildResult = {
  ok: boolean;
  built: string[];
  skipped: string[];
};

export function ensureWorkspacePackagesBuiltByName(
  monorepoPath: string,
  packageNames: string[],
  options?: {
    quiet?: boolean;
    env?: NodeJS.ProcessEnv;
    force?: boolean;
    publicationMode?: 'live' | 'artifact';
  },
): Promise<WorkspaceBuildResult>;

export function ensureWorkspacePackagesBuiltForComponent(
  componentDir: string,
  options?: {
    quiet?: boolean;
    env?: NodeJS.ProcessEnv;
    publicationMode?: 'live' | 'artifact';
  },
): Promise<WorkspaceBuildResult>;

export function isCliDistBuildLockActive(
  lockPath: string,
  options?: {
    staleAfterMs?: number;
    nowMs?: number;
  },
): boolean;
