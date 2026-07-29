import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PI_AGENT_RUNTIME_CONTRIBUTION,
  PI_AUTH_ENV_KEYS_TO_NEUTRALIZE,
} from '@happier-dev/plugins-pi/agent/contributions/runtime';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import { buildTrackedSessionRespawnEnvironmentVariables } from '../processSupervision/sessionRunnerRespawnDescriptor';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY } from '@/agent/runtime/sessionConnectedServicesBindingsEnv';
import { serializeConnectedServiceMaterializedEnvKeys } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

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

  it('lets Pi materialization empty overlays replace inherited and tracked legacy broker env', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-retired-broker-env-'));
    const legacyEnv = Object.fromEntries(
      PI_AUTH_ENV_KEYS_TO_NEUTRALIZE.map((key) => [key, `legacy-${key}`]),
    );
    const materializeAuthEnvironment =
      PI_AGENT_RUNTIME_CONTRIBUTION.connectedServices.materializeAuthEnvironment;

    try {
      const materialized = await materializeAuthEnvironment({
        rootDir,
        processEnv: legacyEnv,
      });
      expect(JSON.parse(
        serializeConnectedServiceMaterializedEnvKeys(materialized.env) ?? '[]',
      )).toEqual(expect.arrayContaining([...PI_AUTH_ENV_KEYS_TO_NEUTRALIZE]));

      const result = await resolveSpawnChildEnvironment({
        options: {
          directory: '.',
          environmentVariables: legacyEnv,
        },
        profileEnvironmentVariables: legacyEnv,
        daemonSpawnHooks: null,
        processEnv: legacyEnv,
        logDebug: () => {},
        logInfo: () => {},
        logWarn: () => {},
        connectedServiceAuth: {
          env: { ...materialized.env },
          cleanupOnFailure: null,
          cleanupOnExit: null,
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.fromEntries(
        PI_AUTH_ENV_KEYS_TO_NEUTRALIZE.map((key) => [
          key,
          result.expandedEnvironmentVariables[key],
        ]),
      )).toEqual(Object.fromEntries(
        PI_AUTH_ENV_KEYS_TO_NEUTRALIZE.map((key) => [key, '']),
      ));
      expect(Object.fromEntries(
        PI_AUTH_ENV_KEYS_TO_NEUTRALIZE.map((key) => [
          key,
          result.extraEnvForChild[key],
        ]),
      )).toEqual(Object.fromEntries(
        PI_AUTH_ENV_KEYS_TO_NEUTRALIZE.map((key) => [key, '']),
      ));
      const trackedRespawnEnv = buildTrackedSessionRespawnEnvironmentVariables({
        expandedEnvironmentVariables: result.expandedEnvironmentVariables,
        extraEnvForChild: result.extraEnvForChild,
      });
      for (const key of PI_AUTH_ENV_KEYS_TO_NEUTRALIZE) {
        expect(trackedRespawnEnv).not.toHaveProperty(key);
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
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
