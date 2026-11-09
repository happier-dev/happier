import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    actions: { register() {} },
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
  modeId: 'setup-token' | 'oauth' | 'native-import',
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
    services: { exec: { agentCli: { async checkReadiness() { return { launchable: [{ agentId: 'claude', version: '2.1.296' }] }; } } } },
    credentials: credentials.store,
  } as Parameters<PluginConnectedAccountRuntime['materialize']>[1];
}

describe('Claude Subscription Connected Account', () => {
  it.each([
    ['pro', 'personal'], ['max', 'personal'], ['team', 'workspace'],
    ['enterprise', 'workspace'], [undefined, 'unknown'], ['future-plan', 'unknown'],
  ])('classifies the materialized subscription, not the Agent (%s)', async (plan, expectedScope) => {
    const runtime = activateConnectedAccountRuntime();
    const values = new Map([['accessToken', 'synthetic-access']]);
    if (plan) values.set('subscriptionType', plan);
    const context = readContext('oauth', values);
    const request = { kind: 'httpHeaders' as const, origin: 'https://api.anthropic.com', headerNames: ['authorization'] };
    expect(await runtime.materialize(request, context, { signal: context.signal }))
      .toMatchObject({ kind: 'httpHeaders', usageAccountScope: expectedScope });
  });

  it('updates account context while retaining workspace approvals and private native preferences', async () => {
    const context = readContext('oauth', new Map([
      ['accessToken', 'replacement-access'], ['providerAccountId', 'replacement-account'],
      ['providerEmail', 'replacement@example.test'], ['organizationUuid', 'replacement-org'],
    ]));
    const retainedConfig = {
      projects: { '/workspace': { hasTrustDialogAccepted: true, allowedTools: ['Read'] } },
      approvalMarker: 'retain-native-approval', privatePreference: { theme: 'dark' },
      oauthAccount: { accountUuid: 'previous-account', emailAddress: 'previous@example.test', organizationUuid: 'previous-org' },
      modelAccessCache: { stale: true }, additionalModelOptionsCache: { stale: true }, cachedExtraUsageDisabledReason: 'stale',
    };
    const result = await activateConnectedAccountRuntime().materialize(
      { kind: 'files', fileIds: ['.credentials.json', '.claude.json'] }, context,
      { existingFiles: { '.claude.json': new TextEncoder().encode(JSON.stringify(retainedConfig)) } },
    );
    if (result.kind !== 'files') throw new Error('Expected native credential materialization');
    expect(JSON.parse(new TextDecoder().decode(result.files['.claude.json']))).toEqual({
      projects: retainedConfig.projects, approvalMarker: retainedConfig.approvalMarker,
      privatePreference: retainedConfig.privatePreference, hasCompletedOnboarding: true,
      oauthAccount: { accountUuid: 'replacement-account', emailAddress: 'replacement@example.test', organizationUuid: 'replacement-org' },
    });
  });

  it('refuses malformed retained config instead of returning files that discard private state', async () => {
    await expect(activateConnectedAccountRuntime().materialize(
      { kind: 'files', fileIds: ['.credentials.json', '.claude.json'] },
      readContext('oauth', new Map([['accessToken', 'replacement-access']])),
      { existingFiles: { '.claude.json': new TextEncoder().encode('{malformed') } },
    )).rejects.toMatchObject({ code: 'claude_subscription_native_config_invalid' });
  });

  it.each(['oauth', 'native-import'] as const)('materializes %s files within one round of independent credential reads', async mode => {
    const values = new Map([
      ['accessToken', 'claude-access'], ['expiresAtMs', '2000000000000'],
      ['scopes', JSON.stringify(['user:inference'])], ['subscriptionType', 'pro'], ['rateLimitTier', 'default'],
    ]);
    const context = readContext(mode, values);
    vi.useFakeTimers();
    const materialization = activateConnectedAccountRuntime().materialize({ kind: 'files', fileIds: ['.credentials.json'] }, {
      ...context,
      // The remote credential boundary has equal independent round-trip latency.
      credentials: { async get(key, options) {
        await new Promise(resolve => setTimeout(resolve, 50));
        options?.signal?.throwIfAborted();
        return values.get(key) ?? null;
      } },
    }, { signal: context.signal });
    try {
      await vi.advanceTimersByTimeAsync(50);
      const ready = await Promise.race([materialization, Promise.resolve(null)]);
      expect(ready).toEqual({ kind: 'files', usageAccountScope: 'personal', files: { '.credentials.json': expect.any(Uint8Array) } });
      if (ready?.kind !== 'files') throw new Error('Expected credential files');
      expect(JSON.parse(new TextDecoder().decode(ready.files['.credentials.json']))).toEqual({ claudeAiOauth: {
        accessToken: 'claude-access', expiresAt: 2000000000000, scopes: ['user:inference'], subscriptionType: 'pro', rateLimitTier: 'default',
      } });
    } finally {
      await vi.runAllTimersAsync();
      await materialization;
      vi.useRealTimers();
    }
  });

  it('refuses missing or cancelled OAuth credentials without returning a native file', async () => {
    const runtime = activateConnectedAccountRuntime();
    const request = { kind: 'files' as const, fileIds: ['.credentials.json'] };
    const context = readContext('oauth', new Map());
    await expect(runtime.materialize(request, context, { signal: context.signal }))
      .rejects.toThrow('Claude OAuth credentials are unavailable');
    const controller = new AbortController();
    const reason = new Error('Credential admission retired');
    const cancelled = runtime.materialize(request, { ...context, signal: controller.signal,
      credentials: { async get(_key, options) {
        await Promise.resolve();
        options?.signal?.throwIfAborted();
        return 'never-published';
      } },
    }, { signal: controller.signal });
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
  });

  it.each([
    { status: 401, headers: {}, code: 'auth_failure', retryAfterMs: null, resetAtMs: null },
    { status: 403, headers: {}, code: 'auth_failure', retryAfterMs: null, resetAtMs: null },
    { status: 429, headers: { 'Retry-After': '45' }, code: 'provider_backoff', retryAfterMs: 45_000, resetAtMs: null },
    { status: 429, headers: { 'retry-after': 'Sun, 17 May 2026 12:00:45 GMT' }, code: 'provider_backoff', retryAfterMs: 45_000, resetAtMs: Date.parse('2026-05-17T12:00:45Z') },
    { status: 429, headers: { 'anthropic-ratelimit-tokens-reset': '2026-05-17T12:00:45Z' }, code: 'provider_backoff', retryAfterMs: 45_000, resetAtMs: Date.parse('2026-05-17T12:00:45Z') },
  ])('preserves typed quota failure $status and its retry facts', async ({ status, headers, code, retryAfterMs, resetAtMs }) => {
    const runtime = activateConnectedAccountRuntime();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-05-17T12:00:00Z'));
    try {
      await expect(runtime.quota?.({
        ...readContext('oauth', new Map([['accessToken', 'claude-access']])),
        services: { exec: { agentCli: { async checkReadiness() { return { launchable: [{ agentId: 'claude', version: '2.1.296' }] }; } } }, http: { async request() {
          return { status, finalUrl: 'https://api.anthropic.com/api/oauth/usage', headers, body: new TextEncoder().encode('{}') };
        } } },
      } as Parameters<NonNullable<PluginConnectedAccountRuntime['quota']>>[0])).rejects.toMatchObject({
        name: 'ConnectedServiceQuotaFetchError', status, quotaFetchErrorCode: code, retryAfterMs, resetAtMs,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    { scenario: 'initial 503', statuses: [503], status: 503 },
    { scenario: 'retried 503', statuses: [500, 503], status: 503 },
    { scenario: 'retried 429', statuses: [503, 429], status: 429 },
  ])('preserves the provider delay for $scenario without another immediate read', async ({ statuses, status }) => {
    const runtime = activateConnectedAccountRuntime();
    let requests = 0;
    const request = vi.fn(async () => {
      const index = requests++;
      const responseStatus = statuses[index] ?? 200;
      return {
        status: responseStatus,
        finalUrl: 'https://api.anthropic.com/api/oauth/usage',
        headers: index === statuses.length - 1 ? { 'Retry-After': '30' } : {},
        body: new TextEncoder().encode('{}'),
      };
    });
    await expect(runtime.quota?.({
      ...readContext('oauth', new Map([['accessToken', 'claude-access']])),
      services: {
        exec: { agentCli: { async checkReadiness() { return { launchable: [{ agentId: 'claude', version: '2.1.296' }] }; } } },
        http: { request },
      },
    } as Parameters<NonNullable<PluginConnectedAccountRuntime['quota']>>[0])).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaFetchError', status, quotaFetchErrorCode: 'provider_backoff', retryAfterMs: 30_000,
    });
    expect(request).toHaveBeenCalledTimes(statuses.length);
  });

  it.each(['oauth', 'native-import'] as const)('replaces attested context through a successful %s credential refresh', async (authenticationModeId) => {
    const runtime = activateConnectedAccountRuntime();
    const staged = credentialStore();
    const context = readContext(authenticationModeId, new Map([
      ['accessToken', 'current-access'], ['refreshToken', 'current-refresh'],
      ['subscriptionType', 'max'], ['rateLimitTier', 'max_20x'],
      ['providerAccountId', 'provider-user'], ['organizationUuid', 'old-organization'],
    ]));
    await expect(runtime.refresh({
      ...context,
      operation: { operationId: 'refresh-plan', configurationRevision: 'configuration-1' },
      stagedCredentials: staged.store,
      services: { exec: { agentCli: { async checkReadiness() { return { launchable: [{ agentId: 'claude', version: '2.1.296' }] }; } } }, http: { async request(request) {
        return { status: 200, finalUrl: request.url, headers: {},
          body: new TextEncoder().encode(JSON.stringify(request.method === 'GET'
            ? { account: { uuid: 'provider-user', has_claude_max: true }, organization: { uuid: 'new-organization', rate_limit_tier: 'max_5x' } }
            : { access_token: 'new-access', refresh_token: 'new-refresh' })) };
      } } },
    })).resolves.toMatchObject({ status: 'connected', credentialKind: 'oauth', providerIdentity: {
      accountId: 'provider-user', organizationId: 'new-organization',
    } });
    expect(staged.values.get('subscriptionType')).toBe('max');
    expect(staged.values.get('rateLimitTier')).toBe('max_5x');
    expect(staged.values.get('organizationUuid')).toBe('new-organization');
    expect(staged.values.get('providerAccountId')).toBe('provider-user');
  });
  it('clears prior organization in staged and public metadata when a rotated grant has no context attestation', async () => {
    const runtime = activateConnectedAccountRuntime();
    const staged = credentialStore();
    const context = readContext('oauth', new Map([
      ['accessToken', 'old-access'], ['refreshToken', 'old-refresh'],
      ['providerAccountId', 'provider-user-a'], ['organizationUuid', 'organization-a'],
    ]));
    const result = await runtime.refresh({ ...context,
      operation: { operationId: 'unavailable-profile', configurationRevision: 'configuration-1' },
      stagedCredentials: staged.store,
      services: { ...context.services, http: { async request(request) {
        return { status: request.method === 'GET' ? 503 : 200, finalUrl: request.url, headers: {},
          body: new TextEncoder().encode(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' })) };
      } } },
    });
    expect(result).toMatchObject({ status: 'connected', providerIdentity: { accountId: 'provider-user-a' } });
    expect(result).toHaveProperty('providerIdentity.organizationId', null);
    expect(staged.values.has('organizationUuid')).toBe(false);
    expect(staged.values.get('accessToken')).toBe('new-access');
  });

  it('does not replace an established user with a different user attested by a refresh response', async () => {
    const runtime = activateConnectedAccountRuntime();
    const staged = credentialStore();
    const context = readContext('oauth', new Map([
      ['accessToken', 'old-access'], ['refreshToken', 'old-refresh'],
      ['providerAccountId', 'provider-user-a'], ['organizationUuid', 'organization-a'],
    ]));
    await expect(runtime.refresh({ ...context,
      operation: { operationId: 'immutable-user', configurationRevision: 'configuration-1' },
      stagedCredentials: staged.store,
      services: { ...context.services, http: { async request(request) {
        return { status: 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify({
          access_token: 'different-user-access', refresh_token: 'different-user-refresh',
          account: { uuid: 'provider-user-b' }, organization: { uuid: 'organization-b' },
        })) };
      } } },
    })).resolves.toMatchObject({ status: 'reconnectRequired',
      diagnostic: { code: 'claude_subscription_oauth_identity_mismatch' } });
    expect(staged.values.size).toBe(0);
    expect(await context.credentials.get('providerAccountId')).toBe('provider-user-a');
  });

  it.each(['missing', 'known', 'unavailable', 'mismatch'] as const)(
    'attests legacy unexpired context without rotating tokens (%s)', async scenario => {
      const runtime = activateConnectedAccountRuntime();
      const staged = credentialStore();
      const original = new Map([
        ['accessToken', 'current-access'], ['refreshToken', 'current-refresh'],
        ['providerAccountId', 'provider-user'], ['expiresAtMs', String(Date.now() + 3_600_000)],
        ...(scenario === 'known' ? [['organizationUuid', 'known-organization']] : []),
      ]);
      const context = readContext('oauth', original);
      const requests: string[] = [];
      expect(runtime.enrichCredentialContext).toEqual(expect.any(Function));
      const result = await runtime.enrichCredentialContext!({
        ...context, operation: { operationId: 'context-profile', configurationRevision: 'configuration-1' },
        stagedCredentials: staged.store,
        services: { ...context.services, http: { async request(request) {
          requests.push(request.method);
          return { status: scenario === 'unavailable' ? 503 : 200, finalUrl: request.url, headers: {},
            body: new TextEncoder().encode(JSON.stringify({
              account: { uuid: scenario === 'mismatch' ? 'another-user' : 'provider-user' },
              organization: { uuid: scenario === 'known' ? 'known-organization' : 'attested-organization' },
            })) };
        } } },
      });
      expect(result.status).toBe(scenario === 'unavailable' ? 'unavailable' : scenario === 'mismatch' ? 'reconnectRequired' : 'connected');
      if (scenario === 'mismatch') expect(result).toMatchObject({
        diagnostic: { code: 'claude_subscription_profile_identity_mismatch' },
      });
      expect(requests).toEqual(['GET']);
      expect(original.get('accessToken')).toBe('current-access');
      expect(original.get('refreshToken')).toBe('current-refresh');
      expect(staged.values.has('accessToken')).toBe(false);
      expect(staged.values.has('refreshToken')).toBe(false);
      if (scenario === 'missing' || scenario === 'known') {
        const organizationId = scenario === 'known' ? 'known-organization' : 'attested-organization';
        expect(staged.values.get('organizationUuid')).toBe(organizationId);
        expect(result).toMatchObject({ providerIdentity: { accountId: 'provider-user', organizationId } });
      } else {
        expect(staged.values.size).toBe(0);
      }
    },
  );

  it.each([
    [429, 'unavailable'], [503, 'unavailable'], [401, 'reconnectRequired'],
  ] as const)('preserves stored credentials without staging when refresh returns %s (%s)', async (status, outcome) => {
    const runtime = activateConnectedAccountRuntime();
    const original = new Map([['accessToken', 'current-access'], ['refreshToken', 'current-refresh']]);
    const credentials = credentialStore(new Map(original));
    const staged = credentialStore();
    const account = { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'account-1' };
    const context = {
      account,
      configuration: { target: { kind: 'account', account, modeId: 'oauth' }, revision: 'configuration-1', values: {}, async getSecret() { return null; } },
      signal: new AbortController().signal,
      operation: { operationId: 'refresh-1', configurationRevision: 'configuration-1' },
      credentials: credentials.store,
      stagedCredentials: staged.store,
      services: { exec: { agentCli: { async checkReadiness() { return { launchable: [{ agentId: 'claude', version: '2.1.296' }] }; } } }, http: { async request() {
        return { status, finalUrl: 'https://platform.claude.com/v1/oauth/token', headers: {}, body: new Uint8Array() };
      } } },
    } as Parameters<typeof runtime.refresh>[0];

    await expect(runtime.refresh(context)).resolves.toMatchObject({ status: outcome,
      ...(status === 401 ? { diagnostic: { details: { credentialRefreshFailureKind: 'provider_401' } } } : {}),
    });
    expect(staged.values.size).toBe(0);
    expect(credentials.values).toEqual(original);
    await expect(runtime.status(context)).resolves.toMatchObject({ status: 'connected' });
  });

  describe('chosen-machine native credential import', () => {
    let configDir: string;
    const scopes = ['user:inference', 'user:profile', 'user:sessions:claude_code'];
    beforeEach(async () => {
      configDir = await mkdtemp(join(tmpdir(), 'happier-claude-qualified-import-'));
      vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    });
    afterEach(async () => {
      vi.unstubAllEnvs();
      await rm(configDir, { recursive: true, force: true });
    });
    function mode() {
      const native = activateConnectedAccountRuntime().authentication.modes['native-import'];
      if (!native || native.kind !== 'manual') throw new Error('Claude native-import mode is unavailable');
      return native;
    }
    function context(attempted: ReturnType<typeof credentialStore>) {
      return { attempt: { kind: 'connect', attemptId: 'claude-native' },
        signal: new AbortController().signal, services: { http: { request: vi.fn(() => { throw new Error('Unexpected OAuth request'); }) } },
        attemptCredentials: attempted.store } as Parameters<ReturnType<typeof mode>['complete']>[1];
    }
    it('stages the real configured native grant and metadata without refresh, identity inference or native writes', async () => {
      const credentialPath = join(configDir, '.credentials.json');
      const payload = JSON.stringify({ claudeAiOauth: { accessToken: 'native-access', refreshToken: 'native-refresh',
        expiresAt: Date.now() + 3_600_000, scopes, subscriptionType: 'max', rateLimitTier: 'max_20x' } });
      await writeFile(credentialPath, payload);
      await writeFile(join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'stale-account', emailAddress: 'stale@example.test' } }));
      const attempted = credentialStore();
      const callContext = context(attempted);
      const result = await mode().complete({ fields: { source: 'native' } }, callContext);
      expect(result).toMatchObject({ status: 'connected', credentialKind: 'oauth', scopes });
      expect(result).toHaveProperty('providerIdentity', { accountId: null, email: null, organizationId: null });
      expect(attempted.values.get('accessToken')).toBe('native-access');
      expect(attempted.values.get('refreshToken')).toBe('native-refresh');
      expect(attempted.values.get('subscriptionType')).toBe('max');
      expect(attempted.values.get('rateLimitTier')).toBe('max_20x');
      expect(attempted.values.has('providerAccountId')).toBe(false);
      expect(await readFile(credentialPath, 'utf8')).toBe(payload);
      expect(callContext.services.http.request).not.toHaveBeenCalled();
    });
    it('reports a missing native login without staging credentials', async () => {
      const attempted = credentialStore();
      await expect(mode().complete({ fields: { source: 'native' } }, context(attempted))).resolves.toMatchObject({
        status: 'unavailable', diagnostic: { code: 'claude_subscription_native_credentials_unavailable' },
      });
      expect(attempted.values.size).toBe(0);
    });
    it('rejects undeclared sources before staging credentials', async () => {
      const attempted = credentialStore();
      await expect(mode().complete({ fields: { source: 'other' } }, context(attempted))).resolves.toMatchObject({
        status: 'rejected', diagnostic: { code: 'claude_subscription_native_source_unsupported' },
      });
      expect(attempted.values.size).toBe(0);
    });
    it.each([
      { refreshToken: undefined }, { expiresAt: 1 }, { expiresAt: undefined }, { scopes: ['user:inference'] },
    ])('rejects an unusable native grant before staging credentials (%j)', async (overrides) => {
      await writeFile(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
        accessToken: 'native-access', refreshToken: 'native-refresh', expiresAt: Date.now() + 3_600_000, scopes, ...overrides,
      } }));
      const attempted = credentialStore();
      await expect(mode().complete({ fields: { source: 'native' } }, context(attempted))).resolves.toMatchObject({
        status: 'rejected', diagnostic: { code: 'claude_subscription_native_reauthorization_required' },
      });
      expect(attempted.values.size).toBe(0);
    });
  });

  it('uses the existing OAuth lifecycle and access-only materialization for imported credentials', async () => {
    const runtime = activateConnectedAccountRuntime();
    const context = readContext('native-import', new Map([
      ['accessToken', 'native-access'], ['refreshToken', 'native-refresh'],
      ['expiresAtMs', String(Date.now() + 3_600_000)],
      ['scopes', JSON.stringify(['user:inference', 'user:profile', 'user:sessions:claude_code'])],
      ['subscriptionType', 'max'], ['rateLimitTier', 'max_20x'],
    ]));
    await expect(runtime.status(context)).resolves.toMatchObject({ status: 'connected' });
    const materialized = await runtime.materialize({ kind: 'files', fileIds: ['.credentials.json'] }, context);
    if (materialized.kind !== 'files') throw new Error('Expected native credential materialization');
    const payload = JSON.parse(new TextDecoder().decode(materialized.files['.credentials.json']));
    expect(payload.claudeAiOauth).toMatchObject({ accessToken: 'native-access', subscriptionType: 'max', rateLimitTier: 'max_20x' });
    expect(payload.claudeAiOauth).not.toHaveProperty('refreshToken');
  });

  it('registers the authentication modes declared by the descriptor', () => {
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
      expect.objectContaining({ id: 'native-import', kind: 'manual', outcomeReconciliation: 'none' }),
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
      services: { exec: { agentCli: { async checkReadiness() { return { launchable: [{ agentId: 'claude', version: '2.1.296' }] }; } } } },
      attemptCredentials: attempted.store,
    } as Parameters<typeof mode.complete>[1]);
    expect(connected).toMatchObject({
      status: 'connected',
      displayName: 'Claude setup token',
      credentialKind: 'token',
      scopes: ['user:inference'],
    });
    expect(connected).not.toHaveProperty('accountId');
    expect(connected).toHaveProperty('providerIdentity', { accountId: null, email: null, organizationId: null });
    expect(attempted.values).toEqual(new Map([['setupToken', 'sk-ant-oat01-token']]));
  });

  it.each([
    { response: 429, status: 'unavailable', code: 'claude_subscription_oauth_unavailable' },
    { response: 503, status: 'unavailable', code: 'claude_subscription_oauth_unavailable' },
    { response: 401, status: 'rejected', code: 'claude_subscription_oauth_rejected' },
    { response: 'lost', status: 'outcomeUnknown', code: 'claude_subscription_oauth_outcome_unknown' },
    { response: 'incomplete', status: 'unavailable', code: 'claude_subscription_oauth_response_invalid' },
    { response: 'malformed', status: 'unavailable', code: 'claude_subscription_oauth_response_invalid' },
    { response: 'profileMismatch', status: 'rejected', code: 'claude_subscription_profile_identity_mismatch' },
  ] as const)('classifies an OAuth completion from its actual response ($response)', async scenario => {
    const mode = activateConnectedAccountRuntime().authentication.modes.oauth;
    if (!mode || mode.kind !== 'oauthAuthorizationCode') throw new Error('OAuth mode unavailable');
    const attempted = credentialStore();
    const context = {
      attempt: { kind: 'connect', attemptId: 'classified-oauth' },
      signal: new AbortController().signal,
      services: { http: { async request(request: { method: string; url: string }) {
        if (scenario.response === 'lost') throw new Error('Synthetic lost HTTP response');
        return { status: typeof scenario.response === 'number' ? scenario.response : 200,
          finalUrl: request.url, headers: {}, body: new TextEncoder().encode(scenario.response === 'malformed' ? 'unparseable-json' : JSON.stringify(
            scenario.response === 'profileMismatch'
              ? request.method === 'POST'
                ? { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', account: { uuid: 'expected-user' } }
                : { account: { uuid: 'different-user' }, organization: { uuid: 'different-organization' } }
              : {},
          )) };
      } } },
      attemptCredentials: attempted.store,
    } as Parameters<typeof mode.complete>[1];
    await expect(mode.complete({ code: 'synthetic-code', callbackUrl: 'https://example.test/callback',
      state: 'synthetic-state', pkceVerifier: 'synthetic-verifier' }, context)).resolves.toMatchObject({
      status: scenario.status, diagnostic: { code: scenario.code,
        ...(typeof scenario.response === 'number' ? { details: { httpStatus: scenario.response } } : {}),
      },
    });
    expect(attempted.values.size).toBe(0);
  });

  it.each(['connect', 'reconnect'] as const)('exchanges Claude PKCE OAuth and stages the nested immutable account identity (%s)', async kind => {
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
        organization: { uuid: 'organization-a' },
        account: {
          uuid: 'claude-account-1',
          email_address: 'claude@example.com',
        },
      })),
    }));
    const signal = new AbortController().signal;
    const context = {
      attempt: kind === 'connect' ? { kind, attemptId: 'claude-oauth-attempt' }
        : { kind, attemptId: 'claude-oauth-attempt', account: {
          service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'existing-account' } },
      signal,
      services: { exec: { agentCli: { async checkReadiness() { return { launchable: [{ agentId: 'claude', version: '2.1.296' }] }; } } }, http: { request } },
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
      providerIdentity: {
        accountId: 'claude-account-1',
        email: 'claude@example.com',
        organizationId: 'organization-a',
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
    const reconnected = await mode.complete({ code: 'authorization-code', callbackUrl: 'https://platform.claude.com/oauth/code/callback', state: 'state-1', pkceVerifier: 'verifier-1' }, { ...context, attempt: { kind: 'reconnect', account: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'historical-profile' } } } as Parameters<typeof mode.complete>[1]);
    expect(reconnected).not.toHaveProperty('accountId');
    expect(attempted.values.get('organizationUuid')).toBe('organization-a');
    expect(reconnected).toMatchObject({ providerIdentity: { accountId: 'claude-account-1' } });
  });

  it('materializes OAuth as an access-only native credential snapshot', async () => {
    const runtime = activateConnectedAccountRuntime();
    const credentials = credentialStore(new Map([
      ['accessToken', 'claude-access'],
      ['refreshToken', 'host-owned-refresh'],
      ['subscriptionType', 'max'],
      ['rateLimitTier', 'max_20x'],
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
        services: { exec: { agentCli: { async checkReadiness() { return { launchable: [{ agentId: 'claude', version: '2.1.296' }] }; } } } },
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
        subscriptionType: 'max',
        rateLimitTier: 'max_20x',
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
      usageAccountScope: 'unknown',
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

  it.each(['oauth', 'native-import'] as const)('materializes %s access-only environment without reading the host refresh token', async (mode) => {
    const runtime = activateConnectedAccountRuntime();
    const context = readContext(mode, new Map([
      ['accessToken', 'oauth-access'],
      ['refreshToken', 'host-owned-refresh'],
    ]));
    const read = vi.spyOn(context.credentials, 'get');
    await expect(runtime.materialize(
      { kind: 'environment', keys: ['ANTHROPIC_OAUTH_TOKEN'] }, context,
    )).resolves.toEqual({ kind: 'environment', env: { ANTHROPIC_OAUTH_TOKEN: 'oauth-access' } });
    expect(read.mock.calls.map(([key]) => key)).not.toContain('refreshToken');
    await expect(runtime.materialize(
      { kind: 'environment', keys: ['ANTHROPIC_API_KEY'] }, context,
    )).rejects.toMatchObject({ code: 'plugin_connected_account_claude_subscription_environment_request_unsupported' });
  });

  it('materializes setup tokens as native credentials and as the explicitly requested token environment', async () => {
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
    )).resolves.toEqual({
      kind: 'environment',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'setup-token' },
    });
    await expect(runtime.materialize(
      { kind: 'environment', keys: ['ANTHROPIC_OAUTH_TOKEN'] },
      readContext('setup-token', new Map([['setupToken', 'setup-token']])),
    )).resolves.toEqual({ kind: 'environment', env: { ANTHROPIC_OAUTH_TOKEN: 'setup-token' } });
    await expect(runtime.materialize(
      { kind: 'environment', keys: ['ANTHROPIC_API_KEY'] },
      readContext('setup-token', new Map([['setupToken', 'setup-token']])),
    )).rejects.toMatchObject({
      code: 'plugin_connected_account_claude_subscription_environment_request_unsupported',
    });
    await expect(runtime.materialize(
      { kind: 'environment', keys: ['CLAUDE_CODE_OAUTH_TOKEN'] },
      readContext('oauth', new Map([
        ['accessToken', 'oauth-access'],
        ['refreshToken', 'oauth-refresh'],
      ])),
    )).rejects.toMatchObject({
      code: 'plugin_connected_account_claude_subscription_oauth_request_auth_required',
    });
  });

  it.each(['oauth', 'native-import'] as const)('loads %s account quota through the activated runtime and its declared fixed provider origin', async (authenticationModeId) => {
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
        seven_day_sonnet: { utilization: 35, model_id: 'claude-sonnet-4-5', unit: 'tokens' },
        extra_usage: {
          is_enabled: true,
          monthly_limit: 100,
          used_credits: 20,
          utilization: 20,
        },
      })),
    }));
    const signal = new AbortController().signal;
    const context = readContext(authenticationModeId, new Map([
      ['accessToken', 'claude-access'],
      ['subscriptionType', 'max'],
      ['rateLimitTier', 'max_20x'],
      ['scopes', JSON.stringify(['user:inference', 'user:sessions:claude_code'])],
    ]));

    await expect(runtime.quota?.({
      ...context,
      signal,
      services: { exec: { agentCli: { async checkReadiness() { return { launchable: [{ agentId: 'claude', version: '2.1.296' }] }; } } }, http: { request } },
    })).resolves.toMatchObject({
      observedAtMs: expect.any(Number),
      planLabel: 'Claude Max',
      limits: expect.arrayContaining([
        {
          id: 'five_hour',
          label: '5-hour',
          windowDurationMs: 18_000_000,
          unit: 'unknown',
          status: 'ok',
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
          id: 'seven_day_sonnet',
          label: 'Weekly (Sonnet)',
          windowDurationMs: 604_800_000,
          modelId: 'claude-sonnet-4-5',
          unit: 'tokens',
          details: {},
        },
        {
          id: 'extra_usage',
          used: 20,
          remaining: 80,
        },
      ].map((limit) => expect.objectContaining(limit))),
    });
    expect(request).toHaveBeenCalledWith({
      url: 'https://api.anthropic.com/api/oauth/usage',
      method: 'GET',
      headers: {
        Authorization: 'Bearer claude-access',
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': expect.stringMatching(/^claude-cli\//),
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
      services: { exec: { agentCli: { async checkReadiness() { return { launchable: [{ agentId: 'claude', version: '2.1.296' }] }; } } }, http: { request } },
    })).resolves.toEqual({ observedAtMs: expect.any(Number), limits: [] });
    expect(request).not.toHaveBeenCalled();
  });
});
