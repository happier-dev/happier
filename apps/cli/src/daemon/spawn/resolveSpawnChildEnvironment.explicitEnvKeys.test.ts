import { describe, expect, it } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

describe('resolveSpawnChildEnvironment (explicit env keys marker)', () => {
  it('exports explicit GUI/auth env keys for downstream strict env filtering', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
      token: 'token-123',
    };

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
    expect(parsed).toEqual(expect.arrayContaining(['GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']));
  });
});
