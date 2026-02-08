import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function acpProvider(id: string): ProviderUnderTest {
  return {
    id,
    enableEnvVar: `HAPPIER_E2E_PROVIDER_${id.toUpperCase()}`,
    protocol: 'acp',
    traceProvider: id,
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: ['acp_probe_models'] } },
    cli: { subcommand: id },
  };
}

describe('scenarioCatalog: acp_probe_models', () => {
  it('does not require read-tool fixtures and validates probe result shape only', () => {
    const scenario = scenarioCatalog.acp_probe_models(acpProvider('qwen'));
    expect(scenario.id).toBe('acp_probe_models');
    expect(scenario.requiredFixtureKeys).toBeUndefined();
    expect(scenario.requiredAnyFixtureKeys).toBeUndefined();
    expect(scenario.requiredTraceSubstrings).toBeUndefined();
    expect(scenario.postSatisfy?.timeoutMs).toBe(120_000);
    expect(typeof scenario.postSatisfy?.run).toBe('function');
  });
});
