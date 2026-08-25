import { describe, expect, it } from 'vitest';

import { mapUnknownErrorToControlError } from './controlErrorMapping';

describe('mapUnknownErrorToControlError', () => {
  it('maps an invalid external API token to the canonical authentication error', () => {
    const error = Object.assign(new Error('The Happier API returned HTTP 401.'), {
      code: 'invalid_token',
      status: 401,
    });

    expect(mapUnknownErrorToControlError(error)).toEqual({
      code: 'not_authenticated',
      unexpected: false,
      message: 'The Happier API returned HTTP 401.',
    });
  });

  it('preserves an unavailable action target as an expected control error', () => {
    const error = Object.assign(new Error('target_unavailable'), {
      code: 'target_unavailable',
    });

    expect(mapUnknownErrorToControlError(error)).toEqual({
      code: 'target_unavailable',
      unexpected: false,
      message: 'target_unavailable',
    });
  });
});
