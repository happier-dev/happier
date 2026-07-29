import { describe, expect, it } from 'vitest';

import {
  areProviderContributionKeysEqualV1,
  canonicalizeProviderContributionKeyV1,
  normalizeProviderContributionKeyV1,
  parseProviderContributionIdentityV1,
} from './contributionIdentityV1.js';

describe('Provider contribution identity', () => {
  it('parses and normalizes the canonical qualified contribution key', () => {
    expect(parseProviderContributionIdentityV1('acme.gateway/gateway')).toEqual({
      identity: { pluginId: 'acme.gateway', localId: 'gateway' },
      canonicalKey: 'acme.gateway/gateway',
    });
    expect(normalizeProviderContributionKeyV1('acme.gateway/gateway'))
      .toBe('acme.gateway/gateway');
    expect(canonicalizeProviderContributionKeyV1('acme.gateway/gateway'))
      .toBe('acme.gateway/gateway');
    expect(areProviderContributionKeysEqualV1(
      'acme.gateway/gateway',
      'acme.gateway/gateway',
    )).toBe(true);
  });

  it('does not parse or equate the retired colon-form key', () => {
    const retiredColonKey = 'acme.gateway:providers:gateway';

    expect(parseProviderContributionIdentityV1(retiredColonKey)).toBeNull();
    expect(normalizeProviderContributionKeyV1(retiredColonKey)).toBeNull();
    expect(areProviderContributionKeysEqualV1(
      retiredColonKey,
      'acme.gateway/gateway',
    )).toBe(false);
  });
});
