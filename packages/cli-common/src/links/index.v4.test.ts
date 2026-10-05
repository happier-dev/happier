import { describe, expect, it } from 'vitest';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';

import {
  buildTerminalConnectLinks,
  buildTerminalConnectUrlOnlyCompatibilityLinks,
} from './index';

const DESCRIPTOR: HomeConnectionDescriptorV1 = {
  v: 1,
  homeServerIdentityId: 'srv_home_link_v4',
  canonicalServerUrl: 'https://home.example.test',
  revision: 1,
  endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
};

describe('terminal connect descriptor link V4', () => {
  it('appends the route to the pathname while preserving the webapp query and opaque payload', () => {
    const params = {
      homeConnectionDescriptor: DESCRIPTOR,
      publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      pairing: { secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', createdAtMs: 1_000, expiresAtMs: 61_000 },
    };
    const reference = new URL(buildTerminalConnectLinks({ ...params, webappUrl: 'https://app.happier.dev' }).webUrl);
    const links = buildTerminalConnectLinks({
      ...params,
      webappUrl: 'https://app.happier.dev/happier/?server=https%3A%2F%2Fhome.example.test&happier_hmr=0#old',
    });
    const web = new URL(links.webUrl);
    expect(web.pathname).toBe('/happier/terminal/connect');
    expect(web.searchParams.get('server')).toBe('https://home.example.test');
    expect(web.searchParams.get('happier_hmr')).toBe('0');
    expect(web.hash).toBe(reference.hash);
    expect([...new URLSearchParams(web.hash.slice(1)).keys()]).toEqual(['v4']);
  });

  it('emits only an opaque V4 parameter for descriptor targets', () => {
    const links = buildTerminalConnectLinks({
      webappUrl: 'https://app.happier.dev',
      homeConnectionDescriptor: DESCRIPTOR,
      publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      pairing: {
        secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
      },
      supportsTokenOnly: true,
    });

    for (const link of [links.webUrl, links.mobileUrl]) {
      const parameters = new URL(link.replace('#', '?')).searchParams;
      expect([...parameters.keys()]).toEqual(['v4']);
      expect(parameters.has('key')).toBe(false);
      expect(parameters.has('server')).toBe(false);
      expect(parameters.has('serverIdentityId')).toBe(false);
    }
  });

  it('keeps URL-only compatibility behind its explicit builder', () => {
    const links = buildTerminalConnectUrlOnlyCompatibilityLinks({
      webappUrl: 'https://app.happier.dev',
      serverUrl: 'https://home.example.test',
      publicKeyB64Url: 'terminal-key',
    });

    expect(links.webUrl).toContain('#key=terminal-key&server=');
    expect(links.mobileUrl).toContain('?key=terminal-key&server=');
    expect(links.webUrl).not.toContain('v4=');
  });
});
