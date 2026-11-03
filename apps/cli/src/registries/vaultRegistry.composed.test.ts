import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { accountSettingsParse, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import type { RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import axios from '@/api/client/credentialAxios';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createCliRegistryHostV1 } from './createCliRegistryHost';
import { createSecretSourceHostFixture } from '@/plugins/testkit/secretSources';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('acquires one vault token for multiple registry HTTP reads and acquires rotated material on the next fetch', async () => {
  const home = 'https://vault-registry-home.example.test';
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'registry-owner' })).toString('base64url')}.signature`, encryption: null };
  const reference = 'happier:shared-secret:v1:registry-token';
  const locator = { kind: 'external' as const, contribution: { pluginId: 'com.acme.vault', localId: 'tokens' },
    account: 'vault-account', reference: 'op://vault/registry/token' };
  const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId: 'registry-token', mode: 'plain',
    content: { v: 2, name: 'Registry token', kind: 'token', source: locator } });
  const resource = { resourceId: 'registry-token', ownerAccountId: 'registry-owner', relationship: 'owner' as const,
    displayName: 'Registry token', kind: 'token' as const, encryptionMode: 'plain' as const, revision: 1,
    materialStatus: 'ready' as const, storedContent };
  let token = 'initial-token';
  const acquisitions: string[] = [];
  const secretSource = await createSecretSourceHostFixture({
    pluginId: locator.contribution.pluginId, localId: locator.contribution.localId,
    runtime: { async acquire(source) { acquisitions.push(source.reference); return { ok: true, value: token }; } },
  });
  onTestFinished(() => secretSource.dispose());
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: home,
    snapshot: { source: 'network', scopeKey: runWithServerHttpBaseUrl(home, () => resolveAccountSettingsScopeKey(credentials)),
      settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      savedSecretResources: [resource], savedSecretCatalogState: 'ready' },
    isCurrent: async () => true,
    // Executable source boundary; the real admission, materializer and registry adapters run.
    secretSources: secretSource.host,
  });
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    expect(new URL(String(input)).pathname).toBe('/v1/account/saved-secrets/resources/materials');
    return { status: 200, data: { resources: [{ resourceId: resource.resourceId, encryptionMode: resource.encryptionMode,
      storedContent, recipientEnvelope: null, entry: { ref: reference, source: 'shared_resource', relationship: 'owner',
        name: resource.displayName, kind: resource.kind, ownerAccountId: resource.ownerAccountId, revision: 1,
        materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] } };
  });
  const observedTokens: string[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => {
    const target = new URL(String(url));
    if (target.origin === home) return Response.json({ features: {}, capabilities: {} });
    observedTokens.push(new Headers(options?.headers).get('authorization') ?? '');
    return Response.json(target.pathname.includes('/commits/') ? { sha: '1'.repeat(40) } : { sha: 'tree', tree: [
      { path: 'SKILL.md', type: 'blob', mode: '100644', sha: 'blob', size: 1 },
    ] });
  }));
  const source: RegistrySourceDescriptorV1 = { id: 'vault-registry', title: 'Vault registry', format: 'git', kinds: ['skill'],
    url: 'https://github.com/acme/skills', token: { secretRef: reference }, enabled: true, addedAt: 1,
    origin: { kind: 'user' }, removable: true };
  const host = createCliRegistryHostV1({ operationContext, readSources: async () => [source] });
  const read = () => host.fetchRequest({ op: 'list', kind: 'skill', sourceId: source.id });
  await expect(read()).resolves.toMatchObject({ op: 'list', page: { status: { state: 'ok' }, total: 1 } });
  token = 'rotated-token';
  await expect(read()).resolves.toMatchObject({ op: 'list', page: { status: { state: 'ok' }, total: 1 } });
  expect(acquisitions).toEqual([locator.reference, locator.reference]);
  expect(observedTokens).toEqual(['Bearer initial-token', 'Bearer initial-token', 'Bearer rotated-token', 'Bearer rotated-token']);
});
