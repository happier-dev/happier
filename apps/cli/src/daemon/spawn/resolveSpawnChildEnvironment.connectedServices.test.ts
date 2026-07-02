import { describe, expect, it } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY } from '@/agent/runtime/sessionConnectedServicesBindingsEnv';

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

  it('exports validated connected service bindings for session metadata seeding', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'happier',
          },
        },
      },
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
        env: { CODEX_HOME: '/tmp/codex-connected-home' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.extraEnvForChild[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY]!)).toEqual(
        options.connectedServices,
      );
    }
  });

  it('keeps connected service cleanup hooks when connected auth is used', async () => {
    const connectedCleanups: string[] = [];
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
        cleanupOnFailure: () => connectedCleanups.push('failure'),
        cleanupOnExit: () => connectedCleanups.push('exit'),
      },
    });

    expect(result.ok).toBe(true);
    expect(result.cleanupOnExit).not.toBeNull();
    result.cleanupOnExit?.();
    expect(connectedCleanups).toEqual(['exit']);
  });

  it('propagates connected-service materialization diagnostics for downstream tracked-session visibility', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
    };
    const diagnostics = [{
      code: 'state_sharing_degraded',
      providerId: 'claude',
      serviceId: 'anthropic',
      requestedStateMode: 'shared',
      effectiveStateMode: 'isolated',
      reason: 'provider_state_unavailable',
    }] as const;

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
        diagnostics,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.materializationDiagnostics).toEqual(diagnostics);
    }
  });

  it('fails closed when profile env references connected service env injected for the child', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {
        ANTHROPIC_AUTH_TOKEN: '${DEEPSEEK_AUTH_TOKEN}',
      },
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: { DEEPSEEK_AUTH_TOKEN: 'sk-connected-secret' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED);
    expect(result.errorMessage).toContain('ANTHROPIC_AUTH_TOKEN references ${DEEPSEEK_AUTH_TOKEN}');
  });
});
