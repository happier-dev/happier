import { describe, expect, it } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

describe('resolveSpawnChildEnvironment (explicit env keys marker)', () => {
  it('exports explicit GUI/auth env keys for downstream strict env filtering', async () => {
    const options = {
      directory: '.',
      environmentVariables: {},
      token: 'token-123',
    } as any as SpawnSessionOptions;

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: { GITHUB_TOKEN: 'ghp_test' },
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = result.extraEnvForChild.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON;
    expect(typeof raw).toBe('string');
    const parsed = JSON.parse(String(raw));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(expect.arrayContaining(['GITHUB_TOKEN']));
    expect(parsed).not.toEqual(expect.arrayContaining(['CLAUDE_CODE_OAUTH_TOKEN']));
  });

  it('strips daemon-owned server/home overrides from caller-provided profile env', async () => {
    const options = {
      directory: '.',
      environmentVariables: {},
    } as any as SpawnSessionOptions;

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {
        HAPPIER_HOME_DIR: '/tmp/foreign-home',
        HAPPIER_ACTIVE_SERVER_ID: 'foreign-server',
        HAPPIER_SERVER_URL: 'https://foreign-api.example.test',
        HAPPIER_WEBAPP_URL: 'https://foreign-app.example.test',
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:65531',
        HAPPIER_PUBLIC_SERVER_URL: 'https://foreign-public.example.test',
        OPENAI_API_KEY: 'sk-test',
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

    expect(result.expandedEnvironmentVariables.HAPPIER_HOME_DIR).toBeUndefined();
    expect(result.expandedEnvironmentVariables.HAPPIER_ACTIVE_SERVER_ID).toBeUndefined();
    expect(result.expandedEnvironmentVariables.HAPPIER_SERVER_URL).toBeUndefined();
    expect(result.expandedEnvironmentVariables.HAPPIER_WEBAPP_URL).toBeUndefined();
    expect(result.expandedEnvironmentVariables.HAPPIER_LOCAL_SERVER_URL).toBeUndefined();
    expect(result.expandedEnvironmentVariables.HAPPIER_PUBLIC_SERVER_URL).toBeUndefined();
    expect(result.expandedEnvironmentVariables.OPENAI_API_KEY).toBe('sk-test');

    const raw = result.extraEnvForChild.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON;
    const parsed = JSON.parse(String(raw));
    expect(parsed).toEqual(expect.arrayContaining(['OPENAI_API_KEY']));
    expect(parsed).not.toEqual(
      expect.arrayContaining([
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
        'HAPPIER_LOCAL_SERVER_URL',
        'HAPPIER_PUBLIC_SERVER_URL',
      ]),
    );
  });
});
