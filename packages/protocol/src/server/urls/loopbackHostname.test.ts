import { describe, expect, it } from 'vitest';

import { isLoopbackHostname } from './loopbackHostname.js';

describe('isLoopbackHostname', () => {
  it('recognises an IPv6 literal with the brackets URL parsing leaves on', () => {
    // `new URL('http://[::1]:3005').hostname` returns "[::1]". Comparing that
    // string to '::1' is the miss that ships silently.
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
  });

  it('recognises the whole 127.0.0.0/8 range', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('127.0.0.2')).toBe(true);
    expect(isLoopbackHostname('127.255.255.254')).toBe(true);
  });

  it('recognises localhost and the reserved .localhost TLD', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('relay.localhost')).toBe(true);
  });

  it('ignores a trailing dot and letter case', () => {
    expect(isLoopbackHostname('LocalHost.')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1.')).toBe(true);
  });

  it('does not treat an all-interfaces bind as loopback', () => {
    // 0.0.0.0 means every interface, not this machine. Callers that also want
    // to reject it say so themselves.
    expect(isLoopbackHostname('0.0.0.0')).toBe(false);
  });

  it('does not treat LAN, tailnet or public hosts as loopback', () => {
    expect(isLoopbackHostname('192.168.1.9')).toBe(false);
    expect(isLoopbackHostname('100.84.140.109')).toBe(false);
    expect(isLoopbackHostname('relay.example.com')).toBe(false);
    expect(isLoopbackHostname('studio.example.ts.net')).toBe(false);
  });

  it('rejects malformed input rather than guessing', () => {
    expect(isLoopbackHostname('')).toBe(false);
    expect(isLoopbackHostname('127.0.0.999')).toBe(false);
    expect(isLoopbackHostname('127.0.0')).toBe(false);
    expect(isLoopbackHostname('notlocalhost')).toBe(false);
  });
});
