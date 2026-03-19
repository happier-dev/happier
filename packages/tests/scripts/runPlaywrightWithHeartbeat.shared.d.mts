export function parseHeartbeatArgs(argv: readonly string[]): {
  config: string | null;
  passThrough: string[];
};

export function createPlaywrightSpawnOptions(env: NodeJS.ProcessEnv): {
  stdio: 'inherit';
  env: NodeJS.ProcessEnv;
  detached: boolean;
};

export function resolveSignalExitCode(signal: NodeJS.Signals | null): number;
