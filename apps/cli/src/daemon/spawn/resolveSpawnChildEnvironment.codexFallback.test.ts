import { describe, expect, it, vi } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

describe('resolveSpawnChildEnvironment (codex ACP fallback)', () => {
  it('falls back to MCP for new Codex sessions when ACP validation fails', async () => {
    const logWarn = vi.fn();

    const options: SpawnSessionOptions = {
      directory: '.',
      agent: 'codex',
      experimentalCodexAcp: true,
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        validateSpawn: async ({ experimentalCodexAcp }) => {
          if (experimentalCodexAcp === true) {
            return { ok: false, errorMessage: 'codex-acp is missing' };
          }
          return { ok: true };
        },
        buildExtraEnvForChild: ({ experimentalCodexAcp }) => ({
          ...(experimentalCodexAcp === true ? { HAPPIER_EXPERIMENTAL_CODEX_ACP: '1' } : {}),
        }),
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn,
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.extraEnvForChild.HAPPIER_EXPERIMENTAL_CODEX_ACP).toBeUndefined();
    expect(logWarn).toHaveBeenCalled();
  });

  it('does not fall back when an explicit resume id is provided', async () => {
    const logWarn = vi.fn();

    const options: SpawnSessionOptions = {
      directory: '.',
      agent: 'codex',
      resume: 'x1',
      experimentalCodexAcp: true,
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        validateSpawn: async () => ({ ok: false, errorMessage: 'codex-acp is missing' }),
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn,
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(false);
    expect(logWarn).not.toHaveBeenCalled();
  });
});

