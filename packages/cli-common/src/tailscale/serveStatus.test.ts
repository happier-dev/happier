import { describe, expect, it } from 'vitest';

import {
  extractTailscaleServeHttpsUrl,
  parseTailscaleServeHttpsBaseUrlForPort,
  tailscaleServeHttpsUrlForInternalServerUrlFromStatus,
  tailscaleServeStatusMatchesInternalServerUrl,
} from './serveStatus.js';

describe('parseTailscaleServeHttpsBaseUrlForPort', () => {
  it('returns the https base URL for the matching proxied port when multiple sections exist', () => {
    const status = [
      'https://a.tailnet.ts.net',
      '|-- / proxy http://127.0.0.1:1234',
      '',
      'https://b.tailnet.ts.net/',
      '|-- / proxy http://localhost:3005',
      '',
    ].join('\n');

    expect(parseTailscaleServeHttpsBaseUrlForPort(status, 3005)).toBe('https://b.tailnet.ts.net');
  });

  it('returns null when the requested port is not proxied', () => {
    const status = [
      'https://a.tailnet.ts.net',
      '|-- / proxy http://127.0.0.1:1234',
      '',
    ].join('\n');

    expect(parseTailscaleServeHttpsBaseUrlForPort(status, 3005)).toBeNull();
  });
});

describe('tailscaleServeHttpsUrlForInternalServerUrlFromStatus', () => {
  it('matches the comparable public URL for a loopback upstream by port', () => {
    const status = [
      'https://wrong.tailnet.ts.net',
      '|-- / proxy http://127.0.0.1:8080',
      '',
      'https://relay.tailnet.ts.net',
      '|-- / proxy http://0.0.0.0:3005',
      '',
    ].join('\n');

    expect(tailscaleServeHttpsUrlForInternalServerUrlFromStatus(status, 'http://127.0.0.1:3005')).toBe(
      'https://relay.tailnet.ts.net',
    );
  });
});

describe('extractTailscaleServeHttpsUrl', () => {
  it('returns the first normalized https URL from serve status', () => {
    const status = [
      'something',
      'https://my-machine.tailnet.ts.net/',
      '|-- / proxy http://127.0.0.1:53545',
      '',
    ].join('\n');

    expect(extractTailscaleServeHttpsUrl(status)).toBe('https://my-machine.tailnet.ts.net');
  });
});

describe('tailscaleServeStatusMatchesInternalServerUrl', () => {
  it('matches an exact internal URL', () => {
    const status = [
      'https://my-machine.tailnet.ts.net',
      '|-- / proxy http://127.0.0.1:53545',
      '',
    ].join('\n');

    expect(tailscaleServeStatusMatchesInternalServerUrl(status, 'http://127.0.0.1:53545')).toBe(true);
  });
});
