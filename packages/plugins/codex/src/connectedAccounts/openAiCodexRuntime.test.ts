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
  const registration = registrations.find(({ id }) => id === 'openai-codex');
  if (!registration) throw new Error('OpenAI Codex Connected Account runtime was not registered');
  return registration.runtime;
}

function jwt(payload: Readonly<Record<string, unknown>>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

function materializationContext(
  credentials: ReturnType<typeof credentialStore>['store'],
): Parameters<PluginConnectedAccountRuntime['materialize']>[1] {
  const account = {
    service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
    accountId: 'chatgpt-account-1',
  };
  return {
    account,
    configuration: {
      target: { kind: 'account', account, modeId: 'oauth' },
      revision: 'configuration-1',
      values: {},
      async getSecret() { return null; },
    },
    signal: new AbortController().signal,
    services: {},
    credentials,
  } as Parameters<PluginConnectedAccountRuntime['materialize']>[1];
}

describe('OpenAI Codex Connected Account', () => {
  it.each([
    { status: 401, headers: {}, code: 'auth_failure', retryAfterMs: null, resetAtMs: null },
    { status: 403, headers: {}, code: 'auth_failure', retryAfterMs: null, resetAtMs: null },
    { status: 429, headers: { 'Retry-After': '45' }, code: 'provider_backoff', retryAfterMs: 45_000, resetAtMs: null },
    { status: 429, headers: { 'retry-after': 'Sun, 17 May 2026 12:00:45 GMT' }, code: 'provider_backoff', retryAfterMs: 45_000, resetAtMs: Date.parse('2026-05-17T12:00:45Z') },
  ])('preserves typed quota failure $status and its retry facts', async ({ status, headers, code, retryAfterMs, resetAtMs }) => {
    const runtime = activateConnectedAccountRuntime();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-05-17T12:00:00Z'));
    try {
      const context = materializationContext(credentialStore(new Map([['accessToken', 'codex-access']])).store);
      await expect(runtime.quota?.({
        ...context,
        services: { http: { async request() {
          return { status, finalUrl: 'https://chatgpt.com/backend-api/wham/usage', headers, body: new TextEncoder().encode('{}') };
        } } },
      } as Parameters<NonNullable<PluginConnectedAccountRuntime['quota']>>[0])).rejects.toMatchObject({
        name: 'ConnectedServiceQuotaFetchError', status, quotaFetchErrorCode: code, retryAfterMs, resetAtMs,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    [429, 'outcomeUnknown'], [503, 'outcomeUnknown'], [200, 'outcomeUnknown'], [401, 'reconnectRequired'],
  ] as const)('preserves stored credentials without staging when refresh returns %s (%s)', async (status, outcome) => {
    const runtime = activateConnectedAccountRuntime();
    const original = new Map([
      ['accessToken', 'current-access'],
      ['refreshToken', 'current-refresh'],
      ['idToken', jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } })],
      ['providerAccountId', 'account-1'],
    ]);
    const credentials = credentialStore(new Map(original));
    const staged = credentialStore();
    const context = {
      ...materializationContext(credentials.store),
      operation: { operationId: 'refresh-1', configurationRevision: 'configuration-1' },
      stagedCredentials: staged.store,
      services: { http: { async request() {
        return { status, finalUrl: 'https://auth.openai.com/oauth/token', headers: {}, body: new TextEncoder().encode('{}') };
      } } },
    } as Parameters<typeof runtime.refresh>[0];

    await expect(runtime.refresh(context)).resolves.toMatchObject({ status: outcome });
    expect(staged.values.size).toBe(0);
    expect(credentials.values).toEqual(original);
    await expect(runtime.status(context)).resolves.toMatchObject({ status: 'connected' });
  });

  it.each(['access_token', 'id_token'])('accepts a freshly returned %s while retaining refresh and identity metadata', async (tokenField) => {
    const runtime = activateConnectedAccountRuntime();
    const credentials = credentialStore(new Map([
      ['accessToken', 'old-access'], ['refreshToken', 'old-refresh'],
      ['idToken', 'old-id'], ['providerAccountId', 'account-1'],
    ]));
    const staged = credentialStore();
    await expect(runtime.refresh({
      ...materializationContext(credentials.store),
      operation: { operationId: 'refresh-1', configurationRevision: 'configuration-1' },
      stagedCredentials: staged.store,
      services: { http: { async request() {
        return { status: 200, finalUrl: 'https://auth.openai.com/oauth/token', headers: {}, body: new TextEncoder().encode(JSON.stringify({ [tokenField]: 'fresh-token' })) };
      } } },
    } as Parameters<typeof runtime.refresh>[0])).resolves.toMatchObject({ status: 'connected' });
    expect(staged.values.get('accessToken')).toBe('fresh-token');
    expect(staged.values.get('refreshToken')).toBe('old-refresh');
    expect(staged.values.get('providerAccountId')).toBe('account-1');
    expect(staged.values.get('idToken')).toBe(tokenField === 'id_token' ? 'fresh-token' : 'old-id');
  });

  it('registers exactly the authentication modes declared by the descriptor', () => {
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(
      ({ id }) => id === 'openai-codex',
    );
    expect(descriptor).toBeDefined();
    expect(descriptor?.authentication.modes).toEqual([
      expect.objectContaining({ id: 'oauth', outcomeReconciliation: 'none' }),
      expect.objectContaining({ id: 'device', outcomeReconciliation: 'none' }),
    ]);
    expect(Object.keys(activateConnectedAccountRuntime().authentication.modes).sort()).toEqual(
      descriptor?.authentication.modes.map(({ id }) => id).sort(),
    );
    expect(activateConnectedAccountRuntime().authentication.modes.oauth)
      .not.toHaveProperty('reconcile');
  });

  it('uses the canonical device-attempt lifecycle without polling inside begin', async () => {
    const runtime = activateConnectedAccountRuntime();
    const mode = runtime.authentication.modes.device;
    if (!mode || mode.kind !== 'oauthDeviceCode') {
      throw new Error('OpenAI Codex device mode is unavailable');
    }
    const attempted = credentialStore();
    const request = vi.fn(async (input: Readonly<{ url: string }>) => {
      if (input.url.endsWith('/api/accounts/deviceauth/usercode')) {
        return {
          status: 200,
          finalUrl: input.url,
          headers: {},
          body: new TextEncoder().encode(JSON.stringify({
            device_auth_id: 'device-auth-1',
            user_code: 'ABCD-EFGH',
            interval: '2',
            expires_in: 900,
          })),
        };
      }
      if (input.url.endsWith('/api/accounts/deviceauth/token')) {
        return {
          status: 403,
          finalUrl: input.url,
          headers: {},
          body: new Uint8Array(),
        };
      }
      throw new Error(`unexpected URL: ${input.url}`);
    });
    const context = {
      attempt: { kind: 'connect', attemptId: 'codex-device-attempt' },
      signal: new AbortController().signal,
      services: { http: { request } },
      attemptCredentials: attempted.store,
    } as Parameters<typeof mode.begin>[0];

    await expect(mode.begin(context)).resolves.toMatchObject({
      status: 'awaitingDeviceAuthorization',
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
      pollIntervalMs: 2_000,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(attempted.values.get('deviceAuthId')).toBe('device-auth-1');
    expect(attempted.values.get('deviceUserCode')).toBe('ABCD-EFGH');

    await expect(mode.poll(context)).resolves.toEqual({
      status: 'pending',
      retryAfterMs: 5_000,
    });
  });

  it('exchanges a PKCE authorization code, stages provider tokens, and exposes stable identity', async () => {
    const runtime = activateConnectedAccountRuntime();
    const mode = runtime.authentication.modes.oauth;
    if (!mode || mode.kind !== 'oauthAuthorizationCode') {
      throw new Error('OpenAI Codex OAuth mode is unavailable');
    }
    const attempted = credentialStore();
    const accountId = 'chatgpt-account-1';
    const idToken = jwt({
      name: 'Ada Example',
      email: 'ada@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    });
    const request = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://auth.openai.com/oauth/token',
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({
        access_token: 'codex-access',
        refresh_token: 'codex-refresh',
        id_token: idToken,
        expires_in: 3600,
      })),
    }));
    const signal = new AbortController().signal;
    const context = {
      attempt: { kind: 'connect', attemptId: 'codex-attempt' },
      signal,
      services: { http: { request } },
      attemptCredentials: attempted.store,
    } as Parameters<typeof mode.complete>[1];

    const begun = await mode.begin({
      callbackUrl: 'http://127.0.0.1:1455/callback',
      state: 'state-1',
      pkce: { challenge: 'challenge-1', method: 'S256' },
    }, context);
    expect(begun).toMatchObject({ status: 'awaitingOAuthRedirect' });
    if (begun.status !== 'awaitingOAuthRedirect') {
      throw new Error('OpenAI Codex OAuth did not begin');
    }
    const authorizationUrl = new URL(begun.authorizationUrl);
    expect(authorizationUrl.origin).toBe('https://auth.openai.com');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:1455/callback',
    );
    expect(authorizationUrl.searchParams.get('state')).toBe('state-1');
    expect(authorizationUrl.searchParams.get('code_challenge')).toBe('challenge-1');

    await expect(mode.complete({
      code: 'authorization-code',
      callbackUrl: 'http://127.0.0.1:1455/callback',
      state: 'state-1',
      pkceVerifier: 'verifier-1',
    }, context)).resolves.toMatchObject({
      status: 'connected',
      accountId,
      providerIdentity: { accountId, email: 'ada@example.com' },
      displayName: 'Ada Example',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://auth.openai.com/oauth/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: expect.any(Uint8Array),
      redirect: 'error',
    }), { signal });
    expect(attempted.values.get('accessToken')).toBe('codex-access');
    expect(attempted.values.get('refreshToken')).toBe('codex-refresh');
    expect(attempted.values.get('idToken')).toBe(idToken);
    expect(attempted.values.get('providerAccountId')).toBe(accountId);
  });

  it('uses existing token identity on status and tolerates missing or invalid stored identity claims', async () => {
    const runtime = activateConnectedAccountRuntime();
    for (const [idToken, displayName] of [
      [jwt({ name: 'Ada Example', email: 'ada@example.com' }), 'Ada Example'],
      [jwt({ email: 'ada@example.com' }), 'ada@example.com'],
      [jwt({ 'https://api.openai.com/profile': { email: 'nested@example.com' } }), 'nested@example.com'],
      ['malformed-stored-token', 'ChatGPT'],
      ['', 'ChatGPT'],
    ]) {
      const credentials = credentialStore(new Map([
        ['accessToken', 'current-access'], ['idToken', idToken!], ['providerAccountId', 'provider-uuid'],
      ]));
      await expect(runtime.status(materializationContext(credentials.store))).resolves.toMatchObject({ status: 'connected', displayName });
    }
  });
  it('keeps available human identity when stored access material has expired', async () => {
    const runtime = activateConnectedAccountRuntime();
    const credentials = credentialStore(new Map([
      ['accessToken', 'stored-access'], ['expiresAtMs', '1'],
      ['idToken', jwt({ name: 'Ada Example', email: 'ada@example.com' })],
      ['providerAccountId', 'provider-account-42'],
    ]));
    await expect(runtime.status(materializationContext(credentials.store))).resolves.toMatchObject({ status: 'expired', displayName: 'Ada Example' });
  });

  it('materializes only the requested current Codex access token environment key', async () => {
    const runtime = activateConnectedAccountRuntime();
    const currentCredentials = credentialStore(new Map([
      ['accessToken', 'codex-access'],
      ['refreshToken', 'codex-refresh-must-not-disclose'],
      ['idToken', 'codex-id-must-not-disclose'],
      ['providerAccountId', 'chatgpt-account-must-not-disclose'],
      ['expiresAtMs', String(Date.now() + 60_000)],
    ]));

    await expect(runtime.materialize(
      { kind: 'environment', keys: ['OPENAI_CODEX_OAUTH_TOKEN', 'UNRELATED_KEY'] },
      materializationContext(currentCredentials.store),
    )).resolves.toEqual({
      kind: 'environment',
      env: { OPENAI_CODEX_OAUTH_TOKEN: 'codex-access' },
    });
    await expect(runtime.materialize(
      { kind: 'environment', keys: ['UNRELATED_KEY'] },
      materializationContext(currentCredentials.store),
    )).resolves.toEqual({ kind: 'environment', env: {} });

    const unavailableCredentials = credentialStore(new Map([
      ['refreshToken', 'codex-refresh-must-not-disclose'],
      ['idToken', 'codex-id-must-not-disclose'],
      ['providerAccountId', 'chatgpt-account-must-not-disclose'],
    ]));
    const expiredCredentials = credentialStore(new Map([
      ['accessToken', 'expired-codex-access-must-not-disclose'],
      ['refreshToken', 'codex-refresh-must-not-disclose'],
      ['idToken', 'codex-id-must-not-disclose'],
      ['providerAccountId', 'chatgpt-account-must-not-disclose'],
      ['expiresAtMs', '1'],
    ]));
    for (const credentials of [unavailableCredentials, expiredCredentials]) {
      await expect(runtime.materialize(
        { kind: 'environment', keys: ['OPENAI_CODEX_OAUTH_TOKEN'] },
        materializationContext(credentials.store),
      )).rejects.toThrow('OpenAI Codex connected-account credentials are unavailable');
    }
  });

  it('materializes the exact native Codex credential file and reports uncertain exchanges safely', async () => {
    const runtime = activateConnectedAccountRuntime();
    const mode = runtime.authentication.modes.oauth;
    if (!mode || mode.kind !== 'oauthAuthorizationCode') {
      throw new Error('OpenAI Codex OAuth mode is unavailable');
    }
    const values = new Map([
      ['accessToken', 'codex-access'],
      ['refreshToken', 'codex-refresh'],
      ['idToken', 'codex-id'],
      ['providerAccountId', 'chatgpt-account-1'],
      ['lastRefreshAtMs', '1700000000000'],
    ]);
    const credentials = credentialStore(values);
    const get = credentials.store.get;
    credentials.store.get = async (key) => {
      if (key === 'refreshToken') throw new Error('Native consumers must not read refresh authority');
      return get(key);
    };
    const materialized = await runtime.materialize(
      { kind: 'files', fileIds: ['auth.json'] },
      {
        account: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          accountId: 'chatgpt-account-1',
        },
        configuration: {
          target: {
            kind: 'account',
            account: {
              service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
              accountId: 'chatgpt-account-1',
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
      files: { 'auth.json': expect.any(Uint8Array) },
    });
    if (materialized.kind !== 'files') throw new Error('Codex file materialization was unavailable');
    expect(JSON.parse(new TextDecoder().decode(materialized.files['auth.json']))).toMatchObject({
      auth_mode: 'chatgptAuthTokens',
      access_token: 'codex-access',
      refresh_token: '',
      id_token: 'codex-id',
      account_id: 'chatgpt-account-1',
      tokens: {
        access_token: 'codex-access',
        refresh_token: '',
        id_token: 'codex-id',
        account_id: 'chatgpt-account-1',
      },
    });
    await expect(runtime.materialize(
      {
        kind: 'httpHeaders',
        origin: 'https://api.openai.com',
        headerNames: ['authorization', 'chatgpt-account-id'],
      },
      {
        account: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          accountId: 'chatgpt-account-1',
        },
        configuration: {
          target: {
            kind: 'account',
            account: {
              service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
              accountId: 'chatgpt-account-1',
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
    )).resolves.toEqual({
      kind: 'httpHeaders',
      headers: {
        Authorization: 'Bearer codex-access',
        'ChatGPT-Account-Id': 'chatgpt-account-1',
      },
    });
    await expect(runtime.materialize(
      {
        kind: 'httpHeaders',
        origin: 'https://chatgpt.com',
        headerNames: ['authorization', 'chatgpt-account-id'],
      },
      {
        account: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          accountId: 'chatgpt-account-1',
        },
        configuration: {
          target: {
            kind: 'account',
            account: {
              service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
              accountId: 'chatgpt-account-1',
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
    )).resolves.toEqual({
      kind: 'httpHeaders',
      headers: {
        Authorization: 'Bearer codex-access',
        'ChatGPT-Account-Id': 'chatgpt-account-1',
      },
    });
    await expect(runtime.materialize(
      {
        kind: 'httpHeaders',
        origin: 'https://api.openai.com.evil.test',
        headerNames: ['authorization'],
      },
      {
        account: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          accountId: 'chatgpt-account-1',
        },
        configuration: {
          target: {
            kind: 'account',
            account: {
              service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
              accountId: 'chatgpt-account-1',
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
    )).rejects.toThrow(/origin/u);
    await expect(runtime.materialize(
      {
        kind: 'httpHeaders',
        origin: 'https://chatgpt.com.evil.test',
        headerNames: ['authorization'],
      },
      {
        account: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          accountId: 'chatgpt-account-1',
        },
        configuration: {
          target: {
            kind: 'account',
            account: {
              service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
              accountId: 'chatgpt-account-1',
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
    )).rejects.toThrow(/origin/u);
    values.delete('providerAccountId');
    await expect(runtime.materialize(
      {
        kind: 'httpHeaders',
        origin: 'https://chatgpt.com',
        headerNames: ['authorization', 'chatgpt-account-id'],
      },
      {
        account: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          accountId: 'host-minted-account-id',
        },
        configuration: {
          target: {
            kind: 'account',
            account: {
              service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
              accountId: 'host-minted-account-id',
            },
            modeId: 'oauth',
          },
          revision: 'configuration-2',
          values: {},
          async getSecret() { return null; },
        },
        signal: new AbortController().signal,
        services: {},
        credentials: credentials.store,
      } as Parameters<typeof runtime.materialize>[1],
    )).resolves.toEqual({
      kind: 'httpHeaders',
      headers: {
        Authorization: 'Bearer codex-access',
      },
    });
    values.set('expiresAtMs', '1');
    await expect(runtime.materialize(
      {
        kind: 'httpHeaders',
        origin: 'https://api.openai.com',
        headerNames: ['authorization', 'chatgpt-account-id'],
      },
      {
        account: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          accountId: 'chatgpt-account-1',
        },
        configuration: {
          target: {
            kind: 'account',
            account: {
              service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
              accountId: 'chatgpt-account-1',
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
    )).rejects.toThrow(/unavailable/u);
    values.delete('expiresAtMs');

    await expect(mode.complete({
      code: 'authorization-code',
      callbackUrl: 'http://127.0.0.1:1455/callback',
      state: 'state-1',
      pkceVerifier: 'verifier-1',
    }, {
      attempt: { kind: 'connect', attemptId: 'uncertain-attempt' },
      signal: new AbortController().signal,
      services: {
        http: {
          async request() {
            throw new Error('connection reset after request');
          },
        },
      },
      attemptCredentials: credentialStore().store,
    } as Parameters<typeof mode.complete>[1])).resolves.toMatchObject({
      status: 'outcomeUnknown',
      diagnostic: { code: 'openai_codex_oauth_outcome_unknown' },
    });
  });

  it('loads account quota through the activated runtime and its declared fixed provider origin', async () => {
    const runtime = activateConnectedAccountRuntime();
    const request = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://chatgpt.com/backend-api/wham/usage',
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({
        rate_limit: {
          primary_window: { used: 50, limit: 200, used_percent: 25, reset_at: 1_700_000_000, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: 60, reset_at: 1_800_000_000 },
        },
        additional_rate_limits: {
          codex_spark: {
            limit_name: 'Spark', model_id: 'gpt-5.3-codex-spark',
            rate_limit: { primary_window: { used_percent: 81, limit_window_seconds: 18_000 } },
          },
        },
      })),
    }));
    const values = new Map([
      ['accessToken', 'codex-access'],
      ['providerAccountId', 'chatgpt-account-1'],
    ]);
    const signal = new AbortController().signal;

    await expect(runtime.quota?.({
      account: {
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        accountId: 'chatgpt-account-1',
      },
      configuration: {
        target: {
          kind: 'account',
          account: {
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            accountId: 'chatgpt-account-1',
          },
          modeId: 'oauth',
        },
        revision: 'configuration-1',
        values: {},
        async getSecret() { return null; },
      },
      signal,
      services: { http: { request } },
      credentials: credentialStore(values).store,
    } as Parameters<NonNullable<PluginConnectedAccountRuntime['quota']>>[0]))
      .resolves.toMatchObject({
        observedAtMs: expect.any(Number),
        limits: expect.arrayContaining([
          { id: 'session', used: 50, limit: 200, remaining: 150, utilizationPct: 25, remainingPct: 75, resetsAtMs: 1_700_000_000_000,
            label: 'Session', windowDurationMs: 18_000_000, scope: 'session', limitScope: 'account', confidence: 'exact' },
          { id: 'weekly', used: 60, remaining: 40, resetsAtMs: 1_800_000_000_000 },
          { id: 'codex_spark:primary', providerLimitId: 'codex_spark', used: 81, remaining: 19,
            label: 'Spark · Primary', windowDurationMs: 18_000_000, modelId: 'gpt-5.3-codex-spark',
            scope: 'primary', limitScope: 'account', confidence: 'exact', status: 'ok', unit: 'unknown' },
        ].map((limit) => expect.objectContaining(limit))),
      });
    expect(request).toHaveBeenCalledWith({
      url: 'https://chatgpt.com/backend-api/wham/usage',
      method: 'GET',
      headers: {
        Authorization: 'Bearer codex-access',
        'ChatGPT-Account-Id': 'chatgpt-account-1',
        Accept: 'application/json',
      },
      redirect: 'error',
    }, { signal });

    const quotaAccess = PLUGIN_MANIFEST.hostAccess.required.find(
      ({ id }) => id === 'openai-codex-quota',
    );
    expect(quotaAccess).toMatchObject({
      capability: 'network',
      scope: {
        targets: expect.arrayContaining([
          { kind: 'fixedOrigin', origin: 'https://chatgpt.com' },
          { kind: 'connectedAccountOrigin', service: 'openai-codex' },
        ]),
        methods: ['GET', 'POST'],
      },
    });
  });

  it('reads recovery credits using exact-account credentials and maps unavailable statuses', async () => {
    const runtime = activateConnectedAccountRuntime();
    const request = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({
        available_count: 1,
        credits: [
          { id: 'credit-1', status: 'available', expires_at: 1_800_000_000 },
          { id: 'credit-2', status: 'redeemed' },
        ],
      })),
    }));
    const context = {
      ...materializationContext(credentialStore(new Map([
        ['accessToken', 'selected-token'], ['providerAccountId', 'selected-account'],
      ])).store),
      services: { http: { request } },
    } as Parameters<NonNullable<PluginConnectedAccountRuntime['recoveryCredits']>['read']>[0];
    expect(runtime.recoveryCredits).toBeDefined();
    await expect(runtime.recoveryCredits!.read(context)).resolves.toEqual({
      observedAtMs: expect.any(Number), availableCount: 1,
      credits: [
        { providerCreditId: 'credit-1', status: 'available', expiresAtMs: 1_800_000_000_000 },
        { providerCreditId: 'credit-2', status: 'unavailable' },
      ],
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      headers: { Authorization: 'Bearer selected-token', 'ChatGPT-Account-Id': 'selected-account', Accept: 'application/json' },
    }), { signal: context.signal });
  });

  it.each([
    ['reset', 'consumed'], ['already_redeemed', 'already_consumed'],
    ['no_credit', 'not_available'], ['nothing_to_reset', 'nothing_to_reset'],
  ])('consumes recovery credits and maps %s without retrying the provider mutation', async (code, status) => {
    const runtime = activateConnectedAccountRuntime();
    const request = vi.fn(async () => ({
      status: 200, finalUrl: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
      headers: {}, body: new TextEncoder().encode(JSON.stringify({ code })),
    }));
    const context = {
      ...materializationContext(credentialStore(new Map([
        ['accessToken', 'selected-token'], ['providerAccountId', 'selected-account'],
      ])).store),
      services: { http: { request } },
    } as Parameters<NonNullable<PluginConnectedAccountRuntime['recoveryCredits']>['consume']>[1];
    expect(runtime.recoveryCredits).toBeDefined();
    await expect(runtime.recoveryCredits!.consume({ idempotencyKey: 'redeem-1', providerCreditId: 'credit-1' }, context))
      .resolves.toEqual({ status });
    expect(request).toHaveBeenCalledExactlyOnceWith({
      method: 'POST', url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
      headers: { Authorization: 'Bearer selected-token', 'ChatGPT-Account-Id': 'selected-account', Accept: 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ redeem_request_id: 'redeem-1', credit_id: 'credit-1' })),
      redirect: 'error',
    }, { signal: context.signal });
  });

  it('allows the host to mint identity when OpenAI returns no stable account id', async () => {
    const runtime = activateConnectedAccountRuntime();
    const mode = runtime.authentication.modes.oauth;
    if (!mode || mode.kind !== 'oauthAuthorizationCode') {
      throw new Error('OpenAI Codex OAuth mode is unavailable');
    }
    const attempted = credentialStore();
    const idToken = jwt({ sub: 'provider-user-without-account-id' });
    const connected = await mode.complete({
      code: 'authorization-code',
      callbackUrl: 'http://127.0.0.1:1455/callback',
      state: 'state-1',
      pkceVerifier: 'verifier-1',
    }, {
      attempt: { kind: 'connect', attemptId: 'host-identity-attempt' },
      signal: new AbortController().signal,
      services: {
        http: {
          async request() {
            return {
              status: 200,
              finalUrl: 'https://auth.openai.com/oauth/token',
              headers: {},
              body: new TextEncoder().encode(JSON.stringify({
                access_token: 'codex-access',
                refresh_token: 'codex-refresh',
                id_token: idToken,
              })),
            };
          },
        },
      },
      attemptCredentials: attempted.store,
    } as Parameters<typeof mode.complete>[1]);

    expect(connected).toEqual({
      status: 'connected',
      displayName: 'ChatGPT',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
    });
    expect(attempted.values.get('providerAccountId')).toBe('');
  });
});
