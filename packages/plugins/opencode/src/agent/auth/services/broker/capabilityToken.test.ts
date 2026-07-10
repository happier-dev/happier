import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  OPEN_CODE_BROKER_REFRESH_SCOPE_LABEL,
  deriveOpenCodeBrokerRefreshToken,
  isValidOpenCodeBrokerRefreshToken,
} from './capabilityToken.js';

describe('openCode broker capability token (F2 least privilege)', () => {
  it('derives a deterministic scoped token from the master control token', () => {
    const master = 'daemon-master-control-token';
    const first = deriveOpenCodeBrokerRefreshToken(master);
    const second = deriveOpenCodeBrokerRefreshToken(master);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);
    // It is exactly the documented HMAC over the scope label (base64url).
    const expected = createHmac('sha256', master).update(OPEN_CODE_BROKER_REFRESH_SCOPE_LABEL).digest('base64url');
    expect(first).toBe(expected);
  });

  it('produces a scoped token that is NOT the master token (least privilege)', () => {
    const master = 'daemon-master-control-token';
    expect(deriveOpenCodeBrokerRefreshToken(master)).not.toBe(master);
  });

  it('produces different scoped tokens for different master tokens', () => {
    expect(deriveOpenCodeBrokerRefreshToken('master-a')).not.toBe(deriveOpenCodeBrokerRefreshToken('master-b'));
  });

  it('fails closed for an empty/blank control token', () => {
    expect(deriveOpenCodeBrokerRefreshToken('')).toBe('');
    expect(deriveOpenCodeBrokerRefreshToken('   ')).toBe('');
    expect(deriveOpenCodeBrokerRefreshToken(null)).toBe('');
    expect(deriveOpenCodeBrokerRefreshToken(undefined)).toBe('');
  });

  it('validates the scoped token constant-time and rejects the master token + mismatches', () => {
    const master = 'daemon-master-control-token';
    const scoped = deriveOpenCodeBrokerRefreshToken(master);
    expect(isValidOpenCodeBrokerRefreshToken(scoped, master)).toBe(true);
    // The broad master token must NOT validate on the scoped gate.
    expect(isValidOpenCodeBrokerRefreshToken(master, master)).toBe(false);
    // A scoped token derived from a different master must not validate.
    expect(isValidOpenCodeBrokerRefreshToken(deriveOpenCodeBrokerRefreshToken('other'), master)).toBe(false);
    // Empty/blank inputs fail closed on both sides.
    expect(isValidOpenCodeBrokerRefreshToken('', master)).toBe(false);
    expect(isValidOpenCodeBrokerRefreshToken(scoped, '')).toBe(false);
    expect(isValidOpenCodeBrokerRefreshToken(null, master)).toBe(false);
  });
});
