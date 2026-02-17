import { describe, expect, it } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

describe('resolveSpawnChildEnvironment (connected services)', () => {
  it('injects connected service materialization env when provided', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: { XDG_DATA_HOME: '/tmp/xdg' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expandedEnvironmentVariables.XDG_DATA_HOME).toBe('/tmp/xdg');
    }
  });

  it('keeps connected service cleanup hooks even when token auth is used', async () => {
    const connectedCleanups: string[] = [];
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
      token: 'token-123',
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: { XDG_DATA_HOME: '/tmp/xdg' },
        cleanupOnFailure: () => connectedCleanups.push('failure'),
        cleanupOnExit: () => connectedCleanups.push('exit'),
      },
    });

    expect(result.ok).toBe(true);
    expect(result.cleanupOnExit).not.toBeNull();
    result.cleanupOnExit?.();
    expect(connectedCleanups).toEqual(['exit']);
  });
});
