import { describe, expect, it, vi } from 'vitest';

import type { PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/runtime';

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
    mcp: { registerDiscoveryProvider() {} },
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

describe('OpenAI Codex Connected Account', () => {
  it('registers exactly the authentication modes declared by the descriptor', () => {
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(
      ({ id }) => id === 'openai-codex',
    );
    expect(descriptor).toBeDefined();
    expect(descriptor?.authentication.modes).toEqual([
      expect.objectContaining({ id: 'oauth', outcomeReconciliation: 'none' }),
    ]);
    expect(Object.keys(activateConnectedAccountRuntime().authentication.modes).sort()).toEqual(
      descriptor?.authentication.modes.map(({ id }) => id).sort(),
    );
    expect(activateConnectedAccountRuntime().authentication.modes.oauth)
      .not.toHaveProperty('reconcile');
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
      services: { fetch: { request } },
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
      providerIdentity: { accountId },
      displayName: accountId,
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
      auth_mode: 'chatgpt',
      access_token: 'codex-access',
      refresh_token: 'codex-refresh',
      id_token: 'codex-id',
      account_id: 'chatgpt-account-1',
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
        fetch: {
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
          primary_window: { used_percent: 25, reset_at: 1_700_000_000 },
          secondary_window: { used_percent: 60, reset_at: 1_800_000_000 },
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
      services: { fetch: { request } },
      credentials: credentialStore(values).store,
    } as Parameters<NonNullable<PluginConnectedAccountRuntime['quota']>>[0]))
      .resolves.toMatchObject({
        observedAtMs: expect.any(Number),
        limits: [
          { id: 'session', used: 25, remaining: 75, resetsAtMs: 1_700_000_000_000 },
          { id: 'weekly', used: 60, remaining: 40, resetsAtMs: 1_800_000_000_000 },
        ],
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
        methods: ['GET'],
      },
    });
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
        fetch: {
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
      displayName: 'Codex',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
    });
    expect(attempted.values.get('providerAccountId')).toBe('');
  });
});
