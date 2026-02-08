import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/providerSpecs';
import { scenarioCatalog } from '../../src/testkit/providers/scenarioCatalog';

describe('providers: scenario registries reference real scenarios', () => {
  it('resolves all scenario ids referenced by provider registries', async () => {
    const providers = await loadProvidersFromCliSpecs();
    expect(providers.length).toBeGreaterThan(0);

    for (const provider of providers) {
      for (const tier of ['smoke', 'extended'] as const) {
        const ids = provider.scenarioRegistry.tiers[tier] ?? [];
        for (const id of ids) {
          const factory = scenarioCatalog[id];
          expect(factory).toBeTruthy();
          const scenario = factory(provider);
          expect(scenario.id).toBe(id);
          expect(scenario.tier ?? 'extended').toBe(tier);
        }
      }
    }
  });
});
