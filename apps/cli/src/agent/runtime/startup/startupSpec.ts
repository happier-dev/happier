export type StartupSessionKind = 'fresh' | 'attach' | 'resume';
export type StartupModeIntent = 'local' | 'remote';
export type StartupTaskPhase = 'preSpawn' | 'background';

export type StartupTiming = Readonly<{
  enabled: boolean;
  mark: (id: string) => void;
  getMark: (id: string) => number | null;
  startSpan: (id: string) => () => void;
  getSpan: (id: string) => { startMs: number; endMs: number } | null;
  formatSummaryLine: (opts?: { prefix?: string; includeIds?: ReadonlyArray<string> }) => string;
}>;

export type StartupContext = Readonly<{
  backendId: string;
  sessionKind: StartupSessionKind;
  startingModeIntent: StartupModeIntent;
  startedBy: 'terminal' | 'daemon' | 'cli';
  hasTty: boolean;
  workspaceDir: string;
  nowMs: () => number;
  timing?: StartupTiming | null;
}>;

export type StartupTask<TArtifacts> = Readonly<{
  id: string;
  phase: StartupTaskPhase;
  run: (args: { ctx: StartupContext; artifacts: TArtifacts; signal: AbortSignal }) => Promise<void>;
}>;

export type BackendStartupSpec<TArtifacts> = Readonly<{
  backendId: string;
  createArtifacts: () => TArtifacts;
  tasks: ReadonlyArray<StartupTask<TArtifacts>>;
  spawnVendor: (args: { ctx: StartupContext; artifacts: TArtifacts; signal: AbortSignal }) => Promise<void>;
}>;
