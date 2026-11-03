import { createServer } from 'node:http';
import { accountSettingsParse } from '@happier-dev/protocol';
import { SharedSavedSecretCreateInputV1Schema, SharedSavedSecretUpdateInputV1Schema, SharedSavedSecretDeleteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { sealSavedSecretResourceStoredContentV1, openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { ProfileRowsListResponseV1Schema, ProfileReferenceGuardReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { setActiveAccountSettingsSnapshot, clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import type { ActionCliExecutionDeps } from '../executeCommand';

/** Network/persistence fixture: all CLI composition, policy, custody and codecs stay real. */
export async function createSavedSecretsCliHttpFixture(options: Readonly<{ loseCreateResponse?: boolean; refuseCreate?: boolean; shared?: boolean; serverIdentityId?: string }> = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const credentials: StoredCredentials = { token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: 'account-cli-fixture',
    session: 'fixture', tokenEpoch: 7, provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`,
    encryption: null, credentialProvenance: 'stored_session' };
  const rawSettings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
    'secrets.create': ['cli'], 'secrets.update': ['cli'], 'secrets.delete': ['cli'], 'secrets.shared.list': ['cli'],
    'registries.sources.create': ['cli'], 'registries.sources.token.set': ['cli'],
  } } };
  const resources = new Map<string, { resourceId: string; displayName: string; kind: 'apiKey' | 'token' | 'password' | 'other';
    encryptionMode: 'plain' | 'e2ee'; revision: number; storedContent: ReturnType<typeof sealSavedSecretResourceStoredContentV1> }>();
  resources.set('resource-id', { resourceId: 'resource-id', displayName: 'Acme', kind: 'token', encryptionMode: 'plain', revision: 37,
    storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'resource-id', mode: 'plain',
      content: { v: 1, name: 'Acme', kind: 'token', value: 'incumbent-value' } }) });
  const writes: Readonly<Record<string, unknown>>[] = [];
  const registryWrites: Readonly<Record<string, unknown>>[] = [];
  const records = new Map(PromptLibraryCatalogKeyV1Schema.options.map(key => [key, emptyPromptLibraryRecordV1(key)]));
  records.set('registry-sources', { key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{
    id: 'catalog-id', title: 'Acme catalog', format: 'happier-catalog', kinds: ['plugin'], url: 'https://catalog.example/catalog.json',
    enabled: true, addedAt: 1, npmRegistryProfileId: 'old-profile',
  }] } });
  const entry = (resource: (typeof resources extends Map<string, infer R> ? R : never)) => SavedSecretCatalogEntryV1Schema.parse({
    ref: formatSharedSavedSecretRefV1(resource.resourceId), source: 'shared_resource', relationship: 'owner', ownerAccountId: 'account-cli-fixture',
    name: resource.displayName, kind: resource.kind, revision: resource.revision, materialStatus: 'ready',
    audience: { accounts: [], teams: options.shared ? [{ kind: 'team', teamId: 'team-a', name: 'Team' }] : [], groups: [] },
    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
  });
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    let bytes = ''; for await (const chunk of request) bytes += chunk;
    const url = new URL(request.url ?? '/', 'http://fixture');
    const send = (value: unknown) => response.end(JSON.stringify(value));
    try {
      if (request.method === 'HEAD' && url.pathname === '/') return response.end();
      if (url.pathname === '/v1/account/encryption') return send({ mode: 'plain', updatedAt: 1 });
      if (url.pathname === '/v1/account/encryption/currentness') return send({ mode: 'plain', version: 1, settingsVersion: 7,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (url.pathname.startsWith('/v1/features')) return send({ features: { teams: { enabled: true } }, capabilities: { serverIdentity: { serverIdentityId: options.serverIdentityId ?? 'srv_fixture' } } });
      if (url.pathname === '/v2/account/settings') return send({ content: { t: 'plain', v: rawSettings }, version: 7 });
      if (url.pathname === '/v1/account/saved-secrets/resources/materials') return send({ resources: [...resources.values()].map(resource => ({
        resourceId: resource.resourceId, encryptionMode: resource.encryptionMode, storedContent: resource.storedContent,
        recipientEnvelope: null, entry: entry(resource),
      })) });
      if (url.pathname === '/v1/account/saved-secrets/resources' && request.method === 'GET') return send({ resources: [...resources.values()].map(entry) });
      if (url.pathname === '/v1/account/saved-secrets/resources' && request.method === 'POST') {
        const input = SharedSavedSecretCreateInputV1Schema.parse(JSON.parse(bytes));
        if (options.refuseCreate) { response.statusCode = 409; return send({ error: 'resource_changed' }); }
        resources.set(input.resourceId, { ...input, revision: 1 });
        writes.push(input);
        if (options.loseCreateResponse) { response.destroy(); return; }
        return send({ resourceId: input.resourceId, revision: 1 });
      }
      if (url.pathname === '/v1/account/saved-secrets/resources/update' && request.method === 'POST') {
        const input = SharedSavedSecretUpdateInputV1Schema.parse(JSON.parse(bytes));
        const resource = resources.get(input.resourceId);
        if (!resource || resource.revision !== input.expectedRevision) { response.statusCode = 409; return send({ error: 'resource_changed' }); }
        Object.assign(resource, input, { revision: resource.revision + 1 });
        writes.push(input);
        return send({ resourceId: input.resourceId, revision: resource.revision });
      }
      if (url.pathname === '/v1/account/saved-secrets/resources/delete' && request.method === 'POST') {
        const input = SharedSavedSecretDeleteInputV1Schema.parse(JSON.parse(bytes));
        writes.push(input); resources.delete(input.resourceId); return send({ resourceId: input.resourceId });
      }
      if (url.pathname === '/v1/account/entity-rows/prompt-library') return send({ status: 'listed', rows: [...records].map(([key, record]) => ({
        key, revision: 3, content: { t: 'plain', v: record },
      })) });
      if (url.pathname.startsWith('/v1/account/entity-rows/prompt-library/')) {
        const key = PromptLibraryCatalogKeyV1Schema.parse(url.pathname.split('/').at(-1));
        if (request.method === 'GET') return send({ status: 'present', revision: 3, content: { t: 'plain', v: records.get(key) } });
        const mutation = PromptLibraryRowMutationV1Schema.parse(JSON.parse(bytes));
        if (mutation.content?.t !== 'plain') throw new Error('Fixture requires a plain Account');
        records.set(key, mutation.content.v); registryWrites.push(mutation.content.v);
        return send({ status: 'updated', revision: 4, cursor: 4 });
      }
      if (url.pathname === '/v1/account/entity-rows/profiles') return send(ProfileRowsListResponseV1Schema.parse({ status: 'listed', rows: [],
        nextCursor: null, complete: true, referenceGuardRevision: 0, transferControl: { status: 'absent' }, diagnostics: [] }));
      if (url.pathname.endsWith('/reference-guard')) return send(ProfileReferenceGuardReadResponseV1Schema.parse({ status: 'ready', revision: 0 }));
      if (url.pathname.startsWith('/v1/account/entity-rows/')) return send({ status: 'absent' });
      response.statusCode = 404; return send({ error: 'missing_fixture_endpoint' });
    } catch { response.statusCode = 500; return send({ error: 'invalid_fixture_request' }); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected a loopback listener');
  const origin = `http://127.0.0.1:${address.port}`;
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  const settings = accountSettingsParse(rawSettings);
  const snapshot = { source: 'network' as const, settings, rawSettings, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey };
  setActiveAccountSettingsSnapshot(snapshot);
  const operation = createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl: origin, isCurrent: async () => true });
  const deps: Partial<ActionCliExecutionDeps> = {
    readCredentialsFn: async () => credentials, readCredentialsForServerIdFn: async () => credentials,
    getServerProfileFn: async () => ({ id: 'home-fixture', name: 'Fixture', serverUrl: origin, webappUrl: origin,
      createdAt: 1, updatedAt: 1, lastUsedAt: 1 }),
    createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params, serverIdentityId: options.serverIdentityId ?? 'srv_fixture',
      actionsSettingsProvider: createActionSettingsProvider({ scopeKey, accountSettings: settings }), savedSecretOperationContext: operation }),
  };
  return { deps, writes, registryWrites, resources, origin,
    inHome: <T>(run: () => T) => runWithServerHttpBaseUrl(origin, run),
    opened: (input: Readonly<Record<string, unknown>>) => {
      const resource = resources.get(String(input.resourceId)); if (!resource) throw new Error('Missing fixture resource');
      if (resource.encryptionMode !== 'plain') throw new Error('Fixture requires plain Account content');
      return openSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode: resource.encryptionMode,
        storedContent: resource.storedContent });
    },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); clearActiveAccountSettingsSnapshot(); },
  };
}
