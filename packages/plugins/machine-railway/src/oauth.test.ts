import { describe, expect, it } from 'vitest';
import type {
  ConnectedAccountAuthenticationContext, ConnectedAccountCredentialStore, ConnectedAccountMutationContext,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { connectedAccountRuntime } from './account.js';

const callbackUrl = 'https://home.test/oauth/connected-account/callback';
const clientId = 'home-public-client';

function fixture(publicClient = false) {
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
  let finalUrl: string | undefined;
  let body: unknown = { token_type: 'Bearer', access_token: 'access-two', refresh_token: 'refresh-two', expires_in: 3600 };
  const context = {
    signal: new AbortController().signal,
    configuration: {
      target: { modeId: 'oauth' },
      values: { workspaceId: 'workspace', projectId: 'project', environmentId: 'environment' },
      getPublicOAuthClient: async () => publicClient ? { clientId, scopes: ['openid', 'offline_access'] } : null,
    },
    credentials: credentials(data),
    stagedCredentials: credentials(staged),
    attemptCredentials: credentials(new Map()),
    services: { http: { async request(request: HttpRequest) {
      requests.push(request);
      return { status, finalUrl: finalUrl ?? request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    } } },
  };
  return {
    requests, data, staged,
    // Only credential-store and HTTP boundaries are required by these runtime calls.
    context: context as unknown as ConnectedAccountMutationContext,
    attempt: context as unknown as ConnectedAccountAuthenticationContext,
    reply(nextStatus: number, nextBody: unknown, nextFinalUrl?: string) { status = nextStatus; body = nextBody; finalUrl = nextFinalUrl; },
  };
}

function form(request: HttpRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(request.body as Uint8Array)));
}

describe('Railway public OAuth lifecycle', () => {
  it('refuses an unconfigured Home before doing vendor HTTP', async () => {
    const probe = fixture();
    const mode = connectedAccountRuntime.authentication.modes.oauth;
    expect(mode?.kind).toBe('oauthAuthorizationCode');
    if (mode?.kind !== 'oauthAuthorizationCode') throw new Error('OAuth mode missing');
    expect(await mode.begin({ callbackUrl, state: 'state', pkce: { method: 'S256', challenge: 'challenge' } }, probe.attempt))
      .toMatchObject({ status: 'unavailable', diagnostic: { code: 'railway_oauth_public_client_unavailable' } });
    expect(probe.requests).toHaveLength(0);
  });

  it('rejects a whitespace PKCE challenge before offering a Railway authorization URL', async () => {
    const probe = fixture(true);
    const mode = connectedAccountRuntime.authentication.modes.oauth;
    if (mode?.kind !== 'oauthAuthorizationCode') throw new Error('OAuth mode missing');
    expect(await mode.begin({ callbackUrl, state: 'state', pkce: { method: 'S256', challenge: ' ' } }, probe.attempt))
      .toMatchObject({ status: 'rejected', diagnostic: { code: 'railway_oauth_reconnect_required' } });
    expect(probe.requests).toHaveLength(0);
  });

  it('sends the Home callback, scopes and PKCE with Railway offline consent', async () => {
    const probe = fixture(true);
    const mode = connectedAccountRuntime.authentication.modes.oauth;
    if (mode?.kind !== 'oauthAuthorizationCode') throw new Error('OAuth mode missing');
    const result = await mode.begin({ callbackUrl, state: 'state', pkce: { method: 'S256', challenge: 'challenge' } }, probe.attempt);
    if (result.status !== 'awaitingOAuthRedirect') throw new Error(result.status);
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://backboard.railway.com/oauth/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: clientId, redirect_uri: callbackUrl, response_type: 'code', scope: 'openid offline_access',
      state: 'state', code_challenge: 'challenge', code_challenge_method: 'S256', prompt: 'consent',
    });
  });

  it.each([[302, undefined], [200, 'https://other.test/token']] as const)(
    'leaves the old grant in place when the credential endpoint response is not from the exact URL (%s)',
    async (status, finalUrl) => {
      const probe = fixture();
      probe.reply(status, { token_type: 'Bearer', access_token: 'access-two', refresh_token: 'refresh-two', expires_in: 3600 }, finalUrl);
      expect(await connectedAccountRuntime.refresh(probe.context)).toMatchObject({ status: 'outcomeUnknown' });
      expect(probe.data.get('refreshToken')).toBe('refresh-one');
      expect(probe.staged.size).toBe(0);
      expect(probe.requests).toHaveLength(1);
    },
  );

  it('stages the rotated pair for the refresh coordinator to settle', async () => {
    const probe = fixture();
    expect(await connectedAccountRuntime.refresh(probe.context)).toMatchObject({
      status: 'connected', expiresAt: expect.any(Number),
    });
    expect(probe.requests).toHaveLength(1);
    const request = probe.requests[0]!;
    expect(request).toMatchObject({ url: 'https://backboard.railway.com/oauth/token', method: 'POST', redirect: 'error' });
    expect(form(request)).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-one', client_id: clientId });
    expect(probe.data.get('refreshToken')).toBe('refresh-one');
    expect(Object.fromEntries(probe.staged)).toMatchObject({ token: 'access-two', refreshToken: 'refresh-two' });
  });

  it('requires reconnect after a refused refresh grant', async () => {
    const probe = fixture();
    probe.reply(400, { error: 'invalid_grant', error_description: 'refresh-one' });
    const result = await connectedAccountRuntime.refresh(probe.context);
    expect(result).toMatchObject({ status: 'reconnectRequired', diagnostic: { code: 'railway_oauth_reconnect_required' } });
    expect(JSON.stringify(result)).not.toContain('refresh-one');
    expect(probe.staged.size).toBe(0);
    expect(probe.requests).toHaveLength(1);
  });
  it('returns the existing manual Disconnect outcome without a vendor request', async () => {
    const probe = fixture();
    expect(await connectedAccountRuntime.revoke(probe.context)).toMatchObject({
      status: 'remoteUnsupported', diagnostic: { code: 'railway_oauth_manual_revoke_required' },
    });
    expect(probe.requests).toHaveLength(0);
  });
});
