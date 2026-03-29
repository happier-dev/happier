import type { SpawnOptions } from 'node:child_process';

export type ParsedMaestroArgs = {
  flows: string | null;
  appId: string | null;
  platform: string | null;
  serverUrl: string | null;
  skipAppInstallCheck: boolean;
  passThrough: string[];
};

export function parseMaestroArgs(argv: readonly string[]): ParsedMaestroArgs;

export function createMaestroSpawnOptions(env: NodeJS.ProcessEnv | undefined): SpawnOptions;

export const runHeartbeatWrappedCommand: (params: {
  toolName: string;
  config: string;
  command: string;
  args: readonly string[];
  spawnOptions: SpawnOptions;
  resolveExitCode: (result: { code: number | null; signal: NodeJS.Signals | null }) => number;
}) => Promise<void>;

export const resolveSignalExitCode: (signal: NodeJS.Signals | null) => number;
