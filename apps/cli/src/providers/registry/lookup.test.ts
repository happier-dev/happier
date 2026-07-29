import { describe, expect, it } from 'vitest';

import { normalizeProviderContributionRegistryKey } from './lookup';

describe('Provider contribution registry key normalization', () => {
  it('accepts only canonical qualified contribution keys', () => {
    expect(normalizeProviderContributionRegistryKey('acme.gateway/gateway'))
      .toBe('acme.gateway/gateway');
    expect(normalizeProviderContributionRegistryKey('acme.gateway/nested/provider'))
      .toBe('acme.gateway/nested/provider');
  });

  it.each([
    'acme.gateway:providers:gateway',
    'acme.gateway:agents:gateway',
    'acme.gateway:providers:',
    ':providers:gateway',
    'acme.gateway:providers:gateway:providers:other',
    'acme.gateway//gateway',
    'acme.gateway:providers:Gateway',
    ' acme.gateway:providers:gateway ',
  ])('rejects malformed or adjacent legacy shape %s', (input) => {
    expect(normalizeProviderContributionRegistryKey(input)).toBeNull();
  });
});
