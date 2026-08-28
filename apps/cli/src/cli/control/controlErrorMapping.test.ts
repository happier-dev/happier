import { describe, expect, it } from 'vitest';

import { mapUnknownErrorToControlError } from './controlErrorMapping';

describe('mapUnknownErrorToControlError', () => {
  it('maps SDK transport authentication and network failures as expected errors', () => {
    expect(mapUnknownErrorToControlError(Object.assign(new Error('Unauthorized'), { name: 'HappierTransportError', statusCode: 401 }))).toMatchObject({ code: 'not_authenticated', unexpected: false });
    expect(mapUnknownErrorToControlError(Object.assign(new Error('Bad gateway'), { name: 'HappierTransportError', statusCode: 502 }))).toMatchObject({ code: 'server_unreachable', unexpected: false });
  });

  it('keeps inventory and subcommand failures expected', () => {
    expect(mapUnknownErrorToControlError(Object.assign(new Error('inventory'), { code: 'machine_inventory_unavailable' }))).toMatchObject({ code: 'machine_inventory_unavailable', unexpected: false });
    expect(mapUnknownErrorToControlError(Object.assign(new Error('subcommand'), { code: 'unknown_subcommand' }))).toMatchObject({ code: 'unknown_subcommand', unexpected: false });
  });
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
