import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

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
      scenario.verify?.({
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
        traceEvents: [],
        baseUrl: 'http://127.0.0.1:1',
        token: 'token',
        sessionId: 'session',
        secret: 'secret',
      }),
    ).resolves.toBeUndefined();
  });
});
