import { describe, expect, it } from 'vitest';

import { buildConfigureServerLinks, buildTerminalConnectLinks } from './index';

describe('buildConfigureServerLinks', () => {
  it('updates the server selection without discarding the webapp path, other query parameters or fragment', () => {
    const links = buildConfigureServerLinks({
      webappUrl: 'http://localhost:19364/happier/?server=old&happier_hmr=0#view',
      serverUrl: 'http://localhost:3010',
    });
    const web = new URL(links.webUrl);
    expect(web.pathname).toBe('/happier/');
    expect(web.searchParams.getAll('server')).toEqual(['http://localhost:3010']);
    expect(web.searchParams.get('happier_hmr')).toBe('0');
    expect(web.hash).toBe('#view');
  });
});

describe('buildTerminalConnectLinks authenticated pairing identity', () => {
  it('preserves a query value ending in a slash', () => {
    const links = buildTerminalConnectLinks({
      webappUrl: 'https://app.happier.dev/?returnTo=/docs/',
      serverUrl: 'https://api.happier.dev',
      publicKeyB64Url: 'terminal-key',
    });
    expect(new URL(links.webUrl).searchParams.get('returnTo')).toBe('/docs/');
    const configure = buildConfigureServerLinks({
      webappUrl: 'https://app.happier.dev/?returnTo=/docs/',
      serverUrl: 'https://api.happier.dev',
    });
    expect(new URL(configure.webUrl).searchParams.get('returnTo')).toBe('/docs/');
  });

  it('preserves webapp query parameters and puts the pairing fragment after the route', () => {
    const links = buildTerminalConnectLinks({
      webappUrl: 'http://localhost:19364/?server=http%3A%2F%2Flocalhost%3A3010&happier_hmr=0#old-fragment',
      serverUrl: 'http://localhost:3010',
      publicKeyB64Url: 'terminal-key',
      serverIdentityId: 'srv_home_expected',
      pairing: { secretB64Url: 'pairing-secret', createdAtMs: 1_000, expiresAtMs: 61_000 },
    });
    const web = new URL(links.webUrl);
    expect(web.pathname).toBe('/terminal/connect');
    expect(web.searchParams.get('server')).toBe('http://localhost:3010');
    expect(web.searchParams.get('happier_hmr')).toBe('0');
    const pairing = new URLSearchParams(web.hash.slice(1));
    expect(pairing.get('key')).toBe('terminal-key');
    expect(pairing.get('server')).toBe('http://localhost:3010');
    expect(pairing.get('pairingSecret')).toBe('pairing-secret');
    expect(pairing.has('old-fragment')).toBe(false);
  });

  it('publishes the stable Home identity in web and mobile links', () => {
    const links = buildTerminalConnectLinks({
      webappUrl: 'https://app.happier.dev',
      serverUrl: 'https://api.happier.dev',
      publicKeyB64Url: 'terminal-key',
      serverIdentityId: 'srv_home_expected',
      pairing: {
        secretB64Url: 'pairing-secret',
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
      },
      supportsTokenOnly: true,
    });

    for (const link of [links.webUrl, links.mobileUrl]) {
      expect(new URL(link.replace('#', '?')).searchParams.get('serverIdentityId')).toBe('srv_home_expected');
    }
  });

  it('rejects authenticated pairing without a stable Home identity', () => {
    expect(() => buildTerminalConnectLinks({
      webappUrl: 'https://app.happier.dev',
      serverUrl: 'https://api.happier.dev',
      publicKeyB64Url: 'terminal-key',
      pairing: {
        secretB64Url: 'pairing-secret',
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
      },
      supportsTokenOnly: true,
    })).toThrow(/stable Home identity/);
  });

  it('rejects malformed authenticated pairing instead of emitting an unpaired link', () => {
    expect(() => buildTerminalConnectLinks({
      webappUrl: 'https://app.happier.dev',
      serverUrl: 'https://api.happier.dev',
      publicKeyB64Url: 'terminal-key',
      serverIdentityId: 'srv_home_expected',
      pairing: {
        secretB64Url: 'pairing-secret',
        createdAtMs: 61_000,
        expiresAtMs: 1_000,
      },
    })).toThrow(/malformed/);
  });
});
