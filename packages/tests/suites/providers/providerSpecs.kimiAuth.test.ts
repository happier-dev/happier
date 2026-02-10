import { describe, expect, it } from 'vitest';

import { loadCliProviderSpecs } from '../../src/testkit/providers/specs/providerSpecs';

describe('providers: kimi auth policy', () => {
  it('requires KIMI_API_KEY for env auth overlay', async () => {
    const specs = await loadCliProviderSpecs();
    const kimi = specs.find((spec) => spec.id === 'kimi');
    expect(kimi).toBeTruthy();
    expect(kimi?.auth?.mode).toBe('auto');
    expect(kimi?.auth?.env?.requiredAnyOf).toEqual([['KIMI_API_KEY']]);
  });
});
