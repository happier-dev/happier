import { describe, expect, it } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';
import { captureSessionLaunchControlMetadata, createSessionMetadata } from '@/agent/runtime/createSessionMetadata';

describe('resolveSpawnChildEnvironment (mcp selection)', () => {
  it('carries only admitted fresh identity into host metadata, excluding ambient and Profile overrides', async () => {
    const identity = { bot: { kind: 'bot' as const }, createdAsBot: true as const };
    for (const existingSessionId of [undefined, 'existing-session']) {
      const options: SpawnSessionOptions = { directory: '/tmp/project', identity, memoryEnabled: false, existingSessionId,
        environmentVariables: { HAPPIER_SESSION_INITIAL_IDENTITY_JSON: '{"createdAsBot":false}',
          HAPPIER_SESSION_INITIAL_MEMORY_ENABLED: 'true' } };
      const processEnv = { HAPPIER_SESSION_INITIAL_IDENTITY_JSON: JSON.stringify(identity),
        happier_session_initial_identity_json: JSON.stringify(identity), HAPPIER_SESSION_INITIAL_MEMORY_ENABLED: 'true' };
      const result = await resolveSpawnChildEnvironment({
        options, processEnv, daemonSpawnHooks: null,
        profileEnvironmentVariables: { HAPPIER_SESSION_INITIAL_IDENTITY_JSON: '{"createdAsBot":false}',
          HAPPIER_SESSION_INITIAL_MEMORY_ENABLED: 'true' },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.errorMessage);
      const childEnvironment = buildSpawnChildProcessEnv({ processEnv, extraEnv: result.extraEnvForChild });
      expect(childEnvironment.happier_session_initial_identity_json).toBeUndefined();
      const { metadata } = createSessionMetadata({
        flavor: 'test-agent', machineId: 'machine-1', directory: options.directory,
        launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: childEnvironment }),
      });
      if (existingSessionId) expect(metadata).not.toHaveProperty('bot');
      else expect(metadata).toMatchObject(identity);
      expect(metadata).toHaveProperty('work.memoryEnabled', false);
    }
  });
  it.each(['managed', 'path'] as const)('publishes the %s directory kind solely from the private spawn option', async (directoryKind) => {
    const options: SpawnSessionOptions & { directoryKind: 'managed' | 'path' } = {
      directory: '/tmp/session-working-directory',
      directoryKind,
      environmentVariables: { HAPPIER_SESSION_DIRECTORY_KIND: 'managed' },
    };
    const processEnv = {
      HAPPIER_SESSION_DIRECTORY_KIND: 'managed',
      happier_session_directory_kind: 'managed',
    };
    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: { HAPPIER_SESSION_DIRECTORY_KIND: 'managed' },
      daemonSpawnHooks: null,
      processEnv,
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const childEnvironment = buildSpawnChildProcessEnv({ processEnv, extraEnv: result.extraEnvForChild });
    expect(childEnvironment.HAPPIER_SESSION_DIRECTORY_KIND).toBe(directoryKind === 'managed' ? 'managed' : undefined);
    expect(childEnvironment.happier_session_directory_kind).toBeUndefined();
    const launchControlMetadata = captureSessionLaunchControlMetadata({ processEnvironment: childEnvironment });
    expect(launchControlMetadata).toMatchObject({ sessionDirectoryKind: directoryKind });
    expect(childEnvironment.HAPPIER_SESSION_DIRECTORY_KIND).toBeUndefined();
    const { metadata } = createSessionMetadata({
      flavor: 'test-agent',
      machineId: 'machine-1',
      directory: options.directory,
      launchControlMetadata,
    });
    expect(metadata).toMatchObject({
      path: options.directory,
      sessionWorkspaceLocationV1: {
        machineId: 'machine-1',
        machinePath: options.directory,
        agentPath: options.directory,
      },
    });
    if (directoryKind === 'managed') {
      expect(metadata).toHaveProperty('sessionDirectoryV1', { v: 1, kind: 'managed' });
    } else {
      expect(metadata).not.toHaveProperty('sessionDirectoryV1');
    }
  });

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
    expect(result.extraEnvForChild.HAPPIER_SESSION_MACHINE_WORKSPACE_PATH).toBe('/tmp/requested-session-directory');
  });
});
