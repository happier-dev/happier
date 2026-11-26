import { describe, expect, it } from 'vitest';

import { buildClaudeSubprocessEnv } from '@/backends/claude/spawn/buildClaudeSubprocessEnv';
import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

describe('resolveSpawnChildEnvironment (explicit env keys marker)', () => {
  it.each(['linux', 'win32'] as const)('forwards selected defaults to Claude across sessions on %s', async (platform) => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    const processEnv = {
      HAPPIER_SESSION_FORWARD_ENV: ' PLAYWRIGHT_BROWSERS_PATH, MISSING_VAR, * ',
      [platform === 'win32' ? 'Playwright_Browsers_Path' : 'PLAYWRIGHT_BROWSERS_PATH']: '/machine/browser-cache',
      PRIVATE_VALUE: 'leave-in-daemon',
      UNSELECTED: 'leave-in-daemon-too',
    };
    const launch = async (profileEnvironmentVariables: Record<string, string>) => {
      const result = await resolveSpawnChildEnvironment({
        options: { directory: '.' },
        profileEnvironmentVariables,
        daemonSpawnHooks: null,
        processEnv,
        logDebug: () => {},
        logInfo: () => {},
        logWarn: () => {},
      });
      if (!result.ok) throw new Error(result.errorMessage);
      return buildClaudeSubprocessEnv({
        baseEnv: buildSpawnChildProcessEnv({ processEnv, extraEnv: result.extraEnvForChild }),
      });
    };

    try {
      const inheritedName = platform === 'win32' ? 'Playwright_Browsers_Path' : 'PLAYWRIGHT_BROWSERS_PATH';
      const first = await launch({});
      const second = await launch({});
      expect(first[inheritedName]).toBe('/machine/browser-cache');
      expect(second[inheritedName]).toBe(first[inheritedName]);
      const overridden = await launch({
        PLAYWRIGHT_BROWSERS_PATH: '/profile/browser-cache',
        HAPPIER_SESSION_FORWARD_ENV: 'PRIVATE_VALUE',
      });
      expect(overridden.PLAYWRIGHT_BROWSERS_PATH).toBe('/profile/browser-cache');
      const cacheKeys = Object.keys(overridden).filter((key) => key.toUpperCase() === 'PLAYWRIGHT_BROWSERS_PATH');
      expect(cacheKeys).toEqual(['PLAYWRIGHT_BROWSERS_PATH']);
      expect(overridden).not.toHaveProperty('PRIVATE_VALUE');
      expect(overridden).not.toHaveProperty('UNSELECTED');
      expect(overridden).not.toHaveProperty('MISSING_VAR');
      expect(overridden).not.toHaveProperty('HAPPIER_SESSION_FORWARD_ENV');
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

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

  it('does not expose the daemon spawn nonce to child runtime environment', async () => {
    const options = {
      directory: '.',
      spawnNonce: 'spawn-nonce-daemon-only',
      environmentVariables: {},
    } satisfies SpawnSessionOptions;

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

    expect(Object.values(result.expandedEnvironmentVariables)).not.toContain('spawn-nonce-daemon-only');
    expect(Object.values(result.extraEnvForChild)).not.toContain('spawn-nonce-daemon-only');
    expect(result.extraEnvForChild).not.toHaveProperty('HAPPIER_SPAWN_NONCE');
  });
});
