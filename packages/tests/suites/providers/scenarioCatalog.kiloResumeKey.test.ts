import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function providerStub(id: string): ProviderUnderTest {
  const envSuffix = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return {
    id,
    enableEnvVar: `HAPPIER_E2E_PROVIDER_${envSuffix}`,
    protocol: 'acp',
    traceProvider: id,
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand: id },
  };
}

describe('scenarioCatalog (kilo resume metadata)', () => {
  it('uses the expected metadata key per provider across ACP resume scenarios', () => {
    const cases = [
      { providerId: 'kilo', key: 'kiloSessionId' },
      { providerId: 'qwen', key: 'qwenSessionId' },
      { providerId: 'kimi', key: 'kimiSessionId' },
      { providerId: 'auggie', key: 'auggieSessionId' },
    ] as const;

    for (const testCase of cases) {
      const loadScenario = scenarioCatalog.acp_resume_load_session(providerStub(testCase.providerId));
      const freshScenario = scenarioCatalog.acp_resume_fresh_session_imports_history(providerStub(testCase.providerId));
      expect(loadScenario.resume?.metadataKey).toBe(testCase.key);
      expect(freshScenario.resume?.metadataKey).toBe(testCase.key);
    }
  });
});
