import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPluginHttpFixture,
  createPluginTestkit,
  type PluginTestkit,
} from '@happier-dev/plugin-sdk/testing';
import type {
  ConnectedAccountAuthenticationContext,
  ConnectedAccountCredentialStore,
  ConnectedAccountMutationContext,
  ConnectedAccountReadContext,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { PluginConnectedAccountAuthenticationModeV2Schema } from '@happier-dev/protocol';
import * as entry from './index.js';

// Constructed vectors from Vercel's OIDC discovery and documented REST schemas
// (read 2026-11-18), not tenant captures:
// https://vercel.com/.well-known/openid-configuration
// https://vercel.com/docs/sign-in-with-vercel
const service = {
  pluginId: 'happier.machine.vercel',
  localId: 'vercel-account',
};
const callbackUrl =
  'https://cloud.happier.dev/oauth/connected-account/callback';
const clientId = 'cl_public_client';
const teamId = 'team_example';
const kits: PluginTestkit[] = [];
afterEach(async () => {
  await Promise.all(kits.splice(0).map((kit) => kit.dispose()));
});

function credentials(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  const store: ConnectedAccountCredentialStore = {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value, options) {
      options?.signal?.throwIfAborted();
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
  return { values, store };
}

type Route = { status: number; body?: unknown } | Error;

async function harness(
  options: {
    attempt?: 'connect' | 'reconnect';
    values?: Record<string, string>;
    publicClient?: boolean;
    teams?: readonly { id: string; name: string }[];
    retained?: Record<string, string>;
  } = {},
) {
  const kit = await createPluginTestkit({
    manifest: entry.manifest,
    module: entry,
  });
  kits.push(kit);
  const runtime = kit.registration(
    'connectedAccountDescriptors',
    service.localId,
  );
  if (!runtime) throw new Error('Missing activated Vercel runtime');
  const mode = runtime.authentication.modes['oauth'];
  if (!mode || mode.kind !== 'oauthAuthorizationCode')
    throw new Error('Missing Vercel OAuth mode');
  const teams = options.teams ?? [{ id: teamId, name: 'Example team' }];
  const routes = new Map<string, Route>([
    [
      '/login/oauth/token',
      {
        status: 200,
        body: {
          token_type: 'Bearer',
          access_token: 'access-private',
          refresh_token: 'refresh-private',
          expires_in: 3600,
          scope: 'openid email profile offline_access',
        },
      },
    ],
    [
      '/login/oauth/userinfo',
      {
        status: 200,
        body: {
          sub: 'user_subject',
          email: 'person@example.com',
          preferred_username: 'person',
        },
      },
    ],
    ['/login/oauth/token/revoke', { status: 200 }],
    ['/v2/teams', { status: 200, body: { teams, pagination: { next: null } } }],
  ]);
  for (const team of teams)
    routes.set(`/v2/teams/${team.id}`, {
      status: 200,
      body: { id: team.id, name: team.name, slug: team.id },
    });
  const requests: HttpRequest[] = [];
  const request = vi.fn(async (input: HttpRequest) => {
    requests.push(input);
    const route = routes.get(new URL(input.url).pathname);
    if (route instanceof Error) throw route;
    const status = route?.status ?? 404;
    return {
      status,
      finalUrl: input.url,
      headers: {},
      body:
        route?.body === undefined
          ? new Uint8Array()
          : new TextEncoder().encode(JSON.stringify(route.body)),
    };
  });
  const getPublicOAuthClient = vi.fn(async () =>
    options.publicClient === false
      ? null
      : { clientId, scopes: ['openid', 'email', 'profile', 'offline_access'] },
  );
  const values: Record<string, string> = { ...options.values };
  const attempt =
    options.attempt === 'reconnect'
      ? {
          kind: 'reconnect' as const,
          attemptId: 'attempt-1',
          account: { service, accountId: 'host-account' },
        }
      : { kind: 'connect' as const, attemptId: 'attempt-1' };
  const configuration = {
    target: {
      kind: 'attempt' as const,
      attemptId: 'attempt-1',
      service,
      modeId: 'oauth',
    },
    revision: 'configuration-1',
    values,
    async getSecret() {
      return null;
    },
    getPublicOAuthClient,
  };
  const staged = credentials();
  const retained = credentials(options.retained);
  const stagedConfigurations: unknown[] = [];
  const controller = new AbortController();
  const services = {
    http: createPluginHttpFixture({ request }),
  } as ConnectedAccountAuthenticationContext['services'];
  const common = {
    plugin: { id: service.pluginId, version: entry.manifest.version },
    contribution: {
      id: service.localId,
      qualifiedId: `${service.pluginId}/${service.localId}`,
    },
    surface: 'background' as const,
    invokedAtMs: Date.now(),
    services,
    signal: controller.signal,
  };
  const authentication: ConnectedAccountAuthenticationContext = {
    ...common,
    service,
    attempt,
    configuration,
    attemptCredentials: staged.store,
    async stageAccountConfiguration(input) {
      stagedConfigurations.push(input);
      Object.assign(values, input.values);
    },
  };
  const account = { service, accountId: 'host-account' };
  const readConfiguration = {
    ...configuration,
    target: { kind: 'account' as const, account, modeId: 'oauth' },
  };
  const read: ConnectedAccountReadContext = {
    ...common,
    account,
    configuration: readConfiguration,
    credentials: retained.store,
  };
  const mutation: ConnectedAccountMutationContext = {
    ...read,
    stagedCredentials: staged.store,
    operation: {
      operationId: 'refresh-1',
      configurationRevision: 'configuration-1',
    },
  };
  return {
    runtime,
    mode,
    authentication,
    read,
    mutation,
    staged,
    retained,
    requests,
    routes,
    values,
    stagedConfigurations,
    getPublicOAuthClient,
  };
}

function form(request: HttpRequest | undefined) {
  expect(request?.method).toBe('POST');
  expect(request?.headers).not.toHaveProperty('authorization');
  return new URLSearchParams(
    new TextDecoder().decode(request?.body as Uint8Array),
  );
}
const pkce = { method: 'S256' as const, challenge: 'challenge-value' };
const completion = {
  code: 'code-private',
  callbackUrl,
  state: 'attempt-1.nonce',
  pkceVerifier: 'verifier-private',
};
const signedIn = {
  token: 'access-private',
  refreshToken: 'refresh-private',
  expiresAtMs: String(Date.now() + 3_600_000),
  oauthClientId: clientId,
  subject: 'user_subject',
  email: 'person@example.com',
};

describe('Sign in with Vercel (public PKCE client on the daemon)', () => {
  it('declares sign-in as the default mode beside the token mode, through the Home relay', () => {
    const descriptor =
      entry.manifest.contributes?.connectedAccountDescriptors?.find(
        (d) => d.id === service.localId,
      );
    expect(descriptor?.authentication?.defaultModeId).toBe('oauth');
    expect(descriptor?.authentication?.modes.map((mode) => mode.id)).toEqual([
      'oauth',
      'token',
    ]);
    const mode = descriptor?.authentication?.modes.find(
      (item) => item.id === 'oauth',
    );
    expect(
      PluginConnectedAccountAuthenticationModeV2Schema.safeParse(mode).success,
    ).toBe(true);
    expect(mode).toMatchObject({
      kind: 'oauthAuthorizationCode',
      pkce: 'required',
      scopes: ['openid', 'email', 'profile', 'offline_access'],
      postAuthenticationFieldIds: ['teamId', 'projectId'],
    });
    expect(mode).not.toHaveProperty('callbackUrl');
    expect(mode).not.toHaveProperty('clientConfiguration');
  });

  it.each([
    ['connect', false],
    ['reconnect', true],
  ] as const)(
    'begins a %s with the Home public client and PKCE (prompt=consent: %s)',
    async (attempt, consent) => {
      const h = await harness({ attempt });
      const result = await h.mode.begin(
        { callbackUrl, state: 'attempt-1.nonce', pkce },
        h.authentication,
      );
      expect(result).toMatchObject({
        status: 'awaitingOAuthRedirect',
        issuer: 'https://vercel.com',
      });
      if (result.status !== 'awaitingOAuthRedirect')
        throw new Error('expected a redirect');
      const url = new URL(result.authorizationUrl);
      expect(url.origin + url.pathname).toBe(
        'https://vercel.com/oauth/authorize',
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: clientId,
        redirect_uri: callbackUrl,
        response_type: 'code',
        scope: 'openid email profile offline_access',
        state: 'attempt-1.nonce',
        code_challenge: 'challenge-value',
        code_challenge_method: 'S256',
        ...(consent ? { prompt: 'consent' } : {}),
      });
      // Refresh and revoke keep the client that issued the grant.
      expect(h.staged.values.get('oauthClientId')).toBe(clientId);
      expect(h.requests).toHaveLength(0);
    },
  );

  it('says sign-in is unavailable when the Home offers no Vercel client', async () => {
    const h = await harness({ publicClient: false });
    const result = await h.mode.begin(
      { callbackUrl, state: 'attempt-1.nonce', pkce },
      h.authentication,
    );
    expect(result).toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'vercel_oauth_public_client_unavailable' },
    });
  });

  it('exchanges the code with client_id only, reads userinfo, chooses the only team and stages the grant', async () => {
    const h = await harness();
    await h.mode.begin(
      { callbackUrl, state: 'attempt-1.nonce', pkce },
      h.authentication,
    );
    const result = await h.mode.complete(completion, h.authentication);
    expect(result).toMatchObject({
      status: 'connected',
      displayName: 'Example team',
      providerIdentity: {
        accountId: 'user_subject',
        email: 'person@example.com',
        organizationId: teamId,
      },
    });
    const exchange = form(h.requests[0]);
    expect(h.requests[0]?.url).toBe('https://api.vercel.com/login/oauth/token');
    expect(Object.fromEntries(exchange)).toEqual({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: 'code-private',
      redirect_uri: callbackUrl,
      code_verifier: 'verifier-private',
    });
    expect(h.requests.map((item) => new URL(item.url).pathname)).toEqual([
      '/login/oauth/token',
      '/login/oauth/userinfo',
      '/v2/teams',
      `/v2/teams/${teamId}`,
    ]);
    expect(h.requests[1]?.headers).toMatchObject({
      authorization: 'Bearer access-private',
    });
    expect(h.values.teamId).toBe(teamId);
    expect(Object.fromEntries(h.staged.values)).toMatchObject({
      token: 'access-private',
      refreshToken: 'refresh-private',
      oauthClientId: clientId,
      subject: 'user_subject',
    });
    expect(Number(h.staged.values.get('expiresAtMs'))).toBeGreaterThan(
      Date.now(),
    );
    expect(JSON.stringify(result)).not.toMatch(/private/u);
  });

  it('offers the granted teams and connects the chosen one with the staged grant at reconcile', async () => {
    const h = await harness({
      teams: [
        { id: teamId, name: 'Example team' },
        { id: 'team_other', name: 'Other team' },
      ],
    });
    await h.mode.begin(
      { callbackUrl, state: 'attempt-1.nonce', pkce },
      h.authentication,
    );
    const pending = await h.mode.complete(completion, h.authentication);
    expect(pending).toMatchObject({
      status: 'configurationRequired',
      fields: [{ id: 'teamId', schema: { enum: [teamId, 'team_other'] } }],
    });
    expect(h.staged.values.get('token')).toBe('access-private');
    h.values.teamId = 'team_other';
    if (!h.mode.reconcile)
      throw new Error('OAuth mode must reconcile a team choice');
    const result = await h.mode.reconcile(h.authentication);
    expect(result).toMatchObject({
      status: 'connected',
      displayName: 'Other team',
      providerIdentity: {
        accountId: 'user_subject',
        email: 'person@example.com',
        organizationId: 'team_other',
      },
    });
    // One token call and one userinfo read per connect.
    expect(h.requests.map((item) => new URL(item.url).pathname)).toEqual([
      '/login/oauth/token',
      '/login/oauth/userinfo',
      '/v2/teams',
      '/v2/teams/team_other',
    ]);
  });

  it('rejects a refused code without staging anything', async () => {
    const h = await harness();
    h.routes.set('/login/oauth/token', {
      status: 400,
      body: { error: 'invalid_grant' },
    });
    const result = await h.mode.complete(completion, h.authentication);
    expect(result).toMatchObject({
      status: 'rejected',
      diagnostic: { code: 'vercel_oauth_reconnect_required' },
    });
    expect(h.staged.values.size).toBe(0);
  });

  it('refreshes with the retained client_id, stages the rotated pair and makes no other vendor call', async () => {
    const h = await harness({ values: { teamId }, retained: signedIn });
    h.routes.set('/login/oauth/token', {
      status: 200,
      body: {
        token_type: 'bearer',
        access_token: 'access-rotated-private',
        refresh_token: 'refresh-rotated-private',
        expires_in: 3600,
      },
    });
    const result = await h.runtime.refresh(h.mutation);
    expect(result).toMatchObject({
      status: 'connected',
      providerIdentity: { accountId: 'user_subject', organizationId: teamId },
    });
    expect(result).toHaveProperty(
      'expiresAt',
      Number(h.staged.values.get('expiresAtMs')),
    );
    expect(h.requests).toHaveLength(1);
    expect(Object.fromEntries(form(h.requests[0]))).toEqual({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: 'refresh-private',
    });
    expect(Object.fromEntries(h.staged.values)).toMatchObject({
      token: 'access-rotated-private',
      refreshToken: 'refresh-rotated-private',
      oauthClientId: clientId,
    });
    expect(JSON.stringify(result)).not.toMatch(/private/u);
  });

  it('asks to reconnect when Vercel refuses the refresh grant (invalid_grant)', async () => {
    const h = await harness({ values: { teamId }, retained: signedIn });
    h.routes.set('/login/oauth/token', {
      status: 400,
      body: { error: 'invalid_grant', error_description: 'refresh-private' },
    });
    const result = await h.runtime.refresh(h.mutation);
    expect(result).toMatchObject({
      status: 'reconnectRequired',
      diagnostic: { code: 'vercel_oauth_reconnect_required' },
    });
    expect(h.staged.values.size).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/private/u);
  });

  it('reports a lost refresh reply as an unknown outcome, never a retry of the rotated grant', async () => {
    const h = await harness({ values: { teamId }, retained: signedIn });
    h.routes.set(
      '/login/oauth/token',
      Object.assign(new Error('refresh-private'), { code: 'ECONNRESET' }),
    );
    const result = await h.runtime.refresh(h.mutation);
    expect(result).toMatchObject({ status: 'outcomeUnknown' });
    expect(h.staged.values.size).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/private/u);
  });

  it('reports expiry from status so the refresh coordinator renews the grant', async () => {
    const live = await harness({ values: { teamId }, retained: signedIn });
    expect(await live.runtime.status(live.read)).toMatchObject({
      status: 'connected',
      expiresAt: Number(signedIn.expiresAtMs),
      providerIdentity: { accountId: 'user_subject', organizationId: teamId },
    });
    const expired = await harness({
      values: { teamId },
      retained: { ...signedIn, expiresAtMs: String(Date.now() - 1) },
    });
    expect(await expired.runtime.status(expired.read)).toEqual({
      status: 'expired',
    });
    expect(expired.requests).toHaveLength(0);
  });

  it('revokes the refresh token with client_id only and falls back to manual revoke on refusal', async () => {
    const h = await harness({ values: { teamId }, retained: signedIn });
    expect(await h.runtime.revoke(h.read)).toEqual({ status: 'remoteRevoked' });
    expect(h.requests[0]?.url).toBe(
      'https://api.vercel.com/login/oauth/token/revoke',
    );
    expect(Object.fromEntries(form(h.requests[0]))).toEqual({
      token: 'refresh-private',
      token_type_hint: 'refresh_token',
      client_id: clientId,
    });
    h.routes.set('/login/oauth/token/revoke', {
      status: 401,
      body: { error: 'invalid_client' },
    });
    expect(await h.runtime.revoke(h.read)).toMatchObject({
      status: 'remoteUnsupported',
      diagnostic: { code: 'vercel_oauth_manual_revoke_required' },
    });
  });
});
