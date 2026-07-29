import { describe, expect, it } from 'vitest';

import { assertPublicNpmNetworkAddresses, assertSafeNpmHttpsUrl } from './networkPolicy';

describe('npm network policy', () => {
  it.each(['127.0.0.1', '10.1.2.3', '169.254.1.1', '192.168.1.1', '::1', 'fc00::1', 'fe80::1', '::127.0.0.1', '64:ff9b::7f00:1'])('rejects private or local address %s', (address) => {
    expect(() => assertPublicNpmNetworkAddresses([address])).toThrow(/private|local|public/i);
  });

  it('requires every DNS answer to be public to close rebinding and mixed-answer bypasses', () => {
    expect(() => assertPublicNpmNetworkAddresses(['93.184.216.34', '127.0.0.1'])).toThrow(/private|local|public/i);
    expect(assertPublicNpmNetworkAddresses(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])).toEqual(undefined);
  });

  it.each(['http://registry.example.test/x', 'https://user:secret@registry.example.test/x'])('rejects unsafe request URL %s', (url) => {
    expect(() => assertSafeNpmHttpsUrl(url)).toThrow(/https|credentials/i);
  });
});
