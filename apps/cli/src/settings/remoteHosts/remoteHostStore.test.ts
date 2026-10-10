import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { RemoteHostRecordV1Schema, RemoteHostCatalogRowMutationV1Schema } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliRemoteHostStoreForOperation } from './remoteHostStore';
import { createCliRemoteHostActionExecuteV1 } from '@/session/actions/cliActionDeps/createCliRemoteHostActionDeps';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { SavedSecretResourceMaterialV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { AccountSettingsV2HistoryMutationRequestSchema, AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

it.each(['matching', 'rotated'] as const)('cleans signed SSH history through the issued CLI catalog only for exact historical material (%s)', async state => {
  const accountId = 'ssh-history-account';
  const value = '  historical SSH private fixture\n';
  const source = { kind: 'remote-host-ssh-credential' as const, hostId: 'history-host', slot: 'password' as const };
  const resourceId = deriveSavedSecretImportResourceIdV1({ accountId, source });
  const ref = formatSharedSavedSecretRefV1(resourceId);
  const host = RemoteHostRecordV1Schema.parse({ id: source.hostId, name: 'Host', createdAt: 1, updatedAt: 1,
    lastUsedAt: null, ssh: { target: 'dev@example.test', authMode: 'password', passwordSecretRef: ref } });
  const currentValue = state === 'matching' ? value : 'rotated-private-fixture';
  let settingsVersion = 7;
  let sourceRaw: Readonly<Record<string, unknown>> = { remoteHostsV1: [{ ...host,
    ssh: { target: host.ssh.target, authMode: 'password', passwordEnc: { _isSecretValue: true, value: currentValue } } }], preferredLanguage: 'en' };
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
  const context = await runWithServerHttpBaseUrl('https://captured-home.test', () => createInvocationSavedSecretOperationContextV1({
    credentials, serverHttpBaseUrl: 'https://captured-home.test', isCurrent: async () => true,
    snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
  }));
  let recorded: AccountSettingsStoredContentEnvelope = { t: 'plain', v: { remoteHostsV1: [{ ...host,
    ssh: { target: host.ssh.target, authMode: 'password', passwordEnc: { _isSecretValue: true, value } } }], preferredLanguage: 'de' } };
  const resource = SavedSecretResourceMaterialV1Schema.parse({ resourceId, encryptionMode: 'plain', recipientEnvelope: null,
    storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: currentValue } },
    entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'SSH password', kind: 'password',
      encryptionMode: 'plain', ownerAccountId: accountId, revision: 3, materialStatus: 'ready',
      capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } });
  // Captured Home HTTP is the sole substituted boundary; catalog admission, materialization and History stay real.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    expect(new URL(String(input)).origin).toBe('https://captured-home.test');
    return Response.json(FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} }));
  }));
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://captured-home.test');
    const path = url.pathname;
    if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
      settingsVersion, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/profiles/transfer')) return { status: 200, data: { status: 'absent' } };
    if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [resource] } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: settingsVersion, content: { t: 'plain', v: sourceRaw } } };
    if (path.endsWith('/entity-rows/remote-hosts')) return { status: 200, data: { status: 'present', revision: 2,
      content: { t: 'plain', v: { v: 1, hosts: [host] } } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{ version: 4,
      createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: JSON.stringify(recorded).length }] } };
    if (path === '/v2/account/settings/history/4') return { status: 200, data: { version: 4,
      createdAt: '2026-01-01T00:00:00.000Z', content: recorded } };
    return { status: 404, data: {} };
  });
  const mutations: ReturnType<typeof AccountSettingsV2HistoryMutationRequestSchema.parse>[] = [];
  const hostWrites: ReturnType<typeof RemoteHostCatalogRowMutationV1Schema.parse>[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
    if (String(input) === 'https://captured-home.test/v1/account/entity-rows/remote-hosts') {
      const mutation = RemoteHostCatalogRowMutationV1Schema.parse(body && typeof body === 'object' && 'mutation' in body ? body.mutation : null);
      hostWrites.push(mutation);
      return { status: 200, data: { status: 'updated', revision: 3, cursor: 1 } };
    }
    if (String(input) === 'https://captured-home.test/v2/account/settings') {
      const mutation = AccountSettingsV2UpdateRequestSchema.parse(body);
      expect(mutation.expectedVersion).toBe(7);
      expect(mutation.content).toEqual({ t: 'plain', v: { preferredLanguage: 'en' } });
      if (mutation.content?.t !== 'plain') throw new Error('Expected Plain source cleanup');
      sourceRaw = mutation.content.v; settingsVersion = 8;
      return { status: 200, data: { success: true, version: settingsVersion } };
    }
    expect(String(input)).toBe('https://captured-home.test/v2/account/settings/history/4/mutate');
    const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse(body);
    expect(mutation.expectedSettingsVersion).toBe(8);
    if (mutation.operation.kind !== 'normalize') throw new Error('Expected History normalization');
    mutations.push(mutation); recorded = mutation.operation.content!;
    return { status: 200, data: { status: 'applied' } };
  });
  const store = createCliRemoteHostStoreForOperation({ operationContext: context });
  const result = await store.readCatalog();
  expect(sourceRaw).toEqual({ preferredLanguage: 'en' });
  expect(result).toMatchObject({ status: 'ready', revision: 2 });
  expect(result.status === 'ready' ? result.cleanup : null).toBe(state === 'matching' ? undefined : 'pending');
  expect(mutations).toHaveLength(state === 'matching' ? 1 : 0);
  if (state === 'matching') {
    expect(mutations[0]!.operation).toMatchObject({ savedSecretTransfers: [{ source, resourceId, expectedRevision: 3 }] });
    expect(recorded).toEqual({ t: 'plain', v: { preferredLanguage: 'de' } });
  } else {
    expect(recorded.t === 'plain' && recorded.v.remoteHostsV1).toBeTruthy();
    expect(await store.saveHost({ host: { ...host, name: 'Edited while history is pending' }, expectedRevision: 2 }))
      .toEqual({ status: 'updated', hostId: host.id, revision: 3 });
    expect(hostWrites[0]).toMatchObject({ expectedRevision: 2, referencedSavedSecretRevisions: [{ resourceId, revision: 3 }] });
    expect(await store.saveHost({ host, expectedRevision: 1 })).toEqual({ status: 'conflict', revision: 2 });
    expect(await store.saveHost({ host: { ...host, ssh: { ...host.ssh, passwordSecretRef: ref + '-missing' } }, expectedRevision: 2 }))
      .toMatchObject({ status: 'unavailable' });
    expect(await store.removeHost({ hostId: host.id, expectedRevision: 2 })).toEqual({ status: 'updated', hostId: host.id, revision: 3 });
    expect(hostWrites).toHaveLength(2);
    expect(hostWrites[1]).toMatchObject({ expectedRevision: 2, referencedSavedSecretRevisions: [], content: { t: 'plain', v: { v: 1, hosts: [] } } });
    expect(mutations).toEqual([]);
    expect(recorded.t === 'plain' && recorded.v.remoteHostsV1).toBeTruthy();
    expect(await store.readCatalog()).toMatchObject({ status: 'ready', cleanup: 'pending' });
  }
});

it('reads and updates only the issued Home while preserving neighboring hosts and exact catalog CAS', async () => {
  const credentials = { token: 'captured-remote-hosts', encryption: null };
  const host = RemoteHostRecordV1Schema.parse({ id: 'Host/A', name: 'Development', createdAt: 1, updatedAt: 2,
    lastUsedAt: null, ssh: { target: 'user@private.example', authMode: 'agent' } });
  const neighbor = { ...host, id: 'neighbor', name: 'Neighbor' };
  let delayHistory = false;
  let releaseHistory!: () => void;
  const historyReady = new Promise<void>(resolve => { releaseHistory = resolve; });
  const context = await runWithServerHttpBaseUrl('https://captured-home.test', () => createInvocationSavedSecretOperationContextV1({
    credentials, serverHttpBaseUrl: 'https://captured-home.test', isCurrent: async () => true,
    snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
  }));
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 20,
    loadedAtMs: 2, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey({ token: 'ambient-other-account', encryption: null }) });
  // HTTP is the only substituted boundary; source loading, Account custody and sealing stay real.
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://captured-home.test');
    if (url.pathname.endsWith('/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.pathname.endsWith('/profiles/transfer')) return { status: 200, data: { status: 'absent' } };
    if (url.pathname === '/v2/account/settings/history') {
      if (delayHistory) await historyReady;
      return { status: 200, data: { snapshots: [] } };
    }
    if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
    if (url.pathname.endsWith('/entity-rows/remote-hosts')) return { status: 200, data: {
      status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, hosts: [host, neighbor] } } } };
    return { status: 404, data: {} };
  });
  const writes: unknown[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
    expect(new URL(String(input)).origin).toBe('https://captured-home.test');
    const packet = body && typeof body === 'object' && 'mutation' in body ? body.mutation : null;
    const mutation = RemoteHostCatalogRowMutationV1Schema.parse(packet);
    writes.push(mutation);
    expect(mutation.expectedRevision).toBe(4);
    expect(mutation.content).toEqual({ t: 'plain', v: { v: 1, hosts: [{ ...host, name: 'Renamed' }, neighbor] } });
    return { status: 200, data: { status: 'updated', revision: 5, cursor: 5 } };
  });
  const store = createCliRemoteHostStoreForOperation({ operationContext: context });
  expect(await store.readCatalog()).toMatchObject({ status: 'ready', revision: 4, hosts: [host, neighbor] });
  expect(await store.saveHost({ host: { ...host, name: 'Renamed' }, expectedRevision: 3 })).toEqual({ status: 'conflict', revision: 4 });
  expect(writes).toEqual([]);
  delayHistory = true;
  const execute = createCliRemoteHostActionExecuteV1({ credentials, serverId: 'issued-home',
    serverHttpBaseUrl: 'https://captured-home.test', operationContext: context });
  let listed: Awaited<ReturnType<typeof execute>> | undefined;
  const listing = execute({ actionId: 'remote_hosts.list', input: {} }, {}).then(result => { listed = result; });
  let saving: ReturnType<typeof store.saveHost> | undefined;
  try {
    await vi.waitFor(() => { expect(listed).toMatchObject({ ok: true, result: {
      status: 'listed', hosts: [host, neighbor], revision: 4, complete: true,
    } }); });
    saving = store.saveHost({ host: { ...host, name: 'Renamed' }, expectedRevision: 4 });
    await vi.waitFor(() => { expect(writes).toHaveLength(1); });
    expect(await saving).toEqual({ status: 'updated', hostId: host.id, revision: 5 });
  } finally { releaseHistory(); await listing; await saving; }
  expect(writes).toHaveLength(1);
});

it('does not replay a dispatched mutation after its response is lost', async () => {
  const credentials = { token: 'captured-unknown-remote-hosts', encryption: null };
  const host = RemoteHostRecordV1Schema.parse({ id: 'host', name: 'Development', createdAt: 1, updatedAt: 2,
    lastUsedAt: null, ssh: { target: 'user@private.example', authMode: 'agent' } });
  const context = await runWithServerHttpBaseUrl('https://captured-home.test', () => createInvocationSavedSecretOperationContextV1({
    credentials, serverHttpBaseUrl: 'https://captured-home.test', isCurrent: async () => true,
    snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
  }));
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
      settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/profiles/transfer')) return { status: 200, data: { status: 'absent' } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
    if (path.endsWith('/entity-rows/remote-hosts')) return { status: 200, data: { status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, hosts: [host] } } } };
    return { status: 404, data: {} };
  });
  let writes = 0;
  vi.spyOn(axios, 'post').mockImplementation(async () => { writes++; throw new Error('connection lost after dispatch'); });
  const store = createCliRemoteHostStoreForOperation({ operationContext: context });
  expect(await store.removeHost({ hostId: host.id, expectedRevision: 4 })).toEqual({ status: 'outcome_unknown' });
  expect(writes).toBe(1);
});
