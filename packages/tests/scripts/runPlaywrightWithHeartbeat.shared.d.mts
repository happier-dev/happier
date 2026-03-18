export type HeartbeatArgs = {
  config: string | null;
  passThrough: string[];
};

export type RunHeartbeatCommandParams = {
  childArgs: string[];
  env: NodeJS.ProcessEnv;
  heartbeatMs: number;
  label: string;
  startupLabel: string;
};

export function parseHeartbeatArgs(argv: string[]): HeartbeatArgs;
export function resolveHeartbeatMs(raw: unknown): number;
export function runHeartbeatCommand(params: RunHeartbeatCommandParams): Promise<number>;
