import { describe, expect, it } from 'vitest';

import type { BackendStartupSpec, StartupContext } from './startupSpec';
import { runStartupCoordinator } from './startupCoordinator';
import { createStartupTiming } from './startupTiming';

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
  };
}

describe('runStartupCoordinator', () => {
  it('invokes spawn after preSpawn tasks without waiting for background tasks', async () => {
    const backgroundGate = createDeferred<void>();
    const spawnCalls: string[] = [];

    const ctx: StartupContext = {
      backendId: 'test',
      sessionKind: 'fresh',
      startingModeIntent: 'local',
      startedBy: 'cli',
      hasTty: true,
      workspaceDir: '/tmp',
      nowMs: () => 0,
    };

    const spec: BackendStartupSpec<{ ok: boolean }> = {
      backendId: 'test',
      createArtifacts: () => ({ ok: true }),
      tasks: [
        {
          id: 'pre',
          phase: 'preSpawn',
          run: async () => {},
        },
        {
          id: 'bg',
          phase: 'background',
          run: async () => {
            await backgroundGate.promise;
          },
        },
      ],
      spawnVendor: async () => {
        spawnCalls.push('spawn');
      },
    };

    const run = runStartupCoordinator({ ctx, spec });

    await run.whenSpawnInvoked;
    expect(spawnCalls).toEqual(['spawn']);

    backgroundGate.resolve(undefined);
    await run.backgroundPromise;
    await run.spawnPromise;
  });

  it('records vendor spawn invoked timing mark when enabled', async () => {
    const timing = createStartupTiming({ enabled: true, nowMs: () => 123 });
    const ctx: StartupContext = {
      backendId: 'test',
      sessionKind: 'fresh',
      startingModeIntent: 'local',
      startedBy: 'cli',
      hasTty: true,
      workspaceDir: '/tmp',
      nowMs: () => 0,
      timing,
    };

    const spec: BackendStartupSpec<{ ok: boolean }> = {
      backendId: 'test',
      createArtifacts: () => ({ ok: true }),
      tasks: [],
      spawnVendor: async () => {},
    };

    const run = runStartupCoordinator({ ctx, spec });
    await run.whenSpawnInvoked;

    // createStartupTiming records relative offsets from its base timestamp.
    expect(timing.getMark('vendor_spawn_invoked')).toBe(0);
    await run.spawnPromise;
  });
});
