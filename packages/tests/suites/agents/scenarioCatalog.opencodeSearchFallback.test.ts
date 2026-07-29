import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderFixtures, ProviderUnderTest } from '../../src/testkit/providers/types';

function baseVerifyContext(overrides: Partial<{
  workspaceDir: string;
  fixtures: ProviderFixtures;
}>) {
  return {
    workspaceDir: overrides.workspaceDir ?? '/tmp',
    fixtures: overrides.fixtures ?? { examples: {} },
    traceEvents: [],
    baseUrl: 'http://127.0.0.1:1',
    token: 'token',
    sessionId: 'session',
    resumeSessionId: null,
    secret: new Uint8Array(32),
    resumeId: null,
  };
}

function acpProvider(id: string): ProviderUnderTest {
  return {
    id,
    enableEnvVar: `HAPPIER_E2E_PROVIDER_${id.toUpperCase()}`,
    protocol: 'acp',
    traceProvider: id,
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: ['search_known_token'] } },
    cli: { subcommand: id },
  };
}

describe('scenarioCatalog: search_known_token (opencode)', () => {
  it('accepts bash fallback fixture output when search fixtures are absent', async () => {
    const scenario = scenarioCatalog.search_known_token(acpProvider('opencode'));
    expect(typeof scenario.verify).toBe('function');

    await expect(
      scenario.verify?.(
        baseVerifyContext({
          workspaceDir: '/tmp',
          fixtures: {
            examples: {
              'acp/opencode/tool-result/Bash': [
                {
                  payload: {
                    output: 'SEARCH_TOKEN_XYZ',
                  },
                },
              ],
            },
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
