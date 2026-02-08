import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/providerSpecs';

describe('providers: cli provider scenario registry', () => {
  it('loads provider scenario registry from apps/cli backends when present', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const opencode = providers.find((p) => p.id === 'opencode');
    expect(opencode).toBeTruthy();

    // Use runtime checks to avoid coupling the test to type changes during refactors.
    const opencodeObj = opencode as Record<string, unknown> | undefined;
    const registry =
      opencodeObj && typeof opencodeObj.scenarioRegistry === 'object' && opencodeObj.scenarioRegistry !== null
        ? (opencodeObj.scenarioRegistry as Record<string, unknown>)
        : null;
    const tiers = registry && typeof registry.tiers === 'object' && registry.tiers !== null
      ? (registry.tiers as Record<string, unknown>)
      : null;

    expect(registry && typeof registry === 'object').toBe(true);
    expect(typeof registry?.v).toBe('number');
    expect(registry?.v).toBe(1);
    expect(tiers && typeof tiers === 'object').toBe(true);
    expect(Array.isArray(tiers?.smoke)).toBe(true);
    expect(Array.isArray(tiers?.extended)).toBe(true);
    expect(tiers?.smoke).toContain('execute_trace_ok');
  });

  it('does not include shell-dependent LS scenarios for kimi in extended tier', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const kimi = providers.find((p) => p.id === 'kimi');
    expect(kimi).toBeTruthy();

    const kimiObj = kimi as Record<string, unknown> | undefined;
    const registry =
      kimiObj && typeof kimiObj.scenarioRegistry === 'object' && kimiObj.scenarioRegistry !== null
        ? (kimiObj.scenarioRegistry as Record<string, unknown>)
        : null;
    const tiers = registry && typeof registry.tiers === 'object' && registry.tiers !== null
      ? (registry.tiers as Record<string, unknown>)
      : null;
    const extended = Array.isArray(tiers?.extended) ? (tiers?.extended as string[]) : [];

    expect(extended).not.toContain('glob_list_files');
    expect(extended).not.toContain('search_ls_equivalence');
  });
});
