import { describe, expect, it } from 'vitest';

import {
  CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL,
  CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_ENV,
  deriveConnectedServiceBrokerRefreshToken,
  isValidConnectedServiceBrokerRefreshToken,
} from './capabilityToken.js';

describe('connected-service broker capability token (shared, provider-agnostic)', () => {
  it('derives a deterministic scoped token from the master control token', () => {
    const a = deriveConnectedServiceBrokerRefreshToken('master-control-token');
    const b = deriveConnectedServiceBrokerRefreshToken('master-control-token');
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('is NOT equal to the master control token (least privilege — no broker ever gets the master)', () => {
    const master = 'master-control-token';
    const scoped = deriveConnectedServiceBrokerRefreshToken(master);
    expect(scoped).not.toBe(master);
    expect(scoped).not.toContain(master);
  });

  it('produces different tokens for different master secrets', () => {
    expect(deriveConnectedServiceBrokerRefreshToken('token-a')).not.toBe(
      deriveConnectedServiceBrokerRefreshToken('token-b'),
    );
  });

  it('returns empty for an empty/blank master token (fail-closed)', () => {
    expect(deriveConnectedServiceBrokerRefreshToken('')).toBe('');
    expect(deriveConnectedServiceBrokerRefreshToken('   ')).toBe('');
    expect(deriveConnectedServiceBrokerRefreshToken(null)).toBe('');
    expect(deriveConnectedServiceBrokerRefreshToken(undefined)).toBe('');
  });

  it('validates the scoped token against the master and rejects the master itself', () => {
    const master = 'master-control-token';
    const scoped = deriveConnectedServiceBrokerRefreshToken(master);
    expect(isValidConnectedServiceBrokerRefreshToken(scoped, master)).toBe(true);
    expect(isValidConnectedServiceBrokerRefreshToken(master, master)).toBe(false);
    expect(isValidConnectedServiceBrokerRefreshToken(deriveConnectedServiceBrokerRefreshToken('other'), master)).toBe(false);
  });

  it('fails closed on empty/blank inputs', () => {
    const master = 'master-control-token';
    expect(isValidConnectedServiceBrokerRefreshToken('', master)).toBe(false);
    expect(isValidConnectedServiceBrokerRefreshToken(null, master)).toBe(false);
    expect(isValidConnectedServiceBrokerRefreshToken(deriveConnectedServiceBrokerRefreshToken(master), '')).toBe(false);
  });

  it('pins a versioned, provider-agnostic scope label + env name (the SAME token authorizes every broker)', () => {
    // Provider-agnostic so the OpenCode plugin AND the Pi extension derive the SAME scoped token, and a
    // SINGLE bridge preHandler authorizes both. Versioned so a future scope/format change is unambiguous.
    expect(CONNECTED_SERVICE_BROKER_REFRESH_SCOPE_LABEL).toBe('happier:connected-service-broker-refresh:v1');
    expect(CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_ENV).toBe('HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN');
  });
});
