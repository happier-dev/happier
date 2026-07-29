import { describe, expect, it } from 'vitest';
import type { ProviderScenario } from '../../src/testkit/providers/types';
import { selectScenariosFromRegistry } from '../../src/testkit/providers/harness';

describe('providers: scenario selection (registry)', () => {
  it('selects only scenarios listed in the provider registry for the chosen tier', () => {
    const scenarios: ProviderScenario[] = [
      { id: 'a', tier: 'smoke' },
      { id: 'b', tier: 'smoke' },
      { id: 'c', tier: 'smoke' },
      { id: 'd', tier: 'extended' },
    ] as ProviderScenario[];

    const registry: { v: 1; tiers: { smoke: string[]; extended: string[] } } = {
      v: 1,
      tiers: { smoke: ['b', 'a'], extended: ['d'] },
    };

    const selectedSmoke = selectScenariosFromRegistry({ scenarios, registry, tier: 'smoke' });
    expect(selectedSmoke.map((s) => s.id)).toEqual(['b', 'a']);

    const selectedExtended = selectScenariosFromRegistry({ scenarios, registry, tier: 'extended' });
    expect(selectedExtended.map((s) => s.id)).toEqual(['d']);
  });
});
