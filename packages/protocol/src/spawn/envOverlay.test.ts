import { describe, expect, it } from 'vitest';

import { SessionEnvOverlayV1Schema } from './envOverlay.js';

describe('SessionEnvOverlayV1Schema', () => {
  it('preserves explicit empty values and null unsets as different operations', () => {
    expect(SessionEnvOverlayV1Schema.parse([
      { name: 'PROFILE_VALUE', value: 'configured', source: 'profile' },
      { name: 'PROVIDER_EMPTY', value: '', source: 'provider' },
      { name: 'PROVIDER_UNSET', value: null, source: 'provider' },
      { name: 'HAPPIER_SYSTEM_VALUE', value: 'owned', source: 'system' },
    ])).toEqual([
      { name: 'PROFILE_VALUE', value: 'configured', source: 'profile' },
      { name: 'PROVIDER_EMPTY', value: '', source: 'provider' },
      { name: 'PROVIDER_UNSET', value: null, source: 'provider' },
      { name: 'HAPPIER_SYSTEM_VALUE', value: 'owned', source: 'system' },
    ]);
  });

  it('allows different precedence sources to target the same environment key', () => {
    expect(SessionEnvOverlayV1Schema.safeParse([
      { name: 'API_BASE_URL', value: 'profile', source: 'profile' },
      { name: 'API_BASE_URL', value: 'provider', source: 'provider' },
      { name: 'API_BASE_URL', value: 'system', source: 'system' },
    ]).success).toBe(true);
  });

  it('rejects duplicate operations for one key inside the same source layer', () => {
    expect(SessionEnvOverlayV1Schema.safeParse([
      { name: 'API_KEY', value: 'first', source: 'provider' },
      { name: 'API_KEY', value: 'second', source: 'provider' },
    ]).success).toBe(false);
  });

  it.each([
    [{ name: 'lowercase', value: 'x', source: 'profile' }],
    [{ name: '1_STARTS_WITH_DIGIT', value: 'x', source: 'profile' }],
    [{ name: 'VALID_NAME', value: undefined, source: 'profile' }],
    [{ name: 'VALID_NAME', value: 'x', source: 'connected-service' }],
  ])('rejects an invalid overlay entry %#', (entry) => {
    expect(SessionEnvOverlayV1Schema.safeParse([entry]).success).toBe(false);
  });
});
