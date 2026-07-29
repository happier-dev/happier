import { describe, expect, it } from 'vitest';

import type { ProviderUnderTest } from '../../src/testkit/providers/types';
import { resolveScenariosForProvider } from '../../src/testkit/providers/harness';

describe('providers: scenario selection (auth-mode overrides)', () => {
  it('prefers tiersByAuthMode when present (env)', async () => {
    const prev = process.env.FAKE_PROVIDER_KEY;
    process.env.FAKE_PROVIDER_KEY = '1';
    try {
      const provider = {
        id: 'codex',
        enableEnvVar: 'HAPPIER_E2E_PROVIDER_CODEX',
        protocol: 'acp',
        traceProvider: 'codex',
        requiredEnv: undefined,
        auth: {
          mode: 'auto',
          env: { requiredAll: ['FAKE_PROVIDER_KEY'] },
          host: {},
        },
        scenarioRegistry: {
          v: 1,
          tiers: { smoke: [], extended: ['read_in_workspace'] },
          tiersByAuthMode: {
            host: { smoke: [], extended: [] },
            env: { smoke: [], extended: ['read_in_workspace'] },
          },
        },
        requiresBinaries: undefined,
        cli: {
          subcommand: 'codex',
          extraArgs: [],
          env: {},
        },
      } as ProviderUnderTest & {
        scenarioRegistry: ProviderUnderTest['scenarioRegistry'] & {
          tiersByAuthMode: {
            host: { smoke: string[]; extended: string[] };
            env: { smoke: string[]; extended: string[] };
          };
        };
      };

      const extended = resolveScenariosForProvider({ provider, tier: 'extended' });
      expect(extended.map((s) => s.id)).toEqual(['read_in_workspace']);
    } finally {
      if (prev === undefined) delete process.env.FAKE_PROVIDER_KEY;
      else process.env.FAKE_PROVIDER_KEY = prev;
    }
  });
});
