import { describe, expect, it } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

describe('resolveSpawnChildEnvironment (mcp selection)', () => {
  it('exports session-scoped MCP selection JSON for the spawned runner', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['server-a'],
        forceExcludeServerIds: ['server-b'],
      },
    } as any;

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.extraEnvForChild.HAPPIER_SESSION_MCP_SELECTION_JSON).toBe(JSON.stringify(options.mcpSelection));
  });

  it('does not export removed session workspace linkage metadata into child env', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      workspaceId: 'ws_payments',
      workspaceLocationId: 'loc_local',
      workspaceCheckoutId: 'checkout_feature_auth',
    } as any;

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.extraEnvForChild.HAPPIER_SESSION_WORKSPACE_CONTEXT_JSON).toBeUndefined();
  });

  it('exports session config option overrides JSON for the spawned runner metadata seed', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 123,
        overrides: {
          speed: { updatedAt: 123, value: 'fast' },
        },
      },
    } as any;

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.extraEnvForChild.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON).toBe(JSON.stringify(options.sessionConfigOptionOverrides));
  });

  it('exports the requested session directory for runner metadata seeding', async () => {
    const options: SpawnSessionOptions = {
      directory: '/tmp/requested-session-directory',
    } as any;

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.extraEnvForChild.HAPPIER_SESSION_REQUESTED_DIRECTORY).toBe('/tmp/requested-session-directory');
  });
});
