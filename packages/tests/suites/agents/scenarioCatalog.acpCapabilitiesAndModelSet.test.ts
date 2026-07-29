import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
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

  it('uses a longer capabilities probe timeout for gemini ACP', () => {
    const build = (scenarioCatalog as Record<string, any>).acp_probe_capabilities;
    expect(typeof build).toBe('function');

    const geminiScenario = build(acpProvider('gemini'));
    const qwenScenario = build(acpProvider('qwen'));

    expect(geminiScenario.postSatisfy?.timeoutMs).toBeGreaterThan(qwenScenario.postSatisfy?.timeoutMs ?? 0);
  });

  it('allows degraded ACP capability probe for gemini when CLI detect times out', async () => {
    const build = (scenarioCatalog as Record<string, any>).acp_probe_capabilities;
    expect(typeof build).toBe('function');
    const scenario = build(acpProvider('gemini'));

    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-acp-cap-gemini-'));
    const payload = {
      protocolVersion: 1,
      results: {
        'cli.gemini': {
          ok: true,
          data: {
            available: true,
            acp: {
              ok: false,
              checkedAt: Date.now(),
              error: { message: 'ACP initialize timeout after 30000ms' },
            },
          },
        },
      },
    };
    await writeFile(join(workspaceDir, 'e2e-probe-capabilities.json'), JSON.stringify(payload), 'utf8');

    await expect(scenario.verify({ workspaceDir })).resolves.toBeUndefined();
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
