import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentConnectedAccountLaunchContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { ANTIGRAVITY_AGENT_ID } from '../agent/install/cliRuntime.js';
import { ANTIGRAVITY_CREDENTIAL_ENV_KEY } from './antigravityConnectedAccountRuntime.js';
import { GEMINI_CONNECTED_ACCOUNT_SERVICE, GEMINI_API_KEY_ENV } from '@happier-dev/plugins-gemini/connected-account-service';
import { antigravityConnectedAccountLaunch } from '../agent/connectedServices/continuity.js';

const callbackUrl = 'https://antigravity.google/oauth-callback';
const service = { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' };
const scopes = ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/aicode'];

function store(values = new Map<string, string>()) {
  return { values, async get(key: string) { return values.get(key) ?? null; }, async set(key: string, value: string) { values.set(key, value); }, async delete(key: string) { values.delete(key); } };
}

const testkits: PluginTestkit[] = [];
afterEach(async () => {
  await Promise.all(testkits.splice(0).map(testkit => testkit.dispose()));
});

async function runtime(onLaunch?: (launch: AgentConnectedAccountLaunchContributionV1) => void): Promise<ConnectedAccountRuntime> {
  const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  testkits.push(testkit);
  const launch = testkit.registration('agents', ANTIGRAVITY_AGENT_ID)?.connectedAccountLaunch;
  if (launch) onLaunch?.(launch);
  const result = testkit.registration('connectedAccountDescriptors', service.localId);
  expect(result, 'Antigravity qualified account runtime is registered').toBeDefined();
  if (!result) throw new Error('Antigravity account runtime is unavailable');
  return result;
}

function readContext(credentials = store()) {
  const account = { service, accountId: 'selected-account' };
  return { account, credentials, signal: new AbortController().signal,
    configuration: { target: { kind: 'account' as const, account, modeId: 'oauth-personal' }, revision: 'configuration-1', values: {}, async getSecret() { return null; } },
  };
}

function response(status: number, body: unknown, finalUrl = 'https://oauth2.googleapis.com/token') {
  return { status, finalUrl, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}

describe('Antigravity qualified Connected Account', () => {
  it('declares the shared Gemini API-key account for native ACP authentication', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents.find(({ id }) => id === ANTIGRAVITY_AGENT_ID);
    expect(agent?.connectedAccounts).toContainEqual({
      purpose: 'gemini-api-key', service: GEMINI_CONNECTED_ACCOUNT_SERVICE,
      required: false, materializationKinds: ['environment'], credentialKinds: ['token'],
    });
    expect(antigravityConnectedAccountLaunch.environmentUses)
      .toContainEqual({ purpose: 'gemini-api-key', environmentKey: GEMINI_API_KEY_ENV });
  });
  it.each([
    { kind: 'httpHeaders', origin: 'https://daily-cloudcode-pa.googleapis.com', headerNames: ['authorization'] },
    { kind: 'environment', keys: [ANTIGRAVITY_CREDENTIAL_ENV_KEY] },
    { kind: 'files', fileIds: ['antigravity-acp/acp_token.json'] },
  ] as const)('reports typed missing credentials for $kind', async request => {
    const accountRuntime = await runtime();
    await expect(accountRuntime.materialize(request, readContext() as Parameters<typeof accountRuntime.materialize>[1]))
      .rejects.toMatchObject({ code: 'plugin_connected_account_credentials_unavailable' });
  });
  it('discovers and retains the fresh OAuth project before materializing an access-only native bundle', async () => {
    const accountRuntime = await runtime();
    const mode = accountRuntime.authentication.modes['oauth-personal'];
    if (!mode || mode.kind !== 'oauthAuthorizationCode') throw new Error('Expected OAuth');
    const attempted = store();
    const requests: Array<{ url: string; body?: Uint8Array; headers?: Readonly<Record<string, string>> }> = [];
    const context = { attempt: { kind: 'connect', attemptId: 'project-connect' }, service, attemptCredentials: attempted, signal: new AbortController().signal,
      services: { http: { async request(request: typeof requests[number]) {
        requests.push(request);
        if (request.url.includes('/userinfo')) return response(200, { sub: 'selected-account' });
        if (request.url.includes(':loadCodeAssist')) return response(200, { currentTier: { id: 'free-tier' }, paidTier: { id: 'free-tier' }, cloudaicompanionProject: 'fresh-project' });
        return response(200, { access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 });
      } } },
    } as Parameters<typeof mode.complete>[1];
    await expect(mode.complete({ callbackUrl, code: 'code', state: 'state', pkceVerifier: 'verifier' }, context)).resolves.toMatchObject({ status: 'connected' });
    expect(attempted.values.get('projectId')).toBe('fresh-project');
    const discovery = requests.find(request => request.url.includes(':loadCodeAssist'));
    expect(discovery?.headers?.Authorization).toBe('Bearer fresh-access');
    expect(JSON.parse(new TextDecoder().decode(discovery?.body))).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } });
    const bundle = await accountRuntime.materialize({ kind: 'environment', keys: ['GOOGLE_ANTIGRAVITY_CREDENTIAL'] }, readContext(attempted) as Parameters<typeof accountRuntime.materialize>[1]);
    expect(bundle.kind).toBe('environment');
    if (bundle.kind !== 'environment') throw new Error('Expected native bundle');
    expect(JSON.parse(bundle.env.GOOGLE_ANTIGRAVITY_CREDENTIAL)).toEqual({ access: 'fresh-access', expires: Number(attempted.values.get('expiresAtMs')), projectId: 'fresh-project' });
    expect(JSON.stringify(bundle)).not.toContain('fresh-refresh');
    expect(requests.filter(request => request.url.includes('/token'))).toHaveLength(1);
  });

  it('materializes gateway headers with retained project and actual credential expiry', async () => {
    const accountRuntime = await runtime();
    const credentials = store(new Map([['accessToken', 'selected-access'], ['projectId', 'selected-project'], ['expiresAtMs', '1700003600000']]));
    await expect(accountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://daily-cloudcode-pa.googleapis.com', headerNames: ['authorization'] },
      readContext(credentials) as Parameters<typeof accountRuntime.materialize>[1])).resolves.toEqual({
      kind: 'httpHeaders', headers: { authorization: 'Bearer selected-access' }, facts: { projectId: 'selected-project' }, expiresAt: 1700003600000,
    });
    await expect(accountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://daily-cloudcode-pa.googleapis.com', headerNames: ['authorization'] },
      readContext(store(new Map([['accessToken', 'selected-access']]))) as Parameters<typeof accountRuntime.materialize>[1])).resolves.toEqual({
      kind: 'httpHeaders', headers: { authorization: 'Bearer selected-access' }, facts: {},
    });
    await expect(accountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://daily-cloudcode-pa.googleapis.com', headerNames: ['x-unrelated'] },
      readContext(credentials) as Parameters<typeof accountRuntime.materialize>[1])).rejects.toThrow();
  });

  it.each(['complete', 'cancel', 'failed'] as const)('settles asynchronous onboarding as %s before staging credentials', async outcome => {
    const accountRuntime = await runtime();
    const mode = accountRuntime.authentication.modes['oauth-personal'];
    if (!mode || mode.kind !== 'oauthAuthorizationCode') throw new Error('Expected OAuth');
    const attempted = store();
    const controller = new AbortController();
    const requests: string[] = [];
    let provisioned = false;
    const context = { attempt: { kind: 'connect', attemptId: 'project-onboard' }, service, attemptCredentials: attempted, signal: controller.signal,
      services: { http: { async request(request: { url: string; body?: Uint8Array }) {
        requests.push(request.url);
        if (request.url.includes('/userinfo')) return response(200, { sub: 'selected-account' });
        if (request.url.includes(':loadCodeAssist')) return response(200, provisioned
          ? { currentTier: { id: 'free-tier' }, paidTier: { id: 'free-tier' }, cloudaicompanionProject: 'onboarded-project' }
          : { allowedTiers: [{ id: 'free-tier' }] });
        if (request.url.includes(':onboardUser')) {
          expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({ tierId: 'free-tier', metadata: { ideType: 'ANTIGRAVITY' } });
          if (outcome === 'cancel') controller.abort();
          return response(200, { name: 'operations/synthetic-onboarding', done: false });
        }
        if (request.url.endsWith('/operations/synthetic-onboarding')) {
          provisioned = true;
          return response(200, outcome === 'failed' ? { done: true, error: { code: 7, message: 'private vendor response' } }
            : { done: true, response: { '@type': 'type.googleapis.com/OnboardUserResponse' } });
        }
        return response(200, { access_token: 'fresh-access', refresh_token: 'fresh-refresh' });
      } } },
    } as Parameters<typeof mode.complete>[1];
    const operation = mode.complete({ callbackUrl, code: 'code', state: 'state', pkceVerifier: 'verifier' }, context);
    if (outcome === 'cancel') await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    else if (outcome === 'failed') {
      const result = await operation;
      expect(result).toMatchObject({ status: 'rejected', diagnostic: { code: 'antigravity_project_onboarding_failed' } });
      expect(JSON.stringify(result)).not.toContain('private vendor response');
    } else {
      await expect(operation).resolves.toMatchObject({ status: 'connected' });
      expect(attempted.values.get('projectId')).toBe('onboarded-project');
    }
    expect(requests.filter(url => url.endsWith('/operations/synthetic-onboarding'))).toHaveLength(outcome === 'cancel' ? 0 : 1);
    if (outcome !== 'complete') expect(attempted.values.size).toBe(0);
  });

  it.each([403, 503, 'missing'] as const)('does not claim fresh OAuth readiness when project discovery returns %s', async failure => {
    const accountRuntime = await runtime();
    const mode = accountRuntime.authentication.modes['oauth-personal'];
    if (!mode || mode.kind !== 'oauthAuthorizationCode') throw new Error('Expected OAuth');
    const attempted = store();
    const context = { attempt: { kind: 'connect', attemptId: 'project-failure' }, service, attemptCredentials: attempted, signal: new AbortController().signal,
      services: { http: { async request(request: { url: string }) {
        if (request.url.includes('/userinfo')) return response(200, { sub: 'selected-account' });
        if (request.url.includes(':loadCodeAssist')) return failure === 'missing'
          ? response(200, { currentTier: { id: 'free-tier' }, paidTier: { id: 'free-tier' } }) : response(failure, { error: 'private vendor response' });
        return response(200, { access_token: 'fresh-access', refresh_token: 'fresh-refresh' });
      } } },
    } as Parameters<typeof mode.complete>[1];
    const result = await mode.complete({ callbackUrl, code: 'code', state: 'state', pkceVerifier: 'verifier' }, context);
    expect(result).toMatchObject({ status: failure === 403 ? 'rejected' : 'outcomeUnknown', diagnostic: { code: failure === 'missing' ? 'antigravity_project_missing' : 'antigravity_project_http_failed' } });
    if (failure !== 'missing') expect(result).toMatchObject({ diagnostic: { details: { httpStatus: failure } } });
    expect(attempted.values.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain('private vendor response');
  });

  it('connects with the Antigravity issuing client, registered callback and selected-token identity', async () => {
    const accountRuntime = await runtime();
    const mode = accountRuntime.authentication.modes['oauth-personal'];
    if (!mode || mode.kind !== 'oauthAuthorizationCode') throw new Error('Antigravity OAuth is unavailable');
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(({ id }) => id === service.localId);
    expect(descriptor?.authentication.modes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'oauth-personal', callbackUrl, pkce: 'required' })]));
    const attempted = store();
    const requests: Array<{ url: string; body?: Uint8Array; headers?: Readonly<Record<string, string>> }> = [];
    const context = { attempt: { kind: 'connect', attemptId: 'connect-selected' }, service, attemptCredentials: attempted, signal: new AbortController().signal,
      services: { http: { async request(request: typeof requests[number]) { requests.push(request);
        if (request.url.includes(':loadCodeAssist')) return response(200, { currentTier: {}, paidTier: {}, cloudaicompanionProject: 'selected-project' }, request.url);
        return request.url.includes('/userinfo')
        ? response(200, { sub: 'selected-google-account', email: 'selected@example.com' }, request.url)
        : response(200, { access_token: 'selected-access', refresh_token: 'selected-refresh', expires_in: 3600 }); } } },
    } as Parameters<typeof mode.complete>[1];
    const begin = await mode.begin({ callbackUrl, state: 'state', pkce: { challenge: 'challenge', method: 'S256' } }, context);
    expect(begin.status).toBe('awaitingOAuthRedirect');
    if (begin.status !== 'awaitingOAuthRedirect') throw new Error('Antigravity authorization did not begin');
    const url = new URL(begin.authorizationUrl);
    expect(url.searchParams.get('client_id')).toBe('1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toBe(callbackUrl);
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(scopes);
    expect(url.searchParams.get('state')).toBe('state');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    const connected = await mode.complete({ callbackUrl, code: 'code', state: 'state', pkceVerifier: 'verifier' }, context);
    expect(connected).toMatchObject({
      status: 'connected', providerIdentity: { accountId: 'selected-google-account', email: 'selected@example.com' }, displayName: 'selected@example.com', scopes,
    });
    expect(connected).not.toHaveProperty('accountId');
    const body = new URLSearchParams(new TextDecoder().decode(requests[0]?.body));
    expect(body.get('client_id')).toBe(url.searchParams.get('client_id'));
    expect(body.get('redirect_uri')).toBe(callbackUrl);
    expect(body.get('code_verifier')).toBe('verifier');
    expect(requests[1]?.headers?.Authorization).toBe('Bearer selected-access');
    expect(attempted.values.get('refreshToken')).toBe('selected-refresh');
    expect(attempted.values.get('providerEmail')).toBe('selected@example.com');
  });

  it('preserves an explicitly empty scope instead of claiming the requested grants', async () => {
    const accountRuntime = await runtime();
    const mode = accountRuntime.authentication.modes['oauth-personal'];
    if (!mode || mode.kind !== 'oauthAuthorizationCode') throw new Error('Antigravity OAuth is unavailable');
    const attempted = store();
    const context = { attempt: { kind: 'connect', attemptId: 'connect-empty-grants' }, service, attemptCredentials: attempted, signal: new AbortController().signal,
      services: { http: { async request(request: { url: string }) {
        if (request.url.includes(':loadCodeAssist')) return response(200, { currentTier: {}, paidTier: {}, cloudaicompanionProject: 'selected-project' }, request.url);
        return request.url.includes('/userinfo')
        ? response(200, { sub: 'selected-google-account' }, request.url)
        : response(200, { access_token: 'selected-access', refresh_token: 'selected-refresh', scope: '' }); } } },
    } as Parameters<typeof mode.complete>[1];
    await expect(mode.complete({ callbackUrl, code: 'code', state: 'state', pkceVerifier: 'verifier' }, context)).resolves.toMatchObject({ status: 'connected', scopes: [] });
    expect(attempted.values.get('scopes')).toBe('[]');
  });

  it.each([[401, 'rejected'], [503, 'connected']] as const)('uses an honest identity outcome after userinfo HTTP %s', async (status, outcome) => {
    const accountRuntime = await runtime();
    const mode = accountRuntime.authentication.modes['oauth-personal'];
    if (!mode || mode.kind !== 'oauthAuthorizationCode') throw new Error('Antigravity OAuth is unavailable');
    const attempted = store();
    const context = { attempt: { kind: 'connect', attemptId: 'connect-identity' }, service, attemptCredentials: attempted, signal: new AbortController().signal,
      services: { http: { async request(request: { url: string }) {
        if (request.url.includes(':loadCodeAssist')) return response(200, { currentTier: {}, paidTier: {}, cloudaicompanionProject: 'selected-project' }, request.url);
        return request.url.includes('/userinfo') ? response(status, {}, request.url) : response(200, { access_token: 'access', refresh_token: 'refresh' });
      } } },
    } as Parameters<typeof mode.complete>[1];
    const result = await mode.complete({ callbackUrl, code: 'code', state: 'state', pkceVerifier: 'verifier' }, context);
    expect(result.status).toBe(outcome);
    if (status === 401) expect(attempted.values.size).toBe(0);
    else {
      expect(result).not.toHaveProperty('providerIdentity');
      expect(result).not.toHaveProperty('accountId');
    }
  });

  it.each([
    ['oauth-personal', 'missing', 'reconnect'], ['oauth-personal', 'email-only', 'reconnect'], ['oauth-personal', 'verified', 'reconnect'],
    ['native-import', 'missing', 'reconnect'], ['native-import', 'email-only', 'reconnect'], ['native-import', 'verified', 'reconnect'],
    ['native-import', 'missing', 'connect'],
  ] as const)('finalizes %s with %s identity for %s before staging a replacement grant', async (modeId, identityKind, attemptKind) => {
    const home = await mkdtemp(join(tmpdir(), 'agy-reconnect-identity-'));
    vi.stubEnv('GEMINI_HOME', home); vi.stubEnv('AGY_ACP_FORCE_FILE_STORAGE', '1');
    try {
      await mkdir(join(home, 'antigravity-acp'));
      await writeFile(join(home, 'antigravity-acp/acp_token.json'), JSON.stringify({ client_id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com', refresh_token: 'native-replacement', project_id: 'replacement-project' }));
      const accountRuntime = await runtime();
      const mode = accountRuntime.authentication.modes[modeId];
      if (!mode || (mode.kind !== 'manual' && mode.kind !== 'oauthAuthorizationCode')) throw new Error('Expected account acquisition mode');
      const attempted = store();
      const identity = identityKind === 'verified' ? { sub: 'stable-provider-account', email: 'stable@example.test' } : identityKind === 'email-only' ? { email: 'stable@example.test' } : {};
      const context = { attempt: attemptKind === 'connect' ? { kind: 'connect', attemptId: 'identity-connect' } : { kind: 'reconnect', attemptId: 'identity-reconnect', account: { service, accountId: 'stable-provider-account' } },
        service, attemptCredentials: attempted, signal: new AbortController().signal,
        services: { logger: { warn() {} }, http: { async request(request: { url: string }) {
          if (request.url.includes(':loadCodeAssist')) return response(200, { currentTier: {}, paidTier: {}, cloudaicompanionProject: 'selected-project' }, request.url);
          if (request.url.includes('/userinfo')) return response(200, identity, request.url);
          if (request.url.includes('/tokeninfo')) return response(200, { azp: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com', scope: scopes.join(' '), expires_in: '3600', ...identity }, request.url);
          return response(200, { access_token: 'replacement-access', refresh_token: 'replacement-refresh', expires_in: 3600, scope: scopes.join(' ') }, request.url);
        } } },
      } as Parameters<typeof mode.complete>[1];
      const outcome = mode.kind === 'manual'
        ? await mode.complete({ fields: { source: 'acp' } }, context)
        : await mode.complete({ callbackUrl, code: 'replacement-code', state: 'state', pkceVerifier: 'verifier' }, context);
      const accepted = attemptKind === 'connect' || identityKind === 'verified';
      expect(outcome.status).toBe(accepted ? 'connected' : 'rejected');
      if (accepted) {
        expect(attempted.values.get('accessToken')).toBe('replacement-access');
        if (identityKind === 'verified') {
          expect(outcome).toMatchObject({ providerIdentity: { accountId: 'stable-provider-account' } });
          expect(outcome).not.toHaveProperty('accountId');
        }
      } else expect(attempted.values.size).toBe(0);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });

  it('does not invent grants for stored credentials with unknown scope', async () => {
    const accountRuntime = await runtime();
    const context = readContext(store(new Map([['accessToken', 'selected-access'], ['refreshToken', 'selected-refresh']])));
    // These credential-read boundaries do not use the host services omitted by this fixture.
    await expect(accountRuntime.status(context as Parameters<typeof accountRuntime.status>[0])).resolves.toMatchObject({ status: 'connected', credentialKind: 'oauth', scopes: [] });
    const result = await accountRuntime.materialize({ kind: 'files', fileIds: ['antigravity-acp/acp_token.json'] }, context as Parameters<typeof accountRuntime.materialize>[1]);
    if (result.kind !== 'files') throw new Error('Expected Antigravity token materialization');
    expect(JSON.parse(new TextDecoder().decode(result.files['antigravity-acp/acp_token.json'])).scopes).toEqual([]);
  });

  it('retains selected identity, refresh token and project when refreshing without replacement facts', async () => {
    const accountRuntime = await runtime();
    const credentials = store(new Map([['accessToken', 'old-access'], ['refreshToken', 'selected-refresh'], ['providerEmail', 'selected@example.com'], ['providerAccountId', 'selected-google-account'], ['projectId', 'selected-project'], ['scopes', JSON.stringify(scopes)]]));
    const staged = store();
    const context = { ...readContext(credentials), operation: { operationId: 'refresh', configurationRevision: 'configuration-1' }, stagedCredentials: staged,
      services: { http: { async request() { return response(200, { access_token: 'new-access', expires_in: 3600 }); } } },
    } as Parameters<typeof accountRuntime.refresh>[0];
    const refreshed = await accountRuntime.refresh(context);
    expect(refreshed).toMatchObject({ status: 'connected', credentialKind: 'oauth', displayName: 'selected@example.com', scopes });
    expect(refreshed).toHaveProperty('expiresAt', Number(staged.values.get('expiresAtMs')));
    await expect(accountRuntime.status(readContext(staged) as Parameters<typeof accountRuntime.status>[0])).resolves.toMatchObject({
      status: 'connected', credentialKind: 'oauth', expiresAt: Number(staged.values.get('expiresAtMs')),
    });
    expect(staged.values.get('accessToken')).toBe('new-access');
    expect(staged.values.get('refreshToken')).toBe('selected-refresh');
    expect(JSON.parse(staged.values.get('scopes') ?? 'null')).toEqual(scopes);
    expect(staged.values.get('providerAccountId')).toBe('selected-google-account');
    expect(staged.values.get('projectId')).toBe('selected-project');
  });

  it.each([
    [401, {}, 'outcomeUnknown', 'provider_401'],
    [403, { error: 'policy_refusal' }, 'outcomeUnknown', 'provider_403'],
    [400, { error: 'invalid_grant', error_description: 'private vendor detail' }, 'reconnectRequired', 'invalid_grant'],
    [400, { error: 'refresh_token_expired' }, 'reconnectRequired', 'invalid_grant'],
    [429, {}, 'outcomeUnknown', 'unknown'],
    [503, {}, 'outcomeUnknown', 'unknown'],
  ] as const)('retains credentials without staging after refresh HTTP %s', async (status, body, expected, kind) => {
    const accountRuntime = await runtime();
    const credentials = store(new Map([['accessToken', 'old-access'], ['refreshToken', 'old-refresh']]));
    const staged = store();
    const context = { ...readContext(credentials), operation: { operationId: 'refresh', configurationRevision: 'configuration-1' }, stagedCredentials: staged,
      services: { http: { async request() { return response(status, body); } } },
    } as Parameters<typeof accountRuntime.refresh>[0];
    const result = await accountRuntime.refresh(context);
    expect(result).toMatchObject({ status: expected, diagnostic: { details: { credentialRefreshFailureKind: kind, httpStatus: status } } });
    if ('error' in body && (body.error === 'invalid_grant' || body.error === 'refresh_token_expired')) {
      expect(result).toMatchObject({ diagnostic: { details: { providerErrorCode: body.error } } });
    }
    expect(JSON.stringify(result)).not.toContain('private vendor detail');
    expect(staged.values.size).toBe(0);
    expect(credentials.values.get('refreshToken')).toBe('old-refresh');
  });

  it('reads quota through the registered selected-account runtime', async () => {
    const accountRuntime = await runtime();
    if (!accountRuntime.quota) throw new Error('Antigravity quota is unavailable');
    const credentials = store(new Map([['accessToken', 'selected-access'], ['projectId', 'selected-project']]));
    const context = { ...readContext(credentials), services: { http: { async request(request: { url: string; headers?: Readonly<Record<string, string>>; body?: Uint8Array }) {
      expect(request.headers?.Authorization).toBe('Bearer selected-access');
      if (request.url.endsWith(':loadCodeAssist')) return response(200, { currentTier: { id: 'tier' }, paidTier: { usesGcpTos: false }, cloudaicompanionProject: 'provider-project' }, request.url);
      expect(request.url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
      expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({ project: 'selected-project' });
      return response(200, { groups: [{ displayName: 'Provider group', buckets: [{ bucketId: 'period', window: 'provider-period', remainingFraction: 0.25 }] }] }, request.url);
    } } } } as Parameters<NonNullable<ConnectedAccountRuntime['quota']>>[0];
    await expect(accountRuntime.quota(context)).resolves.toMatchObject({ limits: [{ id: 'period', label: 'Provider group · provider-period', remainingPct: 25, limit: null }] });
  });

  it('materializes only selected native files with the issuing client and retained project', async () => {
    const accountRuntime = await runtime();
    const credentials = store(new Map([['accessToken', 'selected-access'], ['refreshToken', 'selected-refresh'], ['projectId', 'selected-project'], ['expiresAtMs', '1700003600000'], ['scopes', JSON.stringify(scopes)]]));
    const materialized = await accountRuntime.materialize({ kind: 'files', fileIds: ['antigravity-acp/acp_token.json', 'antigravity-acp/settings.json'] }, readContext(credentials) as Parameters<typeof accountRuntime.materialize>[1]);
    expect(materialized.kind).toBe('files');
    if (materialized.kind !== 'files') throw new Error('Native files were not materialized');
    expect(Object.keys(materialized.files).sort()).toEqual(['antigravity-acp/acp_token.json', 'antigravity-acp/settings.json']);
    expect(JSON.parse(new TextDecoder().decode(materialized.files['antigravity-acp/acp_token.json']))).toMatchObject({
      token: 'selected-access', refresh_token: 'selected-refresh', client_id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com', token_uri: 'https://oauth2.googleapis.com/token', project_id: 'selected-project', scopes,
    });
    expect(JSON.parse(new TextDecoder().decode(materialized.files['antigravity-acp/settings.json']))).toEqual({ auth: { type: 'oauth-personal' } });
  });
  it('requires a completed provider turn with the exact qualified selection epoch after a restart', async () => {
    let launch: AgentConnectedAccountLaunchContributionV1 | undefined;
    await runtime(value => { launch = value; });
    const adapter = launch?.continuity?.runtimeAuthAdapter;
    expect(adapter, 'Host ACP account continuity is registered through actual activation').toBeDefined();
    if (!adapter?.verifyProviderOutcome) throw new Error('Provider completion verification is unavailable');
    const selected = { kind: 'group' as const, serviceId: 'happier.agent.antigravity/antigravity-account', activeProfileId: 'selected-account', groupId: 'pool-a', generation: 3, credentialRevision: 'revision-a' };
    const target = { agentId: ANTIGRAVITY_AGENT_ID };
    expect(adapter.canHotApply({ target, selection: selected })).toMatchObject({ supported: false, recovery: 'restart_rematerialize' });
    await expect(adapter.verifyActiveAccount?.({ target, selection: selected })).resolves.toMatchObject({ status: 'unavailable' });
    await expect(adapter.verifyProviderOutcome({ target, selections: [selected], outcome: { kind: 'provider_activity', event: 'task_started' } })).resolves.toMatchObject({ status: 'unavailable' });
    await expect(adapter.verifyProviderOutcome({ target, selections: [{ ...selected, credentialRevision: null }], outcome: { kind: 'provider_activity', event: 'assistant_message_end' } })).resolves.toMatchObject({ status: 'unavailable' });
    await expect(adapter.verifyProviderOutcome({ target, selections: [{ ...selected, serviceId: 'happier.agent.gemini/gemini-account' }], outcome: { kind: 'provider_activity', event: 'assistant_message_end' } })).resolves.toMatchObject({ status: 'unavailable' });
    await expect(adapter.verifyProviderOutcome({ target, selections: [selected], outcome: { kind: 'provider_activity', event: 'assistant_message_end' } })).resolves.toMatchObject({ status: 'verified', targets: [{ serviceId: selected.serviceId, profileId: 'selected-account', groupId: 'pool-a', groupGeneration: 3, credentialRevision: 'revision-a' }] });
    await expect(adapter.verifyProviderOutcome({ target, selections: [selected, selected], outcome: { kind: 'provider_activity', event: 'assistant_message_end' } })).resolves.toMatchObject({ status: 'unavailable' });
    await expect(adapter.verifyProviderOutcome({ target, selections: [{ ...selected, generation: -1 }], outcome: { kind: 'provider_activity', event: 'assistant_message_end' } })).resolves.toMatchObject({ status: 'unavailable' });
    const profile = { kind: 'profile' as const, serviceId: selected.serviceId, profileId: 'selected-profile', credentialRevision: 'profile-revision' };
    await expect(adapter.verifyProviderOutcome({ target, selections: [profile], outcome: { kind: 'provider_activity', event: 'assistant_message_end' } })).resolves.toMatchObject({ status: 'verified', targets: [{ serviceId: profile.serviceId, profileId: profile.profileId, groupId: null, groupGeneration: null, credentialRevision: profile.credentialRevision }] });

  });

});


describe('Antigravity explicit native import', () => {
  it.each([[200, 'rejected'], [401, 'rejected'], [403, 'unavailable'], [429, 'unavailable'], [503, 'unavailable'], ['network', 'unavailable']] as const)('does not refresh valid native access or stage unverified grants after tokeninfo HTTP %s', async (status, expected) => {
    const home = await mkdtemp(join(tmpdir(), 'agy-native-import-grants-'));
    vi.stubEnv('GEMINI_HOME', home); vi.stubEnv('AGY_ACP_FORCE_FILE_STORAGE', '1');
    try {
      await mkdir(join(home, 'antigravity-acp'));
      await writeFile(join(home, 'antigravity-acp/acp_token.json'), JSON.stringify({ client_id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com', token: 'valid-native-access', refresh_token: 'native-refresh', expiry: new Date(Date.now() + 3_600_000).toISOString(), scopes }));
      const accountRuntime = await runtime();
      const mode = accountRuntime.authentication.modes['native-import'];
      if (!mode || mode.kind !== 'manual') throw new Error('Native import unavailable');
      const attempted = store();
      const requests: string[] = [];
      const context = { attempt: { kind: 'connect', attemptId: 'native-unverified' }, service, attemptCredentials: attempted, signal: new AbortController().signal,
        services: { http: { async request(request: { url: string }) { requests.push(request.url); if (status === 'network') throw new Error('Network unavailable'); return response(status, { azp: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com', expires_in: '3600' }, request.url); } } },
      } as Parameters<typeof mode.complete>[1];
      await expect(mode.complete({ fields: { source: 'acp' } }, context)).resolves.toMatchObject({ status: expected });
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0]!).pathname).toBe('/tokeninfo');
      expect(attempted.values.size).toBe(0);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('imports the selected native ACP grant into ordinary OAuth attempt storage and materialization', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agy-native-import-'));
    vi.stubEnv('GEMINI_HOME', home); vi.stubEnv('AGY_ACP_FORCE_FILE_STORAGE', '1');
    try {
      await mkdir(join(home, 'antigravity-acp'));
      await writeFile(join(home, 'antigravity-acp/acp_token.json'), JSON.stringify({ client_id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com', refresh_token: 'native-refresh', scopes, project_id: 'native-project' }));
      const accountRuntime = await runtime();
      const mode = accountRuntime.authentication.modes['native-import'];
      expect(mode?.kind).toBe('manual');
      if (!mode || mode.kind !== 'manual') throw new Error('Native import unavailable');
      const attempted = store();
      const requests: string[] = [];
      const context = { attempt: { kind: 'connect', attemptId: 'native-import' }, service, attemptCredentials: attempted, signal: new AbortController().signal,
        services: { http: { async request(request: { url: string }) { requests.push(request.url); return request.url.includes('/tokeninfo')
          ? response(200, { azp: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com', sub: 'native-account', email: 'native@example.test', scope: scopes.join(' '), expires_in: '3600' }, request.url)
          : response(200, { access_token: 'native-access', expires_in: 3600 }, request.url); } } },
      } as Parameters<typeof mode.complete>[1];
      const connected = await mode.complete({ fields: { source: 'acp' } }, context);
      expect(connected).toMatchObject({ status: 'connected', credentialKind: 'oauth', providerIdentity: { accountId: 'native-account', email: 'native@example.test' }, scopes });
      expect(requests).toContain('https://oauth2.googleapis.com/token');
      expect(attempted.values.get('refreshToken')).toBe('native-refresh');
      expect(attempted.values.get('projectId')).toBe('native-project');
      const read = readContext(attempted); read.configuration.target.modeId = 'native-import';
      await expect(accountRuntime.status(read as Parameters<typeof accountRuntime.status>[0])).resolves.toMatchObject({ status: 'connected', scopes });
      const files = await accountRuntime.materialize({ kind: 'files', fileIds: ['antigravity-acp/acp_token.json'] }, read as Parameters<typeof accountRuntime.materialize>[1]);
      if (files.kind !== 'files') throw new Error('Expected OAuth materialization');
      expect(JSON.parse(new TextDecoder().decode(files.files['antigravity-acp/acp_token.json']))).toMatchObject({ refresh_token: 'native-refresh', project_id: 'native-project', scopes });
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
});
