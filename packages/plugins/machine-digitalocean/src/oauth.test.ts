import { describe, expect, it } from 'vitest';
import type {
  ConnectedAccountAuthenticationContext, ConnectedAccountCredentialStore, ConnectedAccountMutationContext,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { connectedAccountRuntime } from './account.js';

const callbackUrl = 'https://home.test/oauth/connected-account/callback';
const clientId = 'home-public-client';

function fixture() {
  const requests: HttpRequest[] = [];
  const data = new Map(Object.entries({
    token: 'access-one', refreshToken: 'refresh-one', expiresAtMs: String(Date.now() - 1),
    oauthClientId: clientId, subject: 'vendor-user', teamId: 'vendor-team', displayName: 'Vendor user',
  }));
  const staged = new Map<string, string>();
  const credentials = (values: Map<string, string>): ConnectedAccountCredentialStore => ({
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
  });
  let status = 200;
  let body: unknown = { token_type: 'Bearer', access_token: 'access-two', refresh_token: 'refresh-two', expires_in: 3600 };
  const context = {
    signal: new AbortController().signal,
    configuration: {
      target: { modeId: 'oauth' },
      values: { workspaceId: 'workspace', projectId: 'project', environmentId: 'environment' },
      getPublicOAuthClient: async () => null,
    },
    credentials: credentials(data),
    stagedCredentials: credentials(staged),
    attemptCredentials: credentials(new Map()),
    services: { http: { async request(request: HttpRequest) {
      requests.push(request);
      return { status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    } } },
  };
  return {
    requests, data, staged,
    // Only credential-store and HTTP boundaries are required by these runtime calls.
    context: context as unknown as ConnectedAccountMutationContext,
    attempt: context as unknown as ConnectedAccountAuthenticationContext,
    reply(nextStatus: number, nextBody: unknown) { status = nextStatus; body = nextBody; },
  };
}

function form(request: HttpRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(request.body as Uint8Array)));
}

describe('DigitalOcean public OAuth lifecycle', () => {
  it('refuses an unconfigured Home before doing vendor HTTP', async () => {
    const probe = fixture();
    const mode = connectedAccountRuntime.authentication.modes.oauth;
    expect(mode?.kind).toBe('oauthAuthorizationCode');
    if (mode?.kind !== 'oauthAuthorizationCode') throw new Error('OAuth mode missing');
    expect(await mode.begin({ callbackUrl, state: 'state', pkce: { method: 'S256', challenge: 'challenge' } }, probe.attempt))
      .toMatchObject({ status: 'unavailable', diagnostic: { code: 'digitalocean_oauth_public_client_unavailable' } });
    expect(probe.requests).toHaveLength(0);
  });

  it('stages the rotated pair for the refresh coordinator to settle', async () => {
    const probe = fixture();
    const result = await connectedAccountRuntime.refresh(probe.context);
    expect(result).toMatchObject({
      status: 'connected', expiresAt: expect.any(Number),
    });
    // DigitalOcean can omit scope on refresh. Preserve the scopes from consent.
    expect(result).not.toHaveProperty('scopes');
    expect(probe.requests).toHaveLength(1);
    const request = probe.requests[0]!;
    expect(request).toMatchObject({ url: 'https://cloud.digitalocean.com/v1/oauth/token', method: 'POST', redirect: 'error' });
    expect(form(request)).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-one' });
    expect(probe.data.get('refreshToken')).toBe('refresh-one');
    expect(Object.fromEntries(probe.staged)).toMatchObject({ token: 'access-two', refreshToken: 'refresh-two' });
  });

  it('requires reconnect after a refused refresh grant', async () => {
    const probe = fixture();
    probe.reply(400, { error: 'invalid_grant', error_description: 'refresh-one' });
    const result = await connectedAccountRuntime.refresh(probe.context);
    expect(result).toMatchObject({ status: 'reconnectRequired', diagnostic: { code: 'digitalocean_oauth_reconnect_required' } });
    expect(JSON.stringify(result)).not.toContain('refresh-one');
    expect(probe.staged.size).toBe(0);
    expect(probe.requests).toHaveLength(1);
  });
  it('does not reuse a spent refresh token if DigitalOcean omits its replacement', async () => {
    const probe = fixture();
    probe.reply(200, { token_type: 'Bearer', access_token: 'access-two', expires_in: 3600 });
    expect(await connectedAccountRuntime.refresh(probe.context)).toMatchObject({ status: 'reconnectRequired' });
    expect(probe.staged.size).toBe(0);
  });

  it.each([[200, 'remoteRevoked'], [403, 'remoteUnsupported'], [503, 'outcomeUnknown']] as const)(
    'classifies DigitalOcean Disconnect HTTP %s', async (status, expected) => {
      const probe = fixture();
      probe.reply(status, {});
      expect(await connectedAccountRuntime.revoke(probe.context)).toMatchObject({ status: expected });
      expect(probe.requests).toHaveLength(1);
      const request = probe.requests[0]!;
      expect(request).toMatchObject({
        url: 'https://cloud.digitalocean.com/v1/oauth/revoke', method: 'POST', redirect: 'error',
      });
      expect(new Headers(request.headers).get('authorization')).toBe('Bearer access-one');
      expect(form(request)).toEqual({ token: 'access-one' });
    },
  );
});
