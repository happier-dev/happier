import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentConnectedAccountLaunchContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { ANTIGRAVITY_AGENT_ID } from '../agent/install/cliRuntime.js';

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
  it('connects with the Antigravity issuing client, registered callback and selected-token identity', async () => {
    const accountRuntime = await runtime();
    const mode = accountRuntime.authentication.modes['oauth-personal'];
    if (!mode || mode.kind !== 'oauthAuthorizationCode') throw new Error('Antigravity OAuth is unavailable');
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(({ id }) => id === service.localId);
    expect(descriptor?.authentication.modes).toEqual([expect.objectContaining({ id: 'oauth-personal', callbackUrl, pkce: 'required' })]);
    const attempted = store();
    const requests: Array<{ url: string; body?: Uint8Array; headers?: Readonly<Record<string, string>> }> = [];
    const context = { attempt: { kind: 'connect', attemptId: 'connect-selected' }, service, attemptCredentials: attempted, signal: new AbortController().signal,
      services: { http: { async request(request: typeof requests[number]) { requests.push(request); return request.url.includes('/userinfo')
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
    await expect(mode.complete({ callbackUrl, code: 'code', state: 'state', pkceVerifier: 'verifier' }, context)).resolves.toMatchObject({
      status: 'connected', accountId: 'selected-google-account', providerIdentity: { email: 'selected@example.com' }, displayName: 'selected@example.com', scopes,
    });
    const body = new URLSearchParams(new TextDecoder().decode(requests[0]?.body));
    expect(body.get('client_id')).toBe(url.searchParams.get('client_id'));
    expect(body.get('redirect_uri')).toBe(callbackUrl);
    expect(body.get('code_verifier')).toBe('verifier');
    expect(requests[1]?.headers?.Authorization).toBe('Bearer selected-access');
    expect(attempted.values.get('refreshToken')).toBe('selected-refresh');
    expect(attempted.values.get('providerEmail')).toBe('selected@example.com');
  });

  it.each([[401, 'rejected'], [503, 'connected']] as const)('uses an honest identity outcome after userinfo HTTP %s', async (status, outcome) => {
    const accountRuntime = await runtime();
    const mode = accountRuntime.authentication.modes['oauth-personal'];
    if (!mode || mode.kind !== 'oauthAuthorizationCode') throw new Error('Antigravity OAuth is unavailable');
    const attempted = store();
    const warnings: unknown[] = [];
    const context = { attempt: { kind: 'connect', attemptId: 'connect-identity' }, service, attemptCredentials: attempted, signal: new AbortController().signal,
      services: { logger: { warn(_message: string, fields: unknown) { warnings.push(fields); } }, http: { async request(request: { url: string }) {
        return request.url.includes('/userinfo') ? response(status, {}, request.url) : response(200, { access_token: 'access', refresh_token: 'refresh' });
      } } },
    } as Parameters<typeof mode.complete>[1];
    const result = await mode.complete({ callbackUrl, code: 'code', state: 'state', pkceVerifier: 'verifier' }, context);
    expect(result.status).toBe(outcome);
    if (status === 401) expect(attempted.values.size).toBe(0);
    else {
      expect(result).not.toHaveProperty('providerIdentity');
      expect(result).not.toHaveProperty('accountId');
      expect(warnings).toEqual([{ code: 'antigravity_identity_unavailable' }]);
    }
  });

  it('retains selected identity, refresh token and project when refreshing without replacement facts', async () => {
    const accountRuntime = await runtime();
    const credentials = store(new Map([['accessToken', 'old-access'], ['refreshToken', 'selected-refresh'], ['providerEmail', 'selected@example.com'], ['providerAccountId', 'selected-google-account'], ['projectId', 'selected-project'], ['scopes', JSON.stringify(scopes)]]));
    const staged = store();
    const context = { ...readContext(credentials), operation: { operationId: 'refresh', configurationRevision: 'configuration-1' }, stagedCredentials: staged,
      services: { http: { async request() { return response(200, { access_token: 'new-access', expires_in: 3600 }); } } },
    } as Parameters<typeof accountRuntime.refresh>[0];
    await expect(accountRuntime.refresh(context)).resolves.toMatchObject({ status: 'connected', displayName: 'selected@example.com' });
    expect(staged.values.get('accessToken')).toBe('new-access');
    expect(staged.values.get('refreshToken')).toBe('selected-refresh');
    expect(staged.values.get('providerAccountId')).toBe('selected-google-account');
    expect(staged.values.get('projectId')).toBe('selected-project');
  });

  it.each([[401, 'reconnectRequired'], [503, 'outcomeUnknown']] as const)('retains credentials without staging after refresh HTTP %s', async (status, expected) => {
    const accountRuntime = await runtime();
    const credentials = store(new Map([['accessToken', 'old-access'], ['refreshToken', 'old-refresh']]));
    const staged = store();
    const context = { ...readContext(credentials), operation: { operationId: 'refresh', configurationRevision: 'configuration-1' }, stagedCredentials: staged,
      services: { http: { async request() { return response(status, {}); } } },
    } as Parameters<typeof accountRuntime.refresh>[0];
    await expect(accountRuntime.refresh(context)).resolves.toMatchObject({ status: expected });
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
    const credentials = store(new Map([['accessToken', 'selected-access'], ['refreshToken', 'selected-refresh'], ['projectId', 'selected-project'], ['expiresAtMs', '1700003600000']]));
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
  });

});
