import { describe, expect, it } from 'vitest';

import { mapUnknownErrorToControlError } from './controlErrorMapping';

describe('mapUnknownErrorToControlError', () => {
  it('preserves an unavailable MCP catalog as an expected domain refusal', () => {
    // This shared boundary accepts unknown errors; reader/store production is
    // exercised through the real MCP command entrypoint owner tests.
    const error = Object.assign(new Error('MCP server catalog is unavailable'), { code: 'mcp_catalog_unavailable' });
    expect(mapUnknownErrorToControlError(error)).toMatchObject({ code: 'mcp_catalog_unavailable', unexpected: false });
  });

  it('preserves an invalid MCP semantic mutation as an expected domain refusal', () => {
    const error = Object.assign(new Error('MCP catalog mutation is invalid'), { code: 'invalid-mutation' });
    expect(mapUnknownErrorToControlError(error)).toMatchObject({ code: 'invalid-mutation', unexpected: false });
  });

  it('maps SDK transport authentication and network failures as expected errors', () => {
    expect(mapUnknownErrorToControlError(Object.assign(new Error('Unauthorized'), { name: 'HappierTransportError', statusCode: 401 }))).toMatchObject({ code: 'not_authenticated', unexpected: false });
    expect(mapUnknownErrorToControlError(Object.assign(new Error('Bad gateway'), { name: 'HappierTransportError', statusCode: 502 }))).toMatchObject({ code: 'server_unreachable', unexpected: false });
  });

  it('keeps inventory and subcommand failures expected', () => {
    expect(mapUnknownErrorToControlError(Object.assign(new Error('inventory'), { code: 'machine_inventory_unavailable' }))).toMatchObject({ code: 'machine_inventory_unavailable', unexpected: false });
    expect(mapUnknownErrorToControlError(Object.assign(new Error('subcommand'), { code: 'unknown_subcommand' }))).toMatchObject({ code: 'unknown_subcommand', unexpected: false });
    expect(mapUnknownErrorToControlError(Object.assign(new Error('identity'), { code: 'server_identity_unavailable' }))).toMatchObject({ code: 'server_identity_unavailable', unexpected: false });
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
