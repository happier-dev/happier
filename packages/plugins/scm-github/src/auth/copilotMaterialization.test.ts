import { describe, expect, it } from 'vitest';
import type { ConnectedAccountPortableReadContext, ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { githubAccountCredentialRuntime, materializeGithubCredential } from './credentialMaterialization.js';
import { githubConnectedAccountRuntime } from './connectedAccountRuntime.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { activate as activateAccount } from '../accountRuntime.js';
import { derivePluginAccountContributionRegistrationRights } from '../../../../protocol/src/plugins/contributions/catalog.js';
import { createPluginRegistrationScope } from '../../../../plugin-sdk/src/registration/scope.js';

// Credential storage and HTTP are external boundaries; the real runtime stays composed.
function context(token: string) {
  return { credentials: { get: async () => token } } as unknown as ConnectedAccountPortableReadContext;
}

describe('GitHub native Copilot material', () => {
  it('starts device authorization in the Account realm with typed missing configuration', async () => {
    const target = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.[0]?.authentication.account;
    if (!target) throw new Error('GitHub Account artifact missing');
    const scope = createPluginRegistrationScope({ pluginId: PLUGIN_MANIFEST.id, target: { realm: 'account', ...target },
      rights: derivePluginAccountContributionRegistrationRights(PLUGIN_MANIFEST.contributes, target) });
    const dispose = activateAccount(scope.api);
    try {
      const registration = scope.commit().find(entry => entry.family === 'connectedAccountDescriptors');
      if (registration?.family !== 'connectedAccountDescriptors') throw new Error('Account runtime missing');
      const mode = registration.value.authentication.modes['copilot-device'];
      if (!mode || mode.kind !== 'oauthDeviceCode') throw new Error('Account device mode missing');
      expect(await mode.begin({ signal: new AbortController().signal, configuration: { getPublicOAuthClient: async () => null } } as unknown as Parameters<typeof mode.begin>[0]))
        .toMatchObject({ status: 'unavailable', diagnostic: { code: 'github_copilot_client_unavailable' } });
    } finally { dispose(); }
  });
  it('reports an issued OAuth token lifetime through account health', async () => {
    const values = new Map([['token', 'gho_fixture'], ['credentialKind', 'oauth'], ['expiresAtMs', '1950000000000']]);
    const result = await githubConnectedAccountRuntime.status({
      signal: new AbortController().signal,
      credentials: { get: async (key: string) => values.get(key) ?? null },
      services: { http: { request: async () => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ id: 985, login: 'fixture-device-user' })) }) } },
    } as unknown as Parameters<typeof githubConnectedAccountRuntime.status>[0]);
    expect(result).toMatchObject({ status: 'connected', credentialKind: 'oauth', expiresAt: 1950000000000 });
  });
  it.each(['github_pat_fixture', 'gho_fixture', 'ghu_fixture'])('delivers compatible %s without an entitlement request', async token => {
    await expect(materializeGithubCredential({ kind: 'environment', keys: ['COPILOT_GITHUB_TOKEN'] }, context(token)))
      .resolves.toEqual({ kind: 'environment', env: { COPILOT_GITHUB_TOKEN: token } });
  });
  it.each(['ghp_fixture', 'unknown-fixture'])('refuses incompatible native token while retaining SCM use: %s', async token => {
    await expect(materializeGithubCredential({ kind: 'environment', keys: ['COPILOT_GITHUB_TOKEN'] }, context(token)))
      .rejects.toMatchObject({ code: 'github_copilot_token_unsupported' });
    await expect(materializeGithubCredential({ kind: 'httpHeaders', origin: 'https://api.github.com', headerNames: ['authorization'] }, context(token)))
      .resolves.toEqual({ kind: 'httpHeaders', headers: { Authorization: `Bearer ${token}` } });
  });
  it('never exports native tokens to an undeclared variable', async () => {
    await expect(materializeGithubCredential({ kind: 'environment', keys: ['GITHUB_TOKEN'] }, context('github_pat_fixture')))
      .rejects.toThrow();
  });
  it.each([
    { name: 'native Copilot', runtime: githubConnectedAccountRuntime, modeId: 'copilot-token' },
    { name: 'native PAT', runtime: githubConnectedAccountRuntime, modeId: 'fine-grained-pat' },
    { name: 'Account Copilot', runtime: githubAccountCredentialRuntime, modeId: 'copilot-token' },
  ] satisfies readonly { name: string; runtime: ConnectedAccountPortableRuntime; modeId: string }[])('connects $name through identity alone and reports its token kind', async ({ runtime: source, modeId }) => {
    const runtime: ConnectedAccountPortableRuntime = source;
    const mode = runtime.authentication.modes[modeId];
    expect(mode?.kind).toBe('manual');
    if (!mode || mode.kind !== 'manual') throw new Error('Copilot manual mode missing');
    const staged = new Map<string, string>();
    const requests: string[] = [];
    const result = await mode.complete({ fields: { token: 'gho_fixture' } }, {
      signal: new AbortController().signal,
      attemptCredentials: { get: async (key: string) => staged.get(key) ?? null, set: async (key: string, value: string) => { staged.set(key, value); }, delete: async (key: string) => { staged.delete(key); } },
      services: { http: { request: async (input: { url: string }) => {
        requests.push(input.url);
        return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ id: 984, login: 'fixture-user' })) };
      } } },
    } as unknown as Parameters<typeof mode.complete>[1]);
    expect(result).toMatchObject({ status: 'connected', credentialKind: 'token', providerIdentity: { accountId: '984' } });
    expect(staged.get('token')).toBe('gho_fixture');
    expect(requests).toEqual(['https://api.github.com/user']);
  });
});
