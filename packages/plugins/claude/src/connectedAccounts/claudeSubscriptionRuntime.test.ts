import { describe, expect, it, vi } from 'vitest';

import type { ConnectedAccountRuntime as PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

function credentialStore(values = new Map<string, string>()) {
  return {
    values,
    store: {
      async get(key: string) { return values.get(key) ?? null; },
      async set(key: string, value: string) { values.set(key, value); },
      async delete(key: string) { values.delete(key); },
    },
  };
}

function activateConnectedAccountRuntime(): PluginConnectedAccountRuntime {
  const registrations: Array<Readonly<{ id: string; runtime: PluginConnectedAccountRuntime }>> = [];
  activate({
    agents: {
      register() {},
      registerExternalSessions() {},
      registerExternalSessionTakeover() {},
      registerExternalSessionHooks() {},
      registerExternalSessionObservation() {},
    },
    hooks: { register() {} },
    mcp: { registerDiscoverySource() {} },
    connectedAccounts: {
      register(id: string, runtime: PluginConnectedAccountRuntime) {
        registrations.push({ id, runtime });
      },
    },
  } as Parameters<typeof activate>[0]);
  const registration = registrations.find(({ id }) => id === 'claude-subscription');
  if (!registration) throw new Error('Claude Subscription Connected Account runtime was not registered');
  return registration.runtime;
}

function readContext(
  modeId: 'setup-token' | 'oauth',
  values: Map<string, string>,
): Parameters<PluginConnectedAccountRuntime['materialize']>[1] {
  const credentials = credentialStore(values);
  return {
    account: {
      service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
      accountId: 'claude-account-1',
    },
    configuration: {
      target: {
        kind: 'account',
        account: {
          service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
          accountId: 'claude-account-1',
        },
        modeId,
      },
      revision: 'configuration-1',
      values: {},
      async getSecret() { return null; },
    },
    signal: new AbortController().signal,
    services: {},
    credentials: credentials.store,
  } as Parameters<PluginConnectedAccountRuntime['materialize']>[1];
}

describe('Claude Subscription Connected Account', () => {
  it('registers exactly the two authentication modes declared by the descriptor', () => {
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(
      ({ id }) => id === 'claude-subscription',
    );
    expect(descriptor).toBeDefined();
    expect(descriptor?.authentication.modes).toEqual([
      expect.objectContaining({ id: 'setup-token', outcomeReconciliation: 'none' }),
      expect.objectContaining({
        id: 'oauth',
        callbackUrl: 'https://platform.claude.com/oauth/code/callback',
        outcomeReconciliation: 'none',
      }),
    ]);
    expect(Object.keys(activateConnectedAccountRuntime().authentication.modes).sort()).toEqual(
      descriptor?.authentication.modes.map(({ id }) => id).sort(),
    );
    expect(activateConnectedAccountRuntime().authentication.modes.oauth)
      .not.toHaveProperty('reconcile');
  });

  it('stages a setup token without fabricating first-connect provider identity', async () => {
    const runtime = activateConnectedAccountRuntime();
    const mode = runtime.authentication.modes['setup-token'];
    if (!mode || mode.kind !== 'manual') {
      throw new Error('Claude setup-token mode is unavailable');
    }
    const attempted = credentialStore();
    const connected = await mode.complete({ fields: { token: ' sk-ant-oat01-token ' } }, {
      attempt: { kind: 'connect', attemptId: 'claude-setup-token' },
      signal: new AbortController().signal,
      services: {},
      attemptCredentials: attempted.store,
    } as Parameters<typeof mode.complete>[1]);
    expect(connected).toMatchObject({
      status: 'connected',
      displayName: 'Claude setup token',
      scopes: ['user:inference'],
    });
    expect(connected).not.toHaveProperty('accountId');
    expect(attempted.values).toEqual(new Map([['setupToken', 'sk-ant-oat01-token']]));
  });

  it('exchanges Claude PKCE OAuth and stages the nested immutable account identity', async () => {
    const runtime = activateConnectedAccountRuntime();
    const mode = runtime.authentication.modes.oauth;
    if (!mode || mode.kind !== 'oauthAuthorizationCode') {
      throw new Error('Claude Subscription OAuth mode is unavailable');
    }
    const attempted = credentialStore();
    const request = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://platform.claude.com/v1/oauth/token',
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({
        access_token: 'claude-access',
        refresh_token: 'claude-refresh',
        expires_in: 3600,
        scope: 'user:inference user:profile user:sessions:claude_code',
        account: {
          uuid: 'claude-account-1',
          email_address: 'claude@example.com',
        },
      })),
    }));
    const signal = new AbortController().signal;
    const context = {
      attempt: { kind: 'connect', attemptId: 'claude-oauth-attempt' },
      signal,
      services: { http: { request } },
      attemptCredentials: attempted.store,
    } as Parameters<typeof mode.complete>[1];

    const begun = await mode.begin({
      callbackUrl: 'https://platform.claude.com/oauth/code/callback',
      state: 'state-1',
      pkce: { challenge: 'challenge-1', method: 'S256' },
    }, context);
    expect(begun).toMatchObject({ status: 'awaitingOAuthRedirect' });
    if (begun.status !== 'awaitingOAuthRedirect') {
      throw new Error('Claude Subscription OAuth did not begin');
    }
    const authorizationUrl = new URL(begun.authorizationUrl);
    expect(authorizationUrl.origin).toBe('https://claude.com');
    expect(authorizationUrl.pathname).toBe('/cai/oauth/authorize');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(
      'https://platform.claude.com/oauth/code/callback',
    );
    expect(authorizationUrl.searchParams.get('scope')?.split(' ')).toContain(
      'org:create_api_key',
    );
    expect(authorizationUrl.searchParams.get('state')).toBe('state-1');
    expect(authorizationUrl.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(authorizationUrl.searchParams.get('code')).toBe('true');

    await expect(mode.complete({
      code: 'authorization-code',
      callbackUrl: 'https://platform.claude.com/oauth/code/callback',
      state: 'state-1',
      pkceVerifier: 'verifier-1',
    }, context)).resolves.toMatchObject({
      status: 'connected',
      accountId: 'claude-account-1',
      providerIdentity: {
        accountId: 'claude-account-1',
        email: 'claude@example.com',
      },
      displayName: 'claude@example.com',
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://platform.claude.com/v1/oauth/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(Uint8Array),
      redirect: 'error',
    }), { signal });
    expect(attempted.values.get('accessToken')).toBe('claude-access');
    expect(attempted.values.get('refreshToken')).toBe('claude-refresh');
    expect(attempted.values.get('providerAccountId')).toBe('claude-account-1');
    expect(attempted.values.get('providerEmail')).toBe('claude@example.com');
  });

  it('materializes OAuth as an access-only native credential snapshot', async () => {
    const runtime = activateConnectedAccountRuntime();
    const credentials = credentialStore(new Map([
      ['accessToken', 'claude-access'],
      ['refreshToken', 'host-owned-refresh'],
      ['providerAccountId', 'claude-account-1'],
      ['providerEmail', 'claude@example.com'],
      ['expiresAtMs', '1700003600000'],
      ['scopes', JSON.stringify(['user:inference', 'user:sessions:claude_code'])],
    ]));
    const materialized = await runtime.materialize(
      { kind: 'files', fileIds: ['.credentials.json'] },
      {
        account: {
          service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
          accountId: 'claude-account-1',
        },
        configuration: {
          target: {
            kind: 'account',
            account: {
              service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
              accountId: 'claude-account-1',
            },
            modeId: 'oauth',
          },
          revision: 'configuration-1',
          values: {},
          async getSecret() { return null; },
        },
        signal: new AbortController().signal,
        services: {},
        credentials: credentials.store,
      } as Parameters<typeof runtime.materialize>[1],
    );
    expect(materialized).toMatchObject({
      kind: 'files',
      files: { '.credentials.json': expect.any(Uint8Array) },
    });
    if (materialized.kind !== 'files') {
      throw new Error('Claude Subscription file materialization was unavailable');
    }
    const credentialFile = JSON.parse(
      new TextDecoder().decode(materialized.files['.credentials.json']),
    );
    expect(credentialFile).toEqual({
      claudeAiOauth: {
        accessToken: 'claude-access',
        expiresAt: 1700003600000,
        scopes: ['user:inference', 'user:sessions:claude_code'],
      },
    });
    expect(credentialFile.claudeAiOauth).not.toHaveProperty('refreshToken');

    await expect(runtime.materialize(
      {
        kind: 'httpHeaders',
        origin: 'https://api.anthropic.com',
        headerNames: ['authorization'],
      },
      readContext('oauth', new Map([
        ['accessToken', 'claude-access'],
        ['refreshToken', 'host-owned-refresh'],
      ])),
    )).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { authorization: 'Bearer claude-access' },
    });
    await expect(runtime.materialize(
      {
        kind: 'httpHeaders',
        origin: 'https://api.anthropic.com.evil.test',
        headerNames: ['authorization'],
      },
      readContext('oauth', new Map([['accessToken', 'claude-access']])),
    )).rejects.toThrow(/HTTP-header request/u);
    await expect(runtime.materialize(
      {
        kind: 'httpHeaders',
        origin: 'https://api.anthropic.com',
        headerNames: ['authorization'],
      },
      readContext('setup-token', new Map([['setupToken', 'setup-token']])),
    )).rejects.toThrow(/do not support HTTP-header/u);
  });

  it('materializes setup tokens as inference-only native credentials without a token environment', async () => {
    const runtime = activateConnectedAccountRuntime();
    const files = await runtime.materialize(
      { kind: 'files', fileIds: ['.credentials.json'] },
      readContext('setup-token', new Map([['setupToken', 'setup-token']])),
    );
    expect(files).toMatchObject({ kind: 'files', files: { '.credentials.json': expect.any(Uint8Array) } });
    if (files.kind !== 'files') throw new Error('Expected setup-token file materialization');
    expect(JSON.parse(new TextDecoder().decode(files.files['.credentials.json']))).toEqual({
      claudeAiOauth: {
        accessToken: 'setup-token',
        scopes: ['user:inference'],
      },
    });
    await expect(runtime.materialize(
      { kind: 'environment', keys: ['CLAUDE_CODE_OAUTH_TOKEN'] },
      readContext('setup-token', new Map([['setupToken', 'setup-token']])),
    )).resolves.toEqual({ kind: 'environment', env: {} });
    await expect(runtime.materialize(
      { kind: 'environment', keys: ['CLAUDE_CODE_OAUTH_TOKEN'] },
      readContext('oauth', new Map([
        ['accessToken', 'oauth-access'],
        ['refreshToken', 'oauth-refresh'],
      ])),
    )).resolves.toEqual({ kind: 'environment', env: {} });
  });

  it('loads OAuth account quota through the activated runtime and its declared fixed provider origin', async () => {
    const runtime = activateConnectedAccountRuntime();
    const request = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://api.anthropic.com/api/oauth/usage',
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({
        five_hour: {
          utilization: 10,
          resets_at: '2026-02-16T00:00:00Z',
        },
        seven_day: {
          utilization: 25,
          resets_at: '2026-02-23T00:00:00Z',
        },
        extra_usage: {
          is_enabled: true,
          monthly_limit: 100,
          used_credits: 20,
          utilization: 20,
        },
      })),
    }));
    const signal = new AbortController().signal;
    const context = readContext('oauth', new Map([
      ['accessToken', 'claude-access'],
      ['scopes', JSON.stringify(['user:inference', 'user:sessions:claude_code'])],
    ]));

    await expect(runtime.quota?.({
      ...context,
      signal,
      services: { http: { request } },
    })).resolves.toMatchObject({
      observedAtMs: expect.any(Number),
      limits: expect.arrayContaining([
        {
          id: 'five_hour',
          used: 10,
          remaining: 90,
          resetsAtMs: Date.parse('2026-02-16T00:00:00Z'),
        },
        {
          id: 'seven_day',
          used: 25,
          remaining: 75,
          resetsAtMs: Date.parse('2026-02-23T00:00:00Z'),
        },
        {
          id: 'extra_usage',
          used: 20,
          remaining: 80,
        },
      ]),
    });
    expect(request).toHaveBeenCalledWith({
      url: 'https://api.anthropic.com/api/oauth/usage',
      method: 'GET',
      headers: {
        Authorization: 'Bearer claude-access',
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      redirect: 'error',
    }, { signal });

    const quotaAccess = PLUGIN_MANIFEST.hostAccess.required.find(
      ({ id }) => id === 'claude-subscription-quota',
    );
    expect(quotaAccess).toMatchObject({
      capability: 'network',
      scope: {
        targets: expect.arrayContaining([
          { kind: 'fixedOrigin', origin: 'https://api.anthropic.com' },
          { kind: 'connectedAccountOrigin', service: 'claude-subscription' },
        ]),
        methods: ['GET'],
      },
    });
  });

  it('does not claim exact quota support for setup-token credentials', async () => {
    const runtime = activateConnectedAccountRuntime();
    const request = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://api.anthropic.com/api/oauth/usage',
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({
        five_hour: { utilization: 40 },
      })),
    }));
    const signal = new AbortController().signal;
    const context = readContext(
      'setup-token',
      new Map([['setupToken', 'sk-ant-oat01-setup-token']]),
    );

    await expect(runtime.quota?.({
      ...context,
      signal,
      services: { http: { request } },
    })).resolves.toEqual({ observedAtMs: expect.any(Number), limits: [] });
    expect(request).not.toHaveBeenCalled();
  });
});
