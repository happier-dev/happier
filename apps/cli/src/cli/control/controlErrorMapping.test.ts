import { describe, expect, it } from 'vitest';

import { mapUnknownErrorToControlError } from './controlErrorMapping';
import { createAuthenticationHttpStatusError } from '@/api/client/httpStatusError';
import { ConnectedServicesDefaultUnavailableError } from '@/session/services/spawnConnectedServicesDefaults';

describe('mapUnknownErrorToControlError', () => {
  it.each(['stale_home_descriptor', 'home_descriptor_conflict', 'identity_mismatch', 'duplicate_identity', 'invalid_home_descriptor'] as const)(
    'preserves the Home profile refusal %s', code => {
      expect(mapUnknownErrorToControlError(Object.assign(new Error('Home profile refused'), { code })))
        .toMatchObject({ code, unexpected: false });
    },
  );

  it('maps an authenticated descriptor identity mismatch to the profile identity refusal', () => {
    expect(mapUnknownErrorToControlError(Object.assign(new Error('Home identity mismatch'), { code: 'HOME_AUTHORITY_MISMATCH' })))
      .toMatchObject({ code: 'identity_mismatch', unexpected: false });
  });

  it('retains the typed missing capability error at the CLI output boundary', () => {
    const error = Object.assign(new Error('Capability not found: missing'), { code: 'not_found' });
    expect(mapUnknownErrorToControlError(error)).toMatchObject({ code: 'not_found', unexpected: false });
  });
  it('preserves unavailable connected account defaults as an expected domain refusal', () => {
    expect(mapUnknownErrorToControlError(new ConnectedServicesDefaultUnavailableError('connected_services_default_settings_invalid')))
      .toMatchObject({ code: 'connected_services_default_unavailable', unexpected: false });
  });
  it('preserves an unavailable MCP catalog as an expected domain refusal', () => {
    // This shared boundary accepts unknown errors; reader/store production is
    // exercised through the real MCP command entrypoint owner tests.
    const error = Object.assign(new Error('MCP server catalog is unavailable'), { code: 'mcp_catalog_unavailable' });
    expect(mapUnknownErrorToControlError(error)).toMatchObject({ code: 'mcp_catalog_unavailable', unexpected: false });
  });
  it.each(['client_refused', 'no_machine_online', 'mcp_server_not_found', 'mcp_oauth_resource_requires_https', 'mcp_oauth_endpoints_require_https'])('retains the MCP command domain refusal %s', code => {
    expect(mapUnknownErrorToControlError(Object.assign(new Error('MCP command refused'), { code })))
      .toMatchObject({ code, unexpected: false });
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
  it('presents a typed server 403 refusal by its code, not as an authentication failure', () => {
    const refusal = createAuthenticationHttpStatusError(403, 'Unauthorized (403)', { error: 'session-origin-forbidden' });
    expect(mapUnknownErrorToControlError(refusal)).toEqual({
      code: 'session-origin-forbidden', unexpected: false, message: refusal.message,
    });
    expect(mapUnknownErrorToControlError(createAuthenticationHttpStatusError(403, 'Unauthorized (403)')))
      .toMatchObject({ code: 'not_authenticated', unexpected: false });
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
