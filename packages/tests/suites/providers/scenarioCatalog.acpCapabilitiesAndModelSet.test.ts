import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function acpProvider(id: string): ProviderUnderTest {
  return {
    id,
    enableEnvVar: `HAPPIER_E2E_PROVIDER_${id.toUpperCase()}`,
    protocol: 'acp',
    traceProvider: id,
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand: id },
  };
}

describe('scenarioCatalog: ACP capability/model-set scenarios', () => {
  it('defines acp_probe_capabilities as a real scenario', () => {
    const build = (scenarioCatalog as Record<string, any>).acp_probe_capabilities;
    expect(typeof build).toBe('function');

    const scenario = build(acpProvider('qwen'));
    expect(scenario.id).toBe('acp_probe_capabilities');
    expect(scenario.requiredFixtureKeys).toBeUndefined();
    expect(scenario.requiredAnyFixtureKeys).toBeUndefined();
    expect(typeof scenario.postSatisfy?.run).toBe('function');
  });

  it('defines acp_set_model_dynamic for dynamic ACP providers', () => {
    const build = (scenarioCatalog as Record<string, any>).acp_set_model_dynamic;
    expect(typeof build).toBe('function');

    const scenario = build(acpProvider('opencode'));
    expect(scenario.id).toBe('acp_set_model_dynamic');
    expect(scenario.requiredFixtureKeys).toBeUndefined();
    expect(scenario.requiredAnyFixtureKeys).toBeUndefined();
    expect(typeof scenario.postSatisfy?.run).toBe('function');
  });

  it('rejects acp_set_model_dynamic for providers without known dynamic model probing', () => {
    const build = (scenarioCatalog as Record<string, any>).acp_set_model_dynamic;
    expect(typeof build).toBe('function');
    expect(() => build(acpProvider('qwen'))).toThrow(/dynamic model/i);
    expect(() => build(acpProvider('kimi'))).toThrow(/dynamic model/i);
  });

  it('defines acp_set_model_inventory for gemini only', () => {
    const build = (scenarioCatalog as Record<string, any>).acp_set_model_inventory;
    expect(typeof build).toBe('function');

    const scenario = build(acpProvider('gemini'));
    expect(scenario.id).toBe('acp_set_model_inventory');
    expect(scenario.requiredFixtureKeys).toBeUndefined();
    expect(scenario.requiredAnyFixtureKeys).toBeUndefined();
    expect(typeof scenario.postSatisfy?.run).toBe('function');
    expect(() => build(acpProvider('codex'))).toThrow(/gemini provider/i);
  });
});
