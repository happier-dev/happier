import { describe, expect, it, vi } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

describe('resolveSpawnChildEnvironment (profile template expansion)', () => {
  it('keeps environment keys and values out of spawn diagnostics while preserving the child environment', async () => {
    const privateEnvironmentKey = 'PRIVATE_CUSTOMER_WORKSPACE_TOKEN';
    const privateEnvironmentValue = 'private-environment-value';
    const logDebug = vi.fn();
    const logInfo = vi.fn();
    const logWarn = vi.fn();

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        environmentVariables: {},
      },
      profileEnvironmentVariables: {
        [privateEnvironmentKey]: privateEnvironmentValue,
      },
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug,
      logInfo,
      logWarn,
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expandedEnvironmentVariables[privateEnvironmentKey]).toBe(
      privateEnvironmentValue,
    );
    const diagnostics = JSON.stringify({
      debug: logDebug.mock.calls,
      info: logInfo.mock.calls,
      warn: logWarn.mock.calls,
    });
    expect(diagnostics).not.toContain(privateEnvironmentKey);
    expect(diagnostics).not.toContain(privateEnvironmentValue);
  });

  it('keeps raw cleanup errors out of spawn diagnostics while rethrowing the original failure', async () => {
    const privateCleanupError = 'cleanup failed for /private/customer/worktree';
    const originalFailure = new Error('original spawn hook failure');
    const logWarn = vi.fn();

    await expect(resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        environmentVariables: {},
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        augmentEnv: () => {
          throw originalFailure;
        },
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn,
      connectedServiceAuth: {
        env: {},
        cleanupOnFailure: () => {
          throw new Error(privateCleanupError);
        },
        cleanupOnExit: null,
      },
    })).rejects.toBe(originalFailure);

    expect(JSON.stringify(logWarn.mock.calls)).not.toContain(privateCleanupError);
  });

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
        augmentEnv: () => ({
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
