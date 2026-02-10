import { describe, expect, it } from 'vitest';

import { loadCliProviderSpecs } from '../../src/testkit/providers/specs/providerSpecs';

describe('providers: kilo', () => {
  it('is discoverable via apps/cli providerSpec.json', async () => {
    const specs = await loadCliProviderSpecs();
    const kilo = specs.find((spec) => spec.id === 'kilo') ?? null;
    expect(kilo).not.toBeNull();
    if (!kilo) return;
    expect(kilo.enableEnvVar).toBe('HAPPIER_E2E_PROVIDER_KILO');
  });
});
