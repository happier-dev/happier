import { describe, expect, it } from 'vitest';
import type {
  ConnectedAccountAuthenticationContext,
  ConnectedAccountCredentialStore,
  ConnectedAccountMutationContext,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { connectedAccountRuntime } from './account.js';
import { PLUGIN_MANIFEST } from './manifest.js';

const callbackUrl = 'https://home.test/oauth/connected-account/callback';
const clientId = 'boatapp_public';
const tokenUrl = 'https://boat.dev/api/boat/oauth2/token';
const revokeUrl = 'https://boat.dev/api/boat/oauth2/revoke';
const grant = {
  token_type: 'Bearer', access_token: 'boat_new', refresh_token: 'boatrt_new', expires_in: 3600,
  scope: 'sandbox.read account.read',
};

function fixture(publicClient = true) {
  const requests: HttpRequest[] = [];
  const saved = new Map([['token', 'boat_old'], ['refreshToken', 'boatrt_old'], ['oauthClientId', clientId]]);
  const staged = new Map<string, string>();
  const attempt = new Map<string, string>();
  const credentials = (values: Map<string, string>): ConnectedAccountCredentialStore => ({
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
  });
  let status = 200;
  let body: unknown = grant;
  const context = {
    signal: new AbortController().signal,
    configuration: {
      target: { modeId: 'oauth' }, values: {},
      getPublicOAuthClient: async () => publicClient ? { clientId, scopes: ['account.read', 'sandbox.read'] } : null,
    },
    services: { http: { async request(request: HttpRequest) {
      requests.push(request);
      return { status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    } } },
    credentials: credentials(saved),
    stagedCredentials: credentials(staged),
    attemptCredentials: credentials(attempt),
  };
  return { requests, saved, staged, attempt,
    auth: context as unknown as ConnectedAccountAuthenticationContext,
    mutation: context as unknown as ConnectedAccountMutationContext,
    reply(code: number, value: unknown) { status = code; body = value; },
  };
}

function oauth() {
  const mode = connectedAccountRuntime.authentication.modes.oauth;
  if (mode?.kind !== 'oauthAuthorizationCode') throw new Error('Missing Boat OAuth mode');
  return mode;
}

function form(request: HttpRequest) {
  return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(request.body)));
}

describe('Boat public OAuth', () => {
  it('keeps API-key connections and declares a PKCE mode for machines and prepared snapshots', () => {
    const authentication = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(value => value.id === 'boat-account')?.authentication;
    expect(authentication?.defaultModeId).toBe('token');
    expect(authentication?.modes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'token', kind: 'manual' }),
      expect.objectContaining({ id: 'oauth', kind: 'oauthAuthorizationCode', pkce: 'required',
        scopes: [
          'account.read', 'sandbox.read', 'sandbox.create', 'sandbox.update', 'sandbox.stop', 'sandbox.resume',
          'sandbox.fork', 'sandbox.delete', 'ssh', 'exec', 'file.write', 'snapshot.read', 'snapshot.write',
        ],
      }),
    ]));
  });

  it('fails closed when the requesting Home has no public client', async () => {
    const probe = fixture(false);
    await expect(oauth().begin({ callbackUrl, state: 'attempt-state', pkce: { method: 'S256', challenge: 'challenge' } }, probe.auth))
      .resolves.toMatchObject({ status: 'unavailable', diagnostic: { code: 'boat_oauth_public_client_unavailable' } });
    expect(probe.attempt.size).toBe(0);
  });

  it('exchanges the callback with the original public client and saves the granted scopes', async () => {
    const probe = fixture();
    const begun = await oauth().begin({ callbackUrl, state: 'attempt-state', pkce: { method: 'S256', challenge: 'challenge' } }, probe.auth);
    if (begun.status !== 'awaitingOAuthRedirect') throw new Error(begun.status);
    const url = new URL(begun.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://boat.dev/api/boat/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: clientId, redirect_uri: callbackUrl, response_type: 'code', scope: 'account.read sandbox.read',
      state: 'attempt-state', code_challenge: 'challenge', code_challenge_method: 'S256',
    });
    expect(begun.issuer).toBe('https://boat.dev');
    await expect(oauth().complete({ code: 'auth-code', callbackUrl, pkceVerifier: 'verifier' }, probe.auth))
      .resolves.toMatchObject({ status: 'connected', scopes: ['sandbox.read', 'account.read'], expiresAt: expect.any(Number) });
    expect(probe.requests[0]).toMatchObject({ url: tokenUrl, method: 'POST', redirect: 'error' });
    expect(form(probe.requests[0]!)).toEqual({
      grant_type: 'authorization_code', client_id: clientId, redirect_uri: callbackUrl, code: 'auth-code', code_verifier: 'verifier',
    });
    expect(Object.fromEntries(probe.attempt)).toMatchObject({ token: grant.access_token, refreshToken: grant.refresh_token, oauthClientId: clientId });
  });

  it('stages a new bearer and refresh token for owner settlement', async () => {
    const probe = fixture();
    await expect(connectedAccountRuntime.refresh(probe.mutation)).resolves.toMatchObject({ status: 'connected', scopes: ['sandbox.read', 'account.read'] });
    expect(probe.requests).toHaveLength(1);
    expect(form(probe.requests[0]!)).toEqual({ grant_type: 'refresh_token', refresh_token: 'boatrt_old', client_id: clientId });
    expect(Object.fromEntries(probe.staged)).toMatchObject({ token: grant.access_token, refreshToken: grant.refresh_token });
    expect(probe.saved.get('refreshToken')).toBe('boatrt_old');
  });

  it('keeps the last granted scopes if a refresh reply omits unchanged scopes', async () => {
    const probe = fixture();
    probe.saved.set('scope', 'sandbox.read');
    probe.reply(200, { ...grant, scope: undefined });
    await expect(connectedAccountRuntime.refresh(probe.mutation))
      .resolves.toMatchObject({ status: 'connected', scopes: ['sandbox.read'] });
    expect(Object.fromEntries(probe.staged)).toMatchObject({ refreshToken: grant.refresh_token, scope: 'sandbox.read' });
  });

  it.each([undefined, 'boatrt_old'])('requires reconnect when Boat does not return a new refresh token (%s)', async refreshToken => {
    const probe = fixture();
    probe.reply(200, { ...grant, refresh_token: refreshToken });
    await expect(connectedAccountRuntime.refresh(probe.mutation)).resolves.toMatchObject({ status: 'reconnectRequired' });
    expect(probe.staged.size).toBe(0);
  });

  it('revokes the retained refresh grant without exposing a vendor refusal body', async () => {
    const probe = fixture();
    await expect(connectedAccountRuntime.revoke(probe.mutation)).resolves.toEqual({ status: 'remoteRevoked' });
    expect(probe.requests[0]).toMatchObject({ url: revokeUrl, method: 'POST', redirect: 'error' });
    expect(form(probe.requests[0]!)).toEqual({ token: 'boatrt_old' });
    probe.reply(503, { token: 'boatrt_old' });
    const refused = await connectedAccountRuntime.revoke(probe.mutation);
    expect(refused).toMatchObject({ status: 'outcomeUnknown' });
    expect(JSON.stringify(refused)).not.toContain('boatrt_old');
  });
});
