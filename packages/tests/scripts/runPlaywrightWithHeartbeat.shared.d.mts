export function parseHeartbeatArgs(argv: readonly string[]): {
  config: string | null;
  passThrough: string[];
};

export function createPlaywrightSpawnOptions(env: NodeJS.ProcessEnv): {
  stdio: 'inherit';
  env: NodeJS.ProcessEnv;
  detached: boolean;
};

export function runHeartbeatWrappedCommand(params: {
  command: string;
  args: string[];
  config: string;
  toolName: string;
  spawnOptions: {
    stdio: 'inherit';
    env: NodeJS.ProcessEnv;
    detached: boolean;
  };
  defaultTimeoutMs?: number | null;
  resolveExitCode: (result: {
    child: unknown;
    ok: true;
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }) => number;
}): Promise<never>;

export function resolveSignalExitCode(signal: NodeJS.Signals | null): number;
