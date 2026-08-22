import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRunDirs, type RunDirs } from '../../runDir';
import { repoRootDir } from '../../paths';
import { readStressConfig } from '../config/readStressConfig';
import { createComposeRuntime, type ComposeRuntime } from '../docker/composeRuntime';
import {
  preflightFullComposeFrozenImage,
  startFullComposeStressTarget,
} from '../targets/startFullComposeStressTarget';
import type { StartedStressTarget, StartStressTargetParams } from '../targets/stressTargetTypes';
import {
  latestComposeStatePath,
  markComposeStateStopped,
  readLatestComposeState,
  readLatestComposeStateIfExists,
  writeLatestComposeState,
  type LatestComposeState,
  type LatestComposeStateStatus,
} from './latestComposeState';

export type StressComposeCli = Readonly<{
  up: () => Promise<LatestComposeState>;
  down: () => Promise<
    Readonly<{
      stopped: true;
      composeProjectName: string;
      status: LatestComposeStateStatus;
    }>
  >;
  status: () => Promise<LatestComposeState>;
}>;

type StressComposeCliDeps = Readonly<{
  createRunDirs: (opts?: { runLabel?: string; logsDir?: string }) => RunDirs;
  latestComposeStatePath: () => string;
  readStressConfig: () => ReturnType<typeof readStressConfig>;
  preflightFullComposeFrozenImage: typeof preflightFullComposeFrozenImage;
  startFullComposeStressTarget: (params: StartStressTargetParams) => Promise<StartedStressTarget>;
  createComposeRuntime: (params: {
    composeFilePath: string;
    composeProjectName: string;
    cwd: string;
  }) => Pick<ComposeRuntime, 'down' | 'imageExists' | 'inspectImage'>;
  repoRootDir: () => string;
  now: () => string;
}>;

const defaultDeps: StressComposeCliDeps = {
  createRunDirs,
  latestComposeStatePath,
  readStressConfig,
  preflightFullComposeFrozenImage,
  startFullComposeStressTarget,
  createComposeRuntime,
  repoRootDir,
  now: () => new Date().toISOString(),
};

function createLatestComposeState(target: StartedStressTarget, currentRepoRootDir: string): LatestComposeState {
  if (!target.topology.composeProjectName || !target.artifacts?.composeFile) {
    throw new Error('Full compose target did not expose compose metadata');
  }

  return {
    baseUrl: target.baseUrl,
    composeProjectName: target.topology.composeProjectName,
    composeFilePath: target.artifacts.composeFile,
    gatewayConfigFile: target.artifacts.gatewayConfigFile,
    generatedEnvFile: target.artifacts.generatedEnvFile,
    dockerLogsFile: target.artifacts.dockerLogsFile,
    repoRootDir: currentRepoRootDir,
    status: 'running',
    preserved: false,
  };
}

async function stopComposeProject(
  state: LatestComposeState,
  deps: Pick<StressComposeCliDeps, 'createComposeRuntime'>,
): Promise<void> {
  const runtime = deps.createComposeRuntime({
    composeFilePath: state.composeFilePath,
    composeProjectName: state.composeProjectName,
    cwd: state.repoRootDir,
  });
  await runtime.down();
}

export function createStressComposeCli(overrides: Partial<StressComposeCliDeps> = {}): StressComposeCli {
  const deps = {
    ...defaultDeps,
    ...overrides,
  } satisfies StressComposeCliDeps;

  return {
    up: async () => {
      const config = deps.readStressConfig();
      const statePath = deps.latestComposeStatePath();
      const previousState = readLatestComposeStateIfExists(statePath);
      if (previousState && previousState.status === 'running' && !previousState.preserved) {
        const previousRuntime = deps.createComposeRuntime({
          composeFilePath: previousState.composeFilePath,
          composeProjectName: previousState.composeProjectName,
          cwd: previousState.repoRootDir,
        });
        await deps.preflightFullComposeFrozenImage({
          config,
          repoRootDir: deps.repoRootDir(),
          runtime: previousRuntime,
        });
        await previousRuntime.down();
        writeLatestComposeState(statePath, markComposeStateStopped(previousState, deps.now()));
      }

      const run = deps.createRunDirs({ runLabel: 'stress' });
      const target = await deps.startFullComposeStressTarget({
        config: {
          ...config,
          targetMode: 'full-compose',
        },
        testDir: run.testDir('compose-topology'),
      });

      const state = createLatestComposeState(target, deps.repoRootDir());
      writeLatestComposeState(statePath, state);
      return state;
    },
    down: async () => {
      const statePath = deps.latestComposeStatePath();
      const state = readLatestComposeState(statePath);
      if (state.status === 'running') {
        await stopComposeProject(state, deps);
      }

      const nextState = markComposeStateStopped(state, deps.now());
      writeLatestComposeState(statePath, nextState);
      return {
        stopped: true,
        composeProjectName: state.composeProjectName,
        status: nextState.status,
      };
    },
    status: async () => {
      return readLatestComposeState(deps.latestComposeStatePath());
    },
  };
}

async function main(): Promise<void> {
  const cli = createStressComposeCli();
  const command = process.argv[2];
  if (command === 'up') {
    process.stdout.write(`${JSON.stringify(await cli.up(), null, 2)}\n`);
    return;
  }
  if (command === 'down') {
    process.stdout.write(`${JSON.stringify(await cli.down(), null, 2)}\n`);
    return;
  }
  if (command === 'status') {
    process.stdout.write(`${JSON.stringify(await cli.status(), null, 2)}\n`);
    return;
  }

  throw new Error('Usage: tsx src/testkit/stress/cli/stressComposeCli.ts <up|down|status>');
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectExecution()) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
