import { describe, expect, it } from 'vitest';

import type { ProviderUnderTest } from '../../src/testkit/providers/types';
import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';

describe('providers scenario catalog: codex resume inactivity tuning', () => {
  const codexProvider: ProviderUnderTest = {
    id: 'codex',
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_CODEX',
    protocol: 'acp',
    traceProvider: 'codex',
    cli: {
      subcommand: 'codex',
    },
    scenarioRegistry: {
      v: 1,
      tiers: {
        smoke: [],
        extended: [],
      },
    },
  };

  it('raises inactivity timeout for codex ACP resume scenario', () => {
    const scenario = scenarioCatalog.acp_resume_load_session(codexProvider);
    expect(scenario.inactivityTimeoutMs).toBe(240_000);
  });
});
