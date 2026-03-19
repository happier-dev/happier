import { describe, expect, it } from 'vitest';

import { runStartupCoordinator } from '@/agent/runtime/startup/startupCoordinator';
import type { StartupContext } from '@/agent/runtime/startup/startupSpec';

import { createClaudeStartupSpec } from './createClaudeStartupSpec';

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

describe('createClaudeStartupSpec', () => {
  it('invokes vendor spawn without awaiting background session initialization', async () => {
    const backgroundGate = createDeferred<void>();

    let sessionInitStarted = false;
    let spawned = false;

    const ctx: StartupContext = {
      backendId: 'claude',
      sessionKind: 'fresh',
      startingModeIntent: 'local',
      startedBy: 'terminal',
      hasTty: true,
      workspaceDir: '/tmp',
      nowMs: () => 0,
      timing: null,
    };

    const spec = createClaudeStartupSpec({
      deps: {
        startHookServer: async () => ({ port: 123, stop: () => {} }),
        generateHookSettingsFile: () => '/tmp/hooks.json',
        cleanupHookSettingsFile: () => {},
        registerRpcHandlers: () => {},
        initializeSessionInBackground: async () => {
          sessionInitStarted = true;
          await backgroundGate.promise;
        },
        spawnLoop: async () => {
          spawned = true;
          return 0;
        },
      },
    });

    const run = runStartupCoordinator({ ctx, spec });

    await run.whenSpawnInvoked;
    expect(spawned).toBe(true);
    expect(sessionInitStarted).toBe(true);

    backgroundGate.resolve(undefined);
    await run.backgroundPromise;
    await run.spawnPromise;
    expect(run.artifacts.exitCode).toBe(0);
  });

  it('awaits asynchronous hook settings generation before spawn', async () => {
    const hookSettingsGate = createDeferred<string>();
    let spawnObservedHookSettingsPath: string | null = null;

    const ctx: StartupContext = {
      backendId: 'claude',
      sessionKind: 'fresh',
      startingModeIntent: 'local',
      startedBy: 'terminal',
      hasTty: true,
      workspaceDir: '/tmp',
      nowMs: () => 0,
      timing: null,
    };

    const spec = createClaudeStartupSpec({
      deps: {
        startHookServer: async () => ({ port: 123, stop: () => {} }),
        generateHookSettingsFile: async () => {
          return await hookSettingsGate.promise;
        },
        cleanupHookSettingsFile: () => {},
        registerRpcHandlers: () => {},
        initializeSessionInBackground: async () => {},
        spawnLoop: async ({ artifacts }) => {
          spawnObservedHookSettingsPath = artifacts.hookSettingsPath;
          return 0;
        },
      },
    });

    const run = runStartupCoordinator({ ctx, spec });

    await Promise.resolve();
    expect(spawnObservedHookSettingsPath).toBeNull();

    hookSettingsGate.resolve('/tmp/generated-hooks.json');
    await run.whenSpawnInvoked;
    await run.backgroundPromise;
    await run.spawnPromise;

    expect(spawnObservedHookSettingsPath).toBe('/tmp/generated-hooks.json');
    expect(run.artifacts.hookSettingsPath).toBe('/tmp/generated-hooks.json');
  });
});
