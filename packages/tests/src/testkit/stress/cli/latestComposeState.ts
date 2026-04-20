import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { projectLogsDir } from '../../paths';

export type LatestComposeStateStatus = 'running' | 'stopped';

export type LatestComposeState = Readonly<{
  baseUrl: string;
  composeProjectName: string;
  composeFilePath: string;
  gatewayConfigFile?: string;
  generatedEnvFile?: string;
  dockerLogsFile?: string;
  dockerPsFile?: string;
  repoRootDir: string;
  status: LatestComposeStateStatus;
  preserved: boolean;
  stoppedAt?: string;
}>;

type LatestComposeStateDiskShape = Partial<LatestComposeState> &
  Readonly<{
    baseUrl: string;
    composeProjectName: string;
    composeFilePath: string;
    repoRootDir: string;
  }>;

export function latestComposeStatePath(): string {
  return resolve(projectLogsDir(), 'stress', 'latest-full-compose.json');
}

export function normalizeLatestComposeState(state: LatestComposeStateDiskShape): LatestComposeState {
  return {
    baseUrl: state.baseUrl,
    composeProjectName: state.composeProjectName,
    composeFilePath: state.composeFilePath,
    gatewayConfigFile: state.gatewayConfigFile,
    generatedEnvFile: state.generatedEnvFile,
    dockerLogsFile: state.dockerLogsFile,
    dockerPsFile: state.dockerPsFile,
    repoRootDir: state.repoRootDir,
    status: state.status === 'stopped' ? 'stopped' : 'running',
    preserved: state.preserved === true,
    stoppedAt: typeof state.stoppedAt === 'string' ? state.stoppedAt : undefined,
  };
}

export function writeLatestComposeState(path: string, state: LatestComposeState): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return path;
}

export function readLatestComposeState(path: string): LatestComposeState {
  return normalizeLatestComposeState(JSON.parse(readFileSync(path, 'utf8')) as LatestComposeStateDiskShape);
}

export function readLatestComposeStateIfExists(path: string): LatestComposeState | null {
  try {
    return readLatestComposeState(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function markComposeStateStopped(state: LatestComposeState, stoppedAt: string): LatestComposeState {
  return {
    ...state,
    status: 'stopped',
    stoppedAt,
  };
}
