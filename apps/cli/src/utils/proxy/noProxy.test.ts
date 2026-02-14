import { describe, it, expect } from 'vitest';

import { isNoProxyMatch, parseNoProxy } from './noProxy';

describe('noProxy', () => {
  it('matches everything when NO_PROXY contains "*"', () => {
    const rules = parseNoProxy('*,example.com');
    expect(isNoProxyMatch({ hostname: 'example.com', port: 443, rules })).toBe(true);
    expect(isNoProxyMatch({ hostname: 'api.internal', port: 443, rules })).toBe(true);
  });

  it('matches exact hostnames', () => {
    const rules = parseNoProxy('example.com');
    expect(isNoProxyMatch({ hostname: 'example.com', port: 443, rules })).toBe(true);
    expect(isNoProxyMatch({ hostname: 'sub.example.com', port: 443, rules })).toBe(false);
  });

  it('matches dot-suffix domains (".example.com")', () => {
    const rules = parseNoProxy('.example.com');
    expect(isNoProxyMatch({ hostname: 'example.com', port: 443, rules })).toBe(true);
    expect(isNoProxyMatch({ hostname: 'sub.example.com', port: 443, rules })).toBe(true);
    expect(isNoProxyMatch({ hostname: 'other.com', port: 443, rules })).toBe(false);
  });

  it('matches wildcard suffix domains ("*.example.com")', () => {
    const rules = parseNoProxy('*.example.com');
    expect(isNoProxyMatch({ hostname: 'example.com', port: 443, rules })).toBe(false);
    expect(isNoProxyMatch({ hostname: 'sub.example.com', port: 443, rules })).toBe(true);
  });

  it('matches host:port rules only for that port', () => {
    const rules = parseNoProxy('example.com:443,example.net:80');
    expect(isNoProxyMatch({ hostname: 'example.com', port: 443, rules })).toBe(true);
    expect(isNoProxyMatch({ hostname: 'example.com', port: 80, rules })).toBe(false);
    expect(isNoProxyMatch({ hostname: 'example.net', port: 80, rules })).toBe(true);
    expect(isNoProxyMatch({ hostname: 'example.net', port: 443, rules })).toBe(false);
  });
});

