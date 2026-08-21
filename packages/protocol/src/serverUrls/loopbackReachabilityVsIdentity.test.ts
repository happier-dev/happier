import { describe, expect, it } from 'vitest';

import { isLoopbackHostname } from './loopbackHostname.js';
import { createServerUrlComparableKey } from './serverUrlComparableKey.js';

/**
 * "Can another device reach this?" and "is this the same server?" are different
 * questions with different owners and different correctness criteria, and they
 * are supposed to disagree.
 *
 * This file exists so that a future consolidation — routing both through one
 * helper, or widening one predicate to match the other — trips over an
 * explanation instead of silently merging persisted credential scope.
 */
describe('loopback reachability vs server identity', () => {
  it('disagrees about 127.0.0.2, on purpose', () => {
    // Reachability: 127.0.0.2 is loopback. Handed to a phone it resolves back to
    // the phone, so it must never reach a QR code, deep link or shareable URL.
    expect(isLoopbackHostname('127.0.0.2')).toBe(true);

    // Identity: 127.0.0.2 is NOT the same server as localhost. This key is
    // persisted and gates which stored credentials a machine may use
    // (apps/cli/src/persistence.ts -> allowedServerIds). Someone running two
    // local relays on separate loopback addresses keeps two credential scopes;
    // collapsing them here would merge those scopes.
    expect(createServerUrlComparableKey('http://127.0.0.2:3005'))
      .not.toBe(createServerUrlComparableKey('http://localhost:3005'));
  });

  it('agrees about 127.0.0.1, which is the one loopback address identity collapses', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(createServerUrlComparableKey('http://127.0.0.1:3005'))
      .toBe(createServerUrlComparableKey('http://localhost:3005'));
  });

  it('disagrees about the .localhost TLD in the opposite direction', () => {
    // Both call `relay.localhost` loopback...
    expect(isLoopbackHostname('relay.localhost')).toBe(true);
    // ...and identity goes further, collapsing it onto plain localhost, because
    // RFC 6761 reserves the whole TLD for the local machine.
    expect(createServerUrlComparableKey('http://relay.localhost:3005'))
      .toBe(createServerUrlComparableKey('http://localhost:3005'));
  });

  it('excludes 0.0.0.0 from both, for different reasons', () => {
    // Reachability owner: 0.0.0.0 is every interface, not loopback. Callers for
    // whom an all-interfaces URL is also unusable add that case themselves.
    expect(isLoopbackHostname('0.0.0.0')).toBe(false);

    // Identity: it is its own host, and is not the same server as localhost.
    expect(createServerUrlComparableKey('http://0.0.0.0:3005'))
      .not.toBe(createServerUrlComparableKey('http://localhost:3005'));
  });

  it('agrees that a trailing dot names the same host', () => {
    expect(isLoopbackHostname('localhost.')).toBe(true);
    expect(createServerUrlComparableKey('http://localhost.:3005'))
      .toBe(createServerUrlComparableKey('http://localhost:3005'));
  });

  it('keeps the port part of server identity while reachability ignores it', () => {
    // Reachability is a property of the host alone.
    expect(isLoopbackHostname('localhost')).toBe(true);

    // Identity is not: two relays on one machine are two servers.
    expect(createServerUrlComparableKey('http://localhost:3005'))
      .not.toBe(createServerUrlComparableKey('http://localhost:3012'));
  });
});
