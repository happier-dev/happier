import { describe, expect, it } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

describe('resolveSpawnChildEnvironment (profile template expansion)', () => {
  it('expands profile env templates from injected profile env', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {
        DEEPSEEK_AUTH_TOKEN: 'sk-test',
        ANTHROPIC_AUTH_TOKEN: '${DEEPSEEK_AUTH_TOKEN}',
      },
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expandedEnvironmentVariables.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');
  });

  it('fails closed when profile env references child-only daemon env injected after expansion', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {
        ANTHROPIC_AUTH_TOKEN: '${DEEPSEEK_AUTH_TOKEN}',
      },
      daemonSpawnHooks: {
        buildExtraEnvForChild: () => ({
          DEEPSEEK_AUTH_TOKEN: 'sk-child-only-secret',
        }),
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED);
    expect(result.errorMessage).toContain('ANTHROPIC_AUTH_TOKEN references ${DEEPSEEK_AUTH_TOKEN}');
  });
});
