import { afterEach, expect, it } from 'vitest';
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
import type { JsonValue } from '@happier-dev/plugin-sdk';
import * as entry from './index.js';

// Response shapes follow Supabase's live DCR reply (captured 2026-11-16, values
// replaced) and the Management API OpenAPI (OAuthTokenResponse,
// OrganizationResponseV1): https://api.supabase.com/api/v1-json
const callbackUrl =
  'https://happier-qa.example/oauth/connected-account/callback';
const service = { pluginId: entry.manifest.id, localId: 'supabase' };
const registration = {
  id: 'reg-1',
  client_id: 'client-1',
  client_secret: 'dcr-secret-1',
  client_secret_expires_at: 0,
  redirect_uris: [callbackUrl],
};
const tokens = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 86_400,
  token_type: 'Bearer',
  scope:
    'organizations:read projects:read projects:write environment:read environment:write database:read',
  project_refs: null,
};
const organizations = [{ id: 'acme-org', slug: 'acme-org', name: 'Acme' }];
const kits: PluginTestkit[] = [];
afterEach(async () => {
  await Promise.all(kits.splice(0).map((kit) => kit.dispose()));
});

type Reply = { status: number; headers: Record<string, string>; body: Uint8Array };
function json(status: number, body: unknown): Reply {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}
function store(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const credentials: ConnectedAccountCredentialStore = {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
  return { values, credentials };
}
function decode(request: HttpRequest) {
  return request.body ? new TextDecoder().decode(request.body) : '';
}

async function harness(
  input: {
    values?: Record<string, JsonValue>;
    secret?: string;
    routes?: Record<string, Reply>;
  } = {},
) {
  const kit = await createPluginTestkit({
    manifest: entry.manifest,
    module: entry,
  });
  kits.push(kit);
  const runtime = kit.registration('connectedAccountDescriptors', 'supabase');
  const mode = runtime?.authentication.modes.oauth;
  if (!runtime || mode?.kind !== 'oauthAuthorizationCode')
    throw new Error('Missing Supabase OAuth mode');
  const requests: HttpRequest[] = [];
  const routes: Record<string, Reply> = {
    'POST https://api.supabase.com/platform/oauth/apps/register': json(
      201,
      registration,
    ),
    'POST https://api.supabase.com/v1/oauth/token': json(200, tokens),
    'GET https://api.supabase.com/v1/organizations': json(200, organizations),
    ...input.routes,
  };
  // Only the Supabase HTTP boundary is replaced; the plugin's runtime is real.
  const http = createPluginHttpFixture({
    async request(request) {
      requests.push(request);
      const route = routes[`${request.method} ${request.url}`];
      if (!route)
        throw new Error(`Unexpected request ${request.method} ${request.url}`);
      return route;
    },
  });
  const services = new Proxy({} as ConnectedAccountReadContext['services'], {
    get(_target, key) {
      if (key === 'http') return http;
      throw new Error('Unexpected host service');
    },
  });
  const staged: {
    values: Record<string, JsonValue>;
    secretValues?: Record<string, string>;
  }[] = [];
  const attempt = store();
  const values = input.values ?? {};
  const configuration = {
    target: {
      kind: 'attempt' as const,
      attemptId: 'attempt',
      service,
      modeId: 'oauth',
    },
    revision: '1',
    values,
    async getSecret(fieldId: string) {
      return fieldId === 'oauthClientSecret' ? (input.secret ?? null) : null;
    },
  };
  const context: ConnectedAccountAuthenticationContext = {
    plugin: { id: entry.manifest.id, version: entry.manifest.version },
    contribution: {
      id: 'supabase',
      qualifiedId: `${entry.manifest.id}/supabase`,
    },
    surface: 'ui',
    invokedAtMs: 1,
    service,
    attempt: { kind: 'connect', attemptId: 'attempt' },
    configuration,
    services,
    signal: new AbortController().signal,
    attemptCredentials: attempt.credentials,
    async stageAccountConfiguration(replacement) {
      staged.push({
        values: { ...replacement.values },
        ...(replacement.secretValues
          ? { secretValues: { ...replacement.secretValues } }
          : {}),
      });
    },
  };
  const established = (credentialValues: Record<string, string>) => {
    const settled = store(credentialValues);
    const next = store();
    const read: ConnectedAccountReadContext = {
      ...context,
      account: { service, accountId: 'connected' },
      credentials: settled.credentials,
      configuration: {
        ...configuration,
        target: {
          kind: 'account',
          account: { service, accountId: 'connected' },
          modeId: 'oauth',
        },
      },
    };
    const mutation: ConnectedAccountMutationContext = {
      ...read,
      operation: { operationId: 'op', configurationRevision: '1' },
      stagedCredentials: next.credentials,
    };
    return { read, mutation, staged: next.values };
  };
  return {
    runtime,
    mode,
    context,
    requests,
    staged,
    attempt: attempt.values,
    established,
  };
}

const begin = {
  callbackUrl,
  state: 'state-1',
  pkce: { challenge: 'challenge-1', method: 'S256' as const },
};

it('registers this connection’s own client, signs in with PKCE and keeps tokens on the attempt', async () => {
  const { mode, context, requests, staged, attempt } = await harness();
  const started = await mode.begin(begin, context);
  expect(started).toMatchObject({
    status: 'awaitingOAuthRedirect',
    issuer: 'https://api.supabase.com',
    issuerResponseParameterRequired: true,
  });
  if (started.status !== 'awaitingOAuthRedirect')
    throw new Error('not started');
  const url = new URL(started.authorizationUrl);
  expect(url.origin + url.pathname).toBe(
    'https://api.supabase.com/v1/oauth/authorize',
  );
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    client_id: 'client-1',
    redirect_uri: callbackUrl,
    response_type: 'code',
    state: 'state-1',
    code_challenge: 'challenge-1',
    code_challenge_method: 'S256',
  });
  expect(url.searchParams.get('scope')?.split(' ')).toEqual(
    expect.arrayContaining([
      'organizations:read',
      'projects:write',
      'environment:write',
      'database:read',
    ]),
  );
  expect(JSON.parse(decode(requests[0]!))).toMatchObject({
    redirect_uris: [callbackUrl],
    token_endpoint_auth_method: 'client_secret_basic',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  expect(staged.at(-1)).toEqual({
    values: { oauthClientId: 'client-1', oauthRedirectUri: callbackUrl },
    secretValues: { oauthClientSecret: 'dcr-secret-1' },
  });

  const done = await mode.complete(
    {
      code: 'code-1',
      callbackUrl,
      state: 'state-1',
      pkceVerifier: 'verifier-1',
    },
    context,
  );
  expect(done).toMatchObject({
    status: 'connected',
    displayName: 'Acme',
    providerIdentity: { organizationId: 'acme-org' },
  });
  const exchange = requests.find((request) =>
    request.url.endsWith('/v1/oauth/token'),
  )!;
  expect(exchange.headers?.authorization).toBe(
    `Basic ${Buffer.from('client-1:dcr-secret-1').toString('base64')}`,
  );
  expect(Object.fromEntries(new URLSearchParams(decode(exchange)))).toEqual({
    grant_type: 'authorization_code',
    code: 'code-1',
    redirect_uri: callbackUrl,
    code_verifier: 'verifier-1',
  });
  expect(
    requests.find((request) => request.url.endsWith('/v1/organizations'))
      ?.headers?.authorization,
  ).toBe('Bearer access-1');
  expect(attempt.get('token')).toBe('access-1');
  expect(attempt.get('refreshToken')).toBe('refresh-1');
  expect(Number(attempt.get('expiresAtMs'))).toBeGreaterThan(Date.now());
  expect(staged.at(-1)).toEqual({
    values: {
      oauthClientId: 'client-1',
      oauthRedirectUri: callbackUrl,
      organizationSlug: 'acme-org',
    },
    secretValues: { oauthClientSecret: 'dcr-secret-1' },
  });
});

it('reuses the stored client on reconnect and registers again only for a different callback', async () => {
  const reused = await harness({
    values: {
      oauthClientId: 'client-0',
      oauthRedirectUri: callbackUrl,
      organizationSlug: 'acme-org',
    },
    secret: 'dcr-secret-0',
  });
  const started = await reused.mode.begin(begin, reused.context);
  if (started.status !== 'awaitingOAuthRedirect')
    throw new Error('not started');
  expect(reused.requests).toHaveLength(0);
  expect(new URL(started.authorizationUrl).searchParams.get('client_id')).toBe(
    'client-0',
  );
  expect(reused.staged.at(-1)?.secretValues).toEqual({
    oauthClientSecret: 'dcr-secret-0',
  });

  const moved = await harness({
    values: {
      oauthClientId: 'client-0',
      oauthRedirectUri: 'https://old.example/oauth/connected-account/callback',
    },
    secret: 'dcr-secret-0',
  });
  await moved.mode.begin(begin, moved.context);
  expect(moved.requests.map((request) => request.url)).toEqual([
    'https://api.supabase.com/platform/oauth/apps/register',
  ]);
});

it('asks which organization to use when the grant covers several', async () => {
  const two = [
    ...organizations,
    { id: 'beta-org', slug: 'beta-org', name: 'Beta' },
  ];
  const { mode, context, attempt } = await harness({
    routes: { 'GET https://api.supabase.com/v1/organizations': json(200, two) },
  });
  await mode.begin(begin, context);
  const done = await mode.complete(
    {
      code: 'code-1',
      callbackUrl,
      state: 'state-1',
      pkceVerifier: 'verifier-1',
    },
    context,
  );
  expect(done).toMatchObject({
    status: 'configurationRequired',
    fields: [
      { id: 'organizationSlug', schema: { enum: ['acme-org', 'beta-org'] } },
    ],
  });
  expect(attempt.get('token')).toBe('access-1');
  const chosen = {
    ...context,
    configuration: {
      ...context.configuration,
      values: { ...context.configuration.values, organizationSlug: 'beta-org' },
    },
  };
  expect(await mode.reconcile?.(chosen)).toMatchObject({
    status: 'connected',
    displayName: 'Beta',
    providerIdentity: { organizationId: 'beta-org' },
  });
});

it('refreshes with the stored client, reports expiry, and revokes the grant', async () => {
  const rotated = {
    ...tokens,
    access_token: 'access-2',
    refresh_token: 'refresh-2',
  };
  const { runtime, established, requests } = await harness({
    values: {
      oauthClientId: 'client-0',
      oauthRedirectUri: callbackUrl,
      organizationSlug: 'acme-org',
    },
    secret: 'dcr-secret-0',
    routes: {
      'POST https://api.supabase.com/v1/oauth/token': json(200, rotated),
      'POST https://api.supabase.com/v1/oauth/revoke': {
        status: 204,
        headers: {},
        body: new Uint8Array(),
      },
    },
  });
  const expired = established({
    token: 'access-1',
    refreshToken: 'refresh-1',
    expiresAtMs: String(Date.now() - 1),
  });
  expect(await runtime.status!(expired.read)).toMatchObject({
    status: 'expired',
  });

  const refreshed = await runtime.refresh(expired.mutation);
  expect(refreshed).toMatchObject({ status: 'connected', scopes: expect.arrayContaining(['projects:write']) });
  expect(refreshed).toHaveProperty('expiresAt');
  const refresh = requests.find((request) =>
    request.url.endsWith('/v1/oauth/token'),
  )!;
  expect(refresh.headers?.authorization).toBe(
    `Basic ${Buffer.from('client-0:dcr-secret-0').toString('base64')}`,
  );
  expect(Object.fromEntries(new URLSearchParams(decode(refresh)))).toEqual({
    grant_type: 'refresh_token',
    refresh_token: 'refresh-1',
  });
  expect(expired.staged.get('token')).toBe('access-2');
  expect(expired.staged.get('refreshToken')).toBe('refresh-2');

  const live = established({
    token: 'access-2',
    refreshToken: 'refresh-2',
    expiresAtMs: String(Date.now() + 60_000),
  });
  const status = await runtime.status!(live.read);
  expect(status).toMatchObject({ status: 'connected' });
  expect(status).toHaveProperty('expiresAt');

  expect(await runtime.revoke(live.read)).toEqual({ status: 'remoteRevoked' });
  expect(JSON.parse(decode(requests.at(-1)!))).toEqual({
    client_id: 'client-0',
    client_secret: 'dcr-secret-0',
    refresh_token: 'refresh-2',
  });
});

it('settles a refused refresh grant as reconnect required', async () => {
  const { runtime, established } = await harness({
    values: {
      oauthClientId: 'client-0',
      oauthRedirectUri: callbackUrl,
      organizationSlug: 'acme-org',
    },
    secret: 'dcr-secret-0',
    routes: {
      'POST https://api.supabase.com/v1/oauth/token': json(401, {
        message: 'Invalid refresh token',
      }),
    },
  });
  const expired = established({
    token: 'access-1',
    refreshToken: 'refresh-1',
    expiresAtMs: String(Date.now() - 1),
  });
  expect(await runtime.refresh(expired.mutation)).toMatchObject({
    status: 'reconnectRequired',
  });
  expect(expired.staged.size).toBe(0);
});
