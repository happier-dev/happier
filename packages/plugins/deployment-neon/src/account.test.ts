import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountCredentialStore, ConnectedAccountPortableRuntime, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import * as entry from './index.js';

it.each(['daemon', 'account'] as const)('verifies the exact organization and materializes only management authorization through %s activation', async target => {
  let accountRuntime: ConnectedAccountPortableRuntime | undefined;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: { ...entry,
    activateAccount(api, account) {
      return entry.activateAccount({ ...api, connectedAccounts: { register(localId, runtime) {
        if (localId === 'neon') accountRuntime = runtime;
        return api.connectedAccounts.register(localId, runtime);
      } } }, account);
    },
  } });
  try {
    const runtime = target === 'account' ? accountRuntime : kit.registration('connectedAccountDescriptors', 'neon');
    expect(runtime).toBeDefined();
    if (!runtime) throw new Error('Missing Neon account runtime');
    const token = 'constructed-neon-private-token';
    const stored = new Map<string, string>();
    const credentials: ConnectedAccountCredentialStore = {
      async get(id) { return stored.get(id) ?? null; }, async set(id, value) { stored.set(id, value); }, async delete(id) { stored.delete(id); },
    };
    let wrongOrganization = true;
    const urls: string[] = [];
    const http = createPluginHttpFixture({ async request(request) {
      urls.push(request.url);
      expect(request.headers).toEqual({ authorization: `Bearer ${token}` });
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
        id: wrongOrganization ? 'foreign-org' : 'org-example', name: 'Example', plan: 'launch', handle: 'example', managed_by: 'console',
        created_at: '2026-10-30T00:00:00Z', updated_at: '2026-10-30T00:00:00Z',
      })) };
    } });
    // The genuine transport and credential persistence boundaries alone are replaced.
    const services = new Proxy({} as ConnectedAccountReadContext['services'], {
      get(_target, key) { if (key === 'http') return http; throw new Error('Unexpected host service'); },
    });
    const service = { pluginId: entry.manifest.id, localId: 'neon' };
    const common = { plugin: { id: entry.manifest.id, version: entry.manifest.version },
      contribution: { id: 'neon', qualifiedId: `${entry.manifest.id}/neon` }, surface: 'background' as const,
      invokedAtMs: 1, services, signal: new AbortController().signal };
    const configuration = { target: { kind: 'attempt' as const, attemptId: 'attempt', service, modeId: 'token' },
      values: { organizationId: 'org-example' }, revision: '1', async getSecret() { return null; } };
    const authentication = { ...common, service, attempt: { kind: 'connect' as const, attemptId: 'attempt' },
      configuration, attemptCredentials: credentials } satisfies ConnectedAccountAuthenticationContext;
    const mode = runtime.authentication.modes.token;
    if (mode?.kind !== 'manual') throw new Error('Missing manual token mode');
    expect(await mode.complete({ fields: { token } }, authentication)).toMatchObject({ status: 'rejected' });
    expect(stored.size).toBe(0);
    wrongOrganization = false;
    expect(await mode.complete({ fields: { token } }, authentication)).toMatchObject({ status: 'connected',
      providerIdentity: { organizationId: 'org-example' } });
    expect(stored.get('token')).toBe(token);
    expect(urls).toEqual(Array(2).fill('https://console.neon.tech/api/v2/organizations/org-example'));
    const account = { service, accountId: 'connected-neon' };
    const read = { ...common, account, credentials, configuration: { ...configuration,
      target: { kind: 'account' as const, account, modeId: 'token' } } } satisfies ConnectedAccountReadContext;
    if (!runtime.materialize) throw new Error('Missing Neon materialization runtime');
    expect(await runtime.materialize({ kind: 'httpHeaders', origin: 'https://console.neon.tech', headerNames: ['authorization'] }, read))
      .toEqual({ kind: 'httpHeaders', headers: { authorization: `Bearer ${token}` } });
    await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://foreign.example', headerNames: ['authorization'] }, read))
      .rejects.toMatchObject({ code: 'credential_unavailable' });
    if (target === 'daemon') {
      const native = kit.registration('connectedAccountDescriptors', 'neon');
      if (!native) throw new Error('Missing native Neon account runtime');
      expect(await native.revoke(read))
        .toMatchObject({ status: 'remoteUnsupported' });
    }
    expect(stored.get('token')).toBe(token);
  } finally { await kit.dispose(); }
});
