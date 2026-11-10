import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { applyProjectedCredentialKindRestrictions } from '../../../../agents/src/connectedServices/sessionOptions.js';

function store() {
  const values = new Map<string, string>();
  return { values, async get(key: string) { return values.get(key) ?? null; },
    async set(key: string, value: string) { values.set(key, value); }, async delete(key: string) { values.delete(key); } };
}
async function runtime() {
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const result = kit.registration('connectedAccountDescriptors', 'devin-account');
  await kit.dispose();
  if (!result) throw new Error('Devin account runtime is not registered');
  return result;
}
function context(status = 200, payload: unknown = { token: 'eyJ.fake.session' }, profile?: unknown) {
  const credentials = store();
  const requests: Array<{ url: string; body?: Uint8Array; headers?: Readonly<Record<string, string>> }> = [];
  // HTTP is the external boundary; the complete registered plugin path remains real.
  const ctx = { attempt: { kind: 'connect', attemptId: 'fake-attempt' }, service: { pluginId: 'happier.agent.devin', localId: 'devin-account' },
    attemptCredentials: credentials, signal: new AbortController().signal,
    configuration: { target: { kind: 'attempt', attemptId: 'fake-attempt', service: { pluginId: 'happier.agent.devin', localId: 'devin-account' }, modeId: 'browser-session' }, revision: '1', values: {}, async getSecret() { return null; } },
    services: { http: { async request(request: typeof requests[number]) { requests.push(request);
      return { status: request.url.endsWith('/self') ? profile ? 200 : 503 : status, finalUrl: request.url, headers: {},
        body: new TextEncoder().encode(JSON.stringify(request.url.endsWith('/self') ? profile : payload)) }; } } },
  } as ConnectedAccountAuthenticationContext;
  return { ctx, credentials, requests };
}
const completion = { code: 'fake-code', callbackUrl: 'http://localhost:53100/callback', state: 'fake-state', pkceVerifier: 'fake-verifier' };
describe('Devin connected account through registered plugin', () => {
  it('keeps the confirmed upstream user and organization separate from the saved grant identity', async () => {
    const owner = await runtime();
    const mode = owner.authentication.modes['browser-session'];
    if (mode?.kind !== 'oauthAuthorizationCode') throw new Error('Missing browser session mode');
    const { ctx } = context(200, { token: 'eyJ.fake.session' }, { user_id: 'devin-user', org_id: 'devin-org' });
    const connected = await mode.complete(completion, ctx);
    expect(connected).toMatchObject({ status: 'connected', providerIdentity: { accountId: 'devin-user', organizationId: 'devin-org' } });
    expect(connected).not.toHaveProperty('accountId');
  });
  it('uses host PKCE and one code exchange; optional identity failure preserves a session without inventing refresh', async () => {
    const owner = await runtime();
    const mode = owner.authentication.modes['browser-session'];
    if (mode?.kind !== 'oauthAuthorizationCode') throw new Error('Missing browser session mode');
    const { ctx, credentials, requests } = context();
    const begin = await mode.begin({ callbackUrl: completion.callbackUrl, state: completion.state, pkce: { method: 'S256', challenge: 'fake-challenge' } }, ctx);
    if (begin.status !== 'awaitingOAuthRedirect') throw new Error('No authorization navigation');
    const url = new URL(begin.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://app.devin.ai/auth/cli/continue');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ code_challenge: 'fake-challenge', code_challenge_method: 'S256', state: 'fake-state', redirect_uri: completion.callbackUrl });
    const connected = await mode.complete(completion, ctx);
    expect(connected).toMatchObject({ status: 'connected', credentialKind: 'oauth', scopes: [] });
    if (connected.status !== 'connected') throw new Error('Devin grant was not connected');
    const purpose = PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'devin')?.connectedAccounts?.[0];
    expect(purpose?.credentialKinds).toContain(connected.credentialKind);
    expect(requests.map(r => r.url)).toEqual(['https://api.devin.ai/auth/cli/token', 'https://api.devin.ai/v3/self']);
    expect(JSON.parse(new TextDecoder().decode(requests[0].body))).toEqual({ code: 'fake-code', code_verifier: 'fake-verifier' });
    expect(credentials.values.get('sessionToken')).toBe('devin-session-token$eyJ.fake.session');
    expect(credentials.values.get('credentialMode')).toBe('session');
    expect(credentials.values.has('refreshToken')).toBe(false);
    expect(credentials.values.has('expiresAt')).toBe(false);
    const read = { ...ctx, credentials, account: { service: ctx.service, accountId: 'fake-account' } } as Parameters<ConnectedAccountRuntime['status']>[0];
    const native = await owner.materialize({ kind: 'files', fileIds: ['devin/credentials.toml'] }, read);
    if (native.kind !== 'files') throw new Error('Expected selected native credentials');
    expect(new TextDecoder().decode(native.files['devin/credentials.toml'])).toContain('devin-session-token$eyJ.fake.session');
    expect(await owner.materialize({ kind: 'httpHeaders', origin: 'https://server.codeium.com', headerNames: ['authorization'] }, read)).toMatchObject({
      kind: 'httpHeaders', headers: { authorization: 'Basic devin-session-token$eyJ.fake.session-devin-session-token$eyJ.fake.session' },
      facts: { base_url: 'https://server.codeium.com', device_seed: 'fake-account' },
    });
    await expect(owner.materialize({ kind: 'httpHeaders', origin: 'https://unrelated.example.test', headerNames: ['authorization'] }, read)).rejects.toThrow();
  });
  it.each([403, 429, 503])('keeps inconclusive exchange HTTP %s redacted and does not stage credentials', async status => {
    const owner = await runtime();
    const mode = owner.authentication.modes['browser-session'];
    if (mode?.kind !== 'oauthAuthorizationCode') throw new Error('Missing mode');
    const { ctx, credentials, requests } = context(status, { error: 'fake-secret-server-body' });
    const result = await mode.complete(completion, ctx);
    expect(result.status).toBe('outcomeUnknown');
    expect(JSON.stringify(result)).not.toContain('fake-secret-server-body');
    expect(credentials.values.size).toBe(0);
    expect(requests).toHaveLength(1);
  });
  it('keeps enterprise seat credentials distinct and performs zero token/profile/refresh requests', async () => {
    const owner = await runtime();
    const mode = owner.authentication.modes['enterprise-seat'];
    if (mode?.kind !== 'manual') throw new Error('Missing enterprise mode');
    const { ctx, credentials, requests } = context();
    const connected = await mode.complete({ fields: { seatToken: 'fake-seat-key', apiServerUrl: 'https://enterprise.example.test' } }, ctx);
    expect(connected).toMatchObject({ status: 'connected', credentialKind: 'token' });
    if (connected.status !== 'connected') throw new Error('Expected connected enterprise credential');
    const purpose = PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'devin')?.connectedAccounts?.[0];
    expect(purpose?.credentialKinds).toContain(connected.credentialKind);
    const key = 'happier.agent.devin/devin-account';
    const inventory = applyProjectedCredentialKindRestrictions({ optionsByServiceId: { [key]: [
      { profileId: 'known-allowed', status: 'connected', kind: connected.credentialKind },
      { profileId: 'unknown', status: 'connected', kind: null },
      { profileId: 'known-disallowed', status: 'connected', kind: 'oauth' },
    ] }, connectedAccounts: [{ service: ctx.service, credentialKinds: ['token'] }] });
    expect(inventory[key].map(account => account.status)).toEqual(['connected', 'connected', 'unsupported_kind']);
    expect(credentials.values.get('seatToken')).toBe('fake-seat-key');
    expect(credentials.values.get('credentialMode')).toBe('enterprise');
    expect(credentials.values.has('sessionToken')).toBe(false);
    const read = { ...ctx, credentials, account: { service: ctx.service, accountId: 'fake-account' } } as Parameters<ConnectedAccountRuntime['status']>[0];
    const native = await owner.materialize({ kind: 'files', fileIds: ['devin/credentials.toml'] }, read);
    if (native.kind !== 'files') throw new Error('Expected selected native credentials');
    expect(new TextDecoder().decode(native.files['devin/credentials.toml'])).toContain('fake-seat-key');
    expect(await owner.refresh({ ...read, stagedCredentials: store(), operation: { operationId: 'fake-op', configurationRevision: '1' } })).toMatchObject({ status: 'unavailable', credentialKind: 'token' });
    await expect(owner.materialize({ kind: 'httpHeaders', origin: 'https://server.codeium.com', headerNames: ['authorization'] }, read)).rejects.toMatchObject({ code: 'unsupported' });
    expect(requests).toHaveLength(0);
  });
  it('rejects a session token pasted into enterprise mode before any writes', async () => {
    const owner = await runtime();
    const mode = owner.authentication.modes['enterprise-seat'];
    if (mode?.kind !== 'manual') throw new Error('Missing enterprise mode');
    const { ctx, credentials } = context();
    expect(await mode.complete({ fields: { seatToken: 'devin-session-token$fake', apiServerUrl: 'https://enterprise.example.test' } }, ctx)).toMatchObject({ status: 'rejected' });
    expect(credentials.values.size).toBe(0);
  });
  it('does not infer an opaque enterprise key kind from an incidental prefix', async () => {
    const owner = await runtime();
    const mode = owner.authentication.modes['enterprise-seat'];
    if (mode?.kind !== 'manual') throw new Error('Missing enterprise mode');
    const { ctx, credentials } = context();
    expect(await mode.complete({ fields: { seatToken: 'eyJ-fake-seat-key', apiServerUrl: 'https://enterprise.example.test' } }, ctx)).toMatchObject({ status: 'connected', credentialKind: 'token' });
    expect(credentials.values.get('seatToken')).toBe('eyJ-fake-seat-key');
  });
});
