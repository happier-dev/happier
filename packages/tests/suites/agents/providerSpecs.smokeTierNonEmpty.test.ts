import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/specs/providerSpecs';

describe('providers: scenario registries', () => {
  it('includes at least one smoke scenario for ACP providers', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const offenders = providers
      // This deterministic captured-replay fixture is intentionally extended-only and
      // is excluded from the real-provider aggregate preset.
      .filter((p) => p.id !== 'cursor_acp_stub')
      .filter((p) => p.protocol === 'acp')
      .filter((p) => (p.scenarioRegistry?.tiers?.smoke ?? []).length === 0)
      .map((p) => p.id);

    expect(offenders).toEqual([]);
  });
});
