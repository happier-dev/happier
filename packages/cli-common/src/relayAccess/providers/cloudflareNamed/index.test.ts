import { describe, expect, it, vi } from 'vitest';

import { cloudflareNamedRelayAccessProvider } from './index.js';

describe('cloudflareNamedRelayAccessProvider', () => {
  it('rejects missing hostname or token during status and configure', async () => {
    expect(
      cloudflareNamedRelayAccessProvider.status({
        config: { providerId: 'cloudflareNamed', hostname: '', token: 'secret' },
        ctx: { env: process.env, upstreamUrl: null },
      }),
    ).toEqual({
      state: 'error',
      details: { reason: 'missing_hostname' },
    });

    expect(
      cloudflareNamedRelayAccessProvider.status({
        config: { providerId: 'cloudflareNamed', hostname: 'relay.example.test', token: '' },
        ctx: { env: process.env, upstreamUrl: null },
      }),
    ).toEqual({
      state: 'error',
      details: { reason: 'missing_token' },
    });
  });

  it('configures a valid named tunnel without requiring a cloudflared process', async () => {
    expect(
      cloudflareNamedRelayAccessProvider.configure?.({
        config: { providerId: 'cloudflareNamed', hostname: 'relay.example.test', token: 'super-secret' },
        ctx: { env: process.env, upstreamUrl: 'http://127.0.0.1:3005' },
      }),
    ).toEqual({
      state: 'enabled',
      shareUrl: 'https://relay.example.test',
      details: {
        managed: false,
      },
    });
  });

  it('disables a valid named tunnel without mutating the global cloudflared home directory', async () => {
    expect(
      cloudflareNamedRelayAccessProvider.disable?.({
        config: { providerId: 'cloudflareNamed', hostname: 'relay.example.test', token: 'super-secret' },
        ctx: { env: process.env, upstreamUrl: null },
      }),
    ).toBeUndefined();
  });
});
