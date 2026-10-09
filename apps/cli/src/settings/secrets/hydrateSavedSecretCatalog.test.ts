import axios from 'axios';
import tweetnacl from 'tweetnacl';
import {
  AccountSettingsSchema,
  ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES,
  encryptSecretStringV1,
  FeaturesResponseSchema,
  formatSavedSecretCatalogReferenceV1,
  sealEncryptedDataKeyEnvelopeV1,
  sealSavedSecretResourceStoredContentV1,
  openEncryptedDataKeyEnvelopeV1,
  openSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createSavedSecretMaterializerFromSnapshotV1 } from './savedSecretCatalog';
import {
  createInvocationSavedSecretOperationContextV1,
  hydrateSavedSecretCatalog,
  refreshSavedSecretCatalogForOperation,
} from './hydrateSavedSecretCatalog';
import * as savedSecretOperationOwner from './hydrateSavedSecretCatalog';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { decodeBase64 } from '@/api/encryption';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';

vi.mock('axios', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

const persistenceMocks = vi.hoisted(() => ({
  readStoredCredentials: vi.fn(),
}));
const featureMocks = vi.hoisted(() => ({
  fetchServerFeaturesSnapshot: vi.fn(async () => ({
    status: 'ready' as const,
    features: {
      features: { teams: { enabled: true, credentialResources: { enabled: false, externalApi: { enabled: false } } } },
      capabilities: {},
    },
  })),
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: persistenceMocks.readStoredCredentials,
}));

vi.mock('@/features/serverFeaturesClient', () => featureMocks);

describe('Saved Secret catalog hydration', () => {
  const serverFeatures = (teamsEnabled: boolean, credentialResourcesEnabled = false) => FeaturesResponseSchema.parse({
    features: {
      teams: {
        enabled: teamsEnabled,
        credentialResources: { enabled: credentialResourcesEnabled },
      },
    },
    capabilities: {},
  });

  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    vi.mocked(axios.get).mockReset();
    vi.mocked(axios.post).mockReset();
    persistenceMocks.readStoredCredentials.mockReset();
    persistenceMocks.readStoredCredentials.mockResolvedValue(null);
    featureMocks.fetchServerFeaturesSnapshot.mockClear();
  });

  afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('publishes invocation Connected-account catalogs across preference refresh without changing Settings and retires late writes', async () => {
    const token = 'connected-invocation-token';
    const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
    const snapshot = { source: 'network' as const, settings: AccountSettingsSchema.parse({}), rawSettings: {},
      settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey };
    let current = true;
    const context = createInvocationSavedSecretOperationContextV1({ credentials: { token, encryption: null }, snapshot,
      serverHttpBaseUrl: 'https://connected-home.example', isCurrent: async () => current });
    const catalog = { status: 'ready' as const, revision: 7,
      record: { key: 'configurations' as const, value: { v: 1 as const, entries: [] } } };
    expect(await context.commitConnectedAccountCatalog({ key: 'configurations', catalog })).toBe(true);
    expect(context.readSnapshot()).toMatchObject({ settingsVersion: 4, connectedConfigurationCatalog: catalog });
    expect(await context.replaceAccountSettings({ ...snapshot, settingsVersion: 5 })).toBe(true);
    expect(context.readSnapshot()).toMatchObject({ settingsVersion: 5, connectedConfigurationCatalog: catalog });
    current = false;
    expect(await context.commitConnectedAccountCatalog({ key: 'configurations', catalog: { ...catalog, revision: 8 } })).toBe(false);
    expect(context.readSnapshot()).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'plain' as const, hasKey: false },
    { mode: 'e2ee' as const, hasKey: true },
    { mode: 'e2ee' as const, hasKey: false },
  ])('refreshes requester $mode material with hasKey=$hasKey without custodian credentials', async ({ mode, hasKey }) => {
    const aliceToken = 'alice-token';
    const bobToken = 'bob-token';
    const alice = { source: 'network' as const, settings: AccountSettingsSchema.parse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(aliceToken) };
    setActiveAccountSettingsSnapshot(alice);
    const activeAlice = getActiveAccountSettingsSnapshot();
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token: aliceToken, encryption: null });
    const machineKey = new Uint8Array(32).fill(7);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const resourceDataKey = new Uint8Array(32).fill(11);
    const resourceId = 'requester-resource';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const scopeKey = resolveAccountSettingsScopeKeyForToken(bobToken);
    const context = createInvocationSavedSecretOperationContextV1({
      credentials: { token: bobToken, encryption: hasKey ? { type: 'dataKey', machineKey, publicKey } : null },
      snapshot: { ...alice, settings: AccountSettingsSchema.parse({}), scopeKey }, serverHttpBaseUrl: 'https://bob-home.example', isCurrent: async () => true,
    });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [{
      resourceId, encryptionMode: mode,
      entry: { ref, source: 'shared_resource', relationship: 'recipient', name: 'Bob token', kind: 'token',
        ownerAccountId: 'bob', revision: 3, materialStatus: 'ready',
        capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
      storedContent: mode === 'plain'
        ? sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
          content: { v: 1, name: 'Bob token', kind: 'token', value: 'bob-private-material' } })
        : sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey,
          randomBytes: (length) => new Uint8Array(length).fill(12),
          content: { v: 1, name: 'Bob token', kind: 'token', value: 'bob-private-material' } }),
      recipientEnvelope: mode === 'plain' ? null : {
        encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceDataKey, recipientPublicKey: publicKey,
          randomBytes: (length) => new Uint8Array(length).fill(13) })).toString('base64'),
        recipientContentPublicKeyFingerprint: 'bob-content-fingerprint',
      },
    }] } });
    const refresh = refreshSavedSecretCatalogForOperation({ expectedScopeKey: scopeKey,
      references: [{ ref, revision: 3 }], operationContext: context });
    if (mode === 'e2ee' && !hasKey) {
      await expect(refresh).rejects.toMatchObject({ reason: 'reference_unavailable', reference: ref });
    } else {
      const refreshed = await refresh;
      expect(createSavedSecretMaterializerFromSnapshotV1(refreshed).resolve(ref)).toMatchObject({ status: 'ready', value: 'bob-private-material' });
      expect(context.readSnapshot()).toBe(refreshed);
      expect(await savedSecretOperationOwner.captureSavedSecretReferencesForOperation({ expectedScopeKey: scopeKey,
        references: [ref, ref], operationContext: context })).toEqual({
        referencedSavedSecretIds: [ref], savedSecretRevisions: [{ resourceId, expectedRevision: 3 }],
      });
    }
    expect(getActiveAccountSettingsSnapshot()).toBe(activeAlice);
    expect(persistenceMocks.readStoredCredentials).not.toHaveBeenCalled();
    expect(vi.mocked(axios.get).mock.calls[0]?.[0]).toBe('https://bob-home.example/v1/account/saved-secrets/resources/materials');
    expect(vi.mocked(axios.get).mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${bobToken}` });
  });

  it('keeps personal requester material local and withdraws captured readers after Settings replacement or retirement', async () => {
    const token = 'bob-token';
    const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
    let current = true;
    const snapshot = { source: 'network' as const, settings: AccountSettingsSchema.parse({ secrets: [{
      id: 'bob-secret', name: 'Bob', kind: 'token', createdAt: 1, updatedAt: 1,
      encryptedValue: { _isSecretValue: true, value: 'bob-personal' },
    }] }), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey };
    const context = createInvocationSavedSecretOperationContextV1({ credentials: { token, encryption: null }, snapshot,
      serverHttpBaseUrl: 'https://bob-home.example', isCurrent: async () => current });
    const admitted = await refreshSavedSecretCatalogForOperation({ expectedScopeKey: scopeKey,
      references: [{ ref: 'bob-secret' }], operationContext: context });
    const materializer = createSavedSecretMaterializerFromSnapshotV1(admitted, { isCurrent: () => context.readSnapshot() === admitted });
    expect(materializer.resolve('bob-secret')).toMatchObject({ status: 'ready', value: 'bob-personal' });
    expect(axios.get).not.toHaveBeenCalled();
    expect(persistenceMocks.readStoredCredentials).not.toHaveBeenCalled();
    expect(await context.replaceAccountSettings({ ...snapshot, scopeKey: 'another-account', settingsVersion: 2 })).toBe(false);
    expect(await context.replaceAccountSettings({ ...snapshot, settingsVersion: 2 })).toBe(true);
    expect(materializer.resolve('bob-secret')).toEqual({ status: 'temporarily_unavailable' });
    current = false;
    expect(await context.isCurrent()).toBe(false);
    expect(context.readSnapshot()).toBeNull();
    current = true;
    expect(await context.replaceAccountSettings({ ...snapshot, settingsVersion: 3 })).toBe(false);
  });

  it('retires requester material when admission changes during a catalog response', async () => {
    const token = 'bob-token';
    const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
    let current = true;
    const context = createInvocationSavedSecretOperationContextV1({ credentials: { token, encryption: null },
      snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey },
      serverHttpBaseUrl: 'https://bob-home.example', isCurrent: async () => current });
    vi.mocked(axios.get).mockImplementation(async () => { current = false; return { status: 200, data: { resources: [] } }; });
    await expect(refreshSavedSecretCatalogForOperation({ expectedScopeKey: scopeKey, refreshCatalog: true,
      operationContext: context })).rejects.toThrow('saved_secret_account_lifetime_changed');
    expect(context.readSnapshot()).toBeNull();
    expect(persistenceMocks.readStoredCredentials).not.toHaveBeenCalled();
  });

  it('prepares classified source material with the canonical Settings and resource envelopes in both Account modes', () => {
    const prepare = 'prepareProfileEnvironmentVariableSavedSecretPromotionForOperation' in savedSecretOperationOwner
      ? savedSecretOperationOwner.prepareProfileEnvironmentVariableSavedSecretPromotionForOperation : undefined;
    expect(typeof prepare).toBe('function');
    if (typeof prepare !== 'function') throw new Error('missing_saved_secret_classified_preparation');
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
    const rawSettings = { profiles: [{ id: 'p', name: 'Imported', environmentVariables: [
      { name: 'API_KEY', value: 'private-fixture', isSecret: true },
    ], createdAt: 1, updatedAt: 1 }], opaque: { retained: true } };
    const base = { accountId: 'account-a', rawSettings, expectedSettingsVersion: 4,
      source: { kind: 'profile-environment-variable' as const, profileId: 'p', envName: 'API_KEY' },
      displayName: 'Imported credential', kind: 'apiKey' as const, profileRows: [],
      profileCatalog: { status: 'ready' as const, source: 'legacy' as const, records: [], tombstones: [], diagnostics: [],
        referenceGuardRevision: 'absent' as const, authority: 'inactive' as const, control: null, controlRevision: 'absent' as const },
      randomBytes: (length: number) => new Uint8Array(length).fill(7) };
    const plain = prepare({ ...base, credentials: { token, encryption: null }, accountMode: 'plain',
      referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } } });
    expect(plain.encryptionMode).toBe('plain');
    expect(plain.nextSettings).toMatchObject({ t: 'plain', v: { opaque: rawSettings.opaque,
      secretBindingsByProfileId: { p: { API_KEY: formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: plain.resourceId }) } } } });
    expect(plain.storedContent).toMatchObject({ t: 'plain', v: { value: 'private-fixture' } });
    expect(plain.keyEnvelopes).toEqual([]);
    const secret = new Uint8Array(32).fill(4);
    const encrypted = prepare({ ...base, credentials: { token, encryption: { type: 'legacy', secret } }, accountMode: 'e2ee',
      referenceCensus: { accountMode: 'e2ee', profiles: { referenceGuardRevision: 'absent', rows: [] } } });
    expect(encrypted.resourceId).toBe(plain.resourceId);
    expect(encrypted.nextSettings?.t).toBe('encrypted');
    const envelope = encrypted.keyEnvelopes?.[0];
    expect(envelope?.recipientAccountId).toBe('account-a');
    if (!envelope) throw new Error('missing_owner_envelope');
    const resourceDataKey = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(envelope.encryptedDataKey),
      recipientSecretKeyOrSeed: deriveAccountMachineKeyFromRecoverySecret(secret) });
    if (!resourceDataKey) throw new Error('unreadable_owner_envelope');
    expect(openSavedSecretResourceStoredContentV1({ resourceId: encrypted.resourceId, mode: 'e2ee',
      storedContent: encrypted.storedContent, resourceDataKey })?.value).toBe('private-fixture');
    expect(() => prepare({ ...base, credentials: { token, encryption: null }, accountMode: 'e2ee',
      referenceCensus: { accountMode: 'e2ee', profiles: { referenceGuardRevision: 'absent', rows: [] } } })).toThrow();
    expect(() => prepare({ ...base, credentials: { token, encryption: null }, accountMode: 'plain', accountId: 'other-account',
      referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } } })).toThrow();
  });

  it('seals an exact staged classified carrier in the same prepared composite with its captured row revision', () => {
    const prepare = savedSecretOperationOwner.prepareProfileEnvironmentVariableSavedSecretPromotionForOperation;
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
    const profile = { id: 'p', name: 'Imported', environmentVariables: [
      { name: 'API_KEY', value: 'private-fixture', isSecret: true },
    ], createdAt: 1, updatedAt: 1 };
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'p', definition: { kind: 'legacy', profile },
      enabled: false, promptStack: [], secretBindings: { OTHER: 'unrelated-personal' } });
    const captured = { status: 'ready' as const, source: 'legacy' as const, records: [{ record, revision: 6 }],
      tombstones: [], diagnostics: [], referenceGuardRevision: 3, authority: 'inactive' as const, control: null,
      controlRevision: 'absent' as const };
    const sourceInput = { credentials: { token, encryption: null }, accountId: 'account-a', accountMode: 'plain' as const,
      rawSettings: { profiles: [profile] }, expectedSettingsVersion: 4,
      source: { kind: 'profile-environment-variable' as const, profileId: 'p', envName: 'API_KEY' },
      displayName: 'Imported credential', kind: 'apiKey' as const, profileRows: captured.records, profileCatalog: captured,
      referenceCensus: { accountMode: 'plain' as const, profileTransferRevision: 'absent' as const,
        profiles: { referenceGuardRevision: 3, rows: [{ id: 'p', revision: 6 }] } } };
    const result = prepare(sourceInput);
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: result.resourceId });
    expect(result.profileMutations).toMatchObject([{ id: 'p', operation: 'import', expectedRevision: 6,
      content: { t: 'plain', v: { enabled: false, secretBindings: { OTHER: 'unrelated-personal', API_KEY: ref } } },
      referencedSavedSecretIds: ['unrelated-personal', ref], savedSecretRevisions: [{ resourceId: result.resourceId, expectedRevision: 1 }], artifactRevision: null }]);
    expect(record.secretBindings).toEqual({ OTHER: 'unrelated-personal' });
    const destinationInput = { ...sourceInput, profileCatalog: { ...captured, source: 'destination' as const } };
    expect(() => prepare(destinationInput)).toThrow();
  });

  it('commits one fully prepared source CAS and row census, preserving outcome uncertainty without replay', async () => {
    const promote = 'promoteSavedSecretResourceForOperation' in savedSecretOperationOwner
      ? savedSecretOperationOwner.promoteSavedSecretResourceForOperation : undefined;
    expect(typeof promote).toBe('function');
    if (typeof promote !== 'function') throw new Error('missing_saved_secret_composite_transport');
    const token = 'account-token';
    const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}), settingsVersion: 4,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token, encryption: null });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [] } });
    const input = SharedSavedSecretPromoteInputV1Schema.parse({ resourceId: 'imported', displayName: 'Imported', kind: 'token',
      encryptionMode: 'plain', storedContent: { t: 'plain', v: { v: 1, name: 'Imported', kind: 'token', value: 'private-fixture' } },
      expectedSettingsVersion: 4, nextSettings: { t: 'plain', v: { opaque: { kept: true } } },
      referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 3, rows: [{ id: 'p', revision: 2 }] } },
      accountGrants: [], teamGrants: [], groupGrants: [], profileMutations: [] });
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 200, data: { resourceId: 'imported', settingsVersion: 5 } });
    await expect(promote({ expectedScopeKey: scopeKey, input })).resolves.toEqual({ status: 'applied', resourceId: 'imported', settingsVersion: 5 });
    expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toEqual(input);
    vi.mocked(axios.post).mockRejectedValueOnce(new Error('response-lost'));
    await expect(promote({ expectedScopeKey: scopeKey, input })).resolves.toMatchObject({ status: 'outcome_unknown' });
    expect(axios.post).toHaveBeenCalledTimes(2);
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 404, data: { error: 'not_found' } });
    await expect(promote({ expectedScopeKey: scopeKey, input })).resolves.toEqual({ status: 'unavailable' });
    expect(axios.post).toHaveBeenCalledTimes(3);
    resetActiveAccountSettingsSnapshotForTests();
    await expect(promote({ expectedScopeKey: scopeKey, input })).resolves.toEqual({ status: 'unavailable' });
    expect(axios.post).toHaveBeenCalledTimes(3);
  });

  it('dispatches the composite through its admitted invocation Home without reading or replacing the ambient Account', async () => {
    const token = 'invocation-token';
    const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}), settingsVersion: 8,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('ambient-token') });
    const ambient = getActiveAccountSettingsSnapshot();
    let current = true;
    const context = createInvocationSavedSecretOperationContextV1({ credentials: { token, encryption: null },
      snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), settingsVersion: 4,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey }, serverHttpBaseUrl: 'https://invocation-home.example',
      isCurrent: async () => current });
    const input = SharedSavedSecretPromoteInputV1Schema.parse({ resourceId: 'isolated-import', displayName: 'Imported', kind: 'token',
      encryptionMode: 'plain', storedContent: { t: 'plain', v: { v: 1, name: 'Imported', kind: 'token', value: 'private-fixture' } },
      expectedSettingsVersion: 4, nextSettings: { t: 'plain', v: {} },
      referenceCensus: { accountMode: 'plain', profileTransferRevision: 'absent',
        profiles: { referenceGuardRevision: 3, rows: [] } }, profileMutations: [] });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [] } });
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { resourceId: input.resourceId, settingsVersion: 5 } });
    const operation = { expectedScopeKey: scopeKey, input, operationContext: context };
    await expect(savedSecretOperationOwner.promoteSavedSecretResourceForOperation(operation))
      .resolves.toEqual({ status: 'applied', resourceId: input.resourceId, settingsVersion: 5 });
    expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toBe('https://invocation-home.example/v1/account/saved-secrets/resources/promote');
    expect(vi.mocked(axios.post).mock.calls[0]?.[2]?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    expect(persistenceMocks.readStoredCredentials).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()).toBe(ambient);
    current = false;
    await expect(savedSecretOperationOwner.promoteSavedSecretResourceForOperation(operation)).resolves.toEqual({ status: 'unavailable' });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(getActiveAccountSettingsSnapshot()).toBe(ambient);
  });

  it('hydrates under the Teams master feature even when credential resources are disabled', async () => {
    const token = 'account-token';
    const resourceId = 'resource-1';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const storedContent = sealSavedSecretResourceStoredContentV1({
      resourceId,
      mode: 'plain',
      content: {
        v: 1,
        name: 'Shared API key',
        kind: 'apiKey',
        value: 'provider-secret',
      },
    });
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        resources: [{
          resourceId,
          encryptionMode: 'plain',
          entry: {
            ref,
            source: 'shared_resource',
            relationship: 'recipient',
            name: 'Shared API key',
            kind: 'apiKey',
            ownerAccountId: 'owner-account',
            revision: 4,
            materialStatus: 'ready',
            capabilities: {
              use: true,
              rename: false,
              rotate: false,
              manageAccess: false,
              delete: false,
            },
          },
          storedContent,
          recipientEnvelope: null,
        }],
      },
    });

    await hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true, false) });

    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('expected active Account snapshot');
    expect(createSavedSecretMaterializerFromSnapshotV1(snapshot).resolve(ref)).toEqual({
      status: 'ready',
      value: 'provider-secret',
      fingerprint: expect.stringMatching(/^saved-secret-record:v1:/u),
      source: 'shared_resource',
    });
  });

  it('preserves an authorized repair status when the server intentionally withholds material', async () => {
    const token = 'account-token';
    const resourceId = 'resource-needs-repair';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        resources: [{
          resourceId,
          encryptionMode: 'e2ee',
          entry: {
            ref,
            source: 'shared_resource',
            relationship: 'recipient',
            name: 'Shared token',
            kind: 'token',
            ownerAccountId: 'owner-account',
            revision: 7,
            materialStatus: 'update_required',
            capabilities: {
              use: true,
              rename: false,
              rotate: false,
              manageAccess: false,
              delete: false,
            },
          },
          storedContent: null,
          recipientEnvelope: null,
        }],
      },
    });

    await hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true) });

    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('expected active Account snapshot');
    expect(createSavedSecretMaterializerFromSnapshotV1(snapshot).resolve(ref)).toEqual({
      status: 'repair_required',
    });
  });

  it('keeps owner and recipient corrupt catalog entries out of material inputs', async () => {
    const token = 'account-token';
    const resourceId = 'resource-healthy';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const storedContent = sealSavedSecretResourceStoredContentV1({
      resourceId,
      mode: 'plain',
      content: {
        v: 1,
        name: 'Healthy API key',
        kind: 'apiKey',
        value: 'provider-secret',
      },
    });
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        resources: [{
          entry: {
            materialStatus: 'resource_corrupt',
            relationship: 'owner',
            repair: {
              kind: 'delete_resource',
              resourceId: 'malformed retained resource id',
              expectedRevision: 9,
            },
          },
        }, {
          entry: {
            materialStatus: 'resource_corrupt',
            relationship: 'recipient',
            repair: null,
          },
        }, {
          resourceId,
          encryptionMode: 'plain',
          entry: {
            ref,
            source: 'shared_resource',
            relationship: 'recipient',
            name: 'Healthy API key',
            kind: 'apiKey',
            ownerAccountId: 'owner-account',
            revision: 4,
            materialStatus: 'ready',
            capabilities: {
              use: true,
              rename: false,
              rotate: false,
              manageAccess: false,
              delete: false,
            },
          },
          storedContent,
          recipientEnvelope: null,
        }],
      },
    });

    const hydrated = await hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true) });

    expect(hydrated.resources.map((resource) => resource.resourceId)).toEqual([resourceId]);
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('expected active Account snapshot');
    expect(createSavedSecretMaterializerFromSnapshotV1(snapshot).resolve(ref)).toMatchObject({
      status: 'ready',
      value: 'provider-secret',
    });
  });

  it('keeps healthy rows usable when one recipient envelope cannot be opened', async () => {
    const token = 'account-token';
    const encryptedResourceId = 'resource-invalid-envelope';
    const plainResourceId = 'resource-healthy';
    const encryptedRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: encryptedResourceId });
    const plainRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: plainResourceId });
    const accountMachineKey = new Uint8Array(32).fill(7);
    persistenceMocks.readStoredCredentials.mockResolvedValue({
      token,
      encryption: {
        type: 'dataKey',
        machineKey: accountMachineKey,
        publicKey: new Uint8Array(32).fill(8),
      },
    });
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        resources: [{
          resourceId: encryptedResourceId,
          encryptionMode: 'e2ee',
          entry: {
            ref: encryptedRef,
            source: 'shared_resource',
            relationship: 'recipient',
            name: 'Unavailable token',
            kind: 'token',
            ownerAccountId: 'owner-account',
            revision: 2,
            materialStatus: 'ready',
            capabilities: {
              use: true,
              rename: false,
              rotate: false,
              manageAccess: false,
              delete: false,
            },
          },
          storedContent: sealSavedSecretResourceStoredContentV1({
            resourceId: encryptedResourceId,
            mode: 'e2ee',
            resourceDataKey: new Uint8Array(32).fill(11),
            randomBytes: (length) => new Uint8Array(length).fill(12),
            content: { v: 1, name: 'Unavailable token', kind: 'token', value: 'must-not-open' },
          }),
          recipientEnvelope: {
            encryptedDataKey: Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES).toString('base64'),
            recipientContentPublicKeyFingerprint: 'content-fingerprint',
          },
        }, {
          resourceId: plainResourceId,
          encryptionMode: 'plain',
          entry: {
            ref: plainRef,
            source: 'shared_resource',
            relationship: 'recipient',
            name: 'Healthy API key',
            kind: 'apiKey',
            ownerAccountId: 'owner-account',
            revision: 3,
            materialStatus: 'ready',
            capabilities: {
              use: true,
              rename: false,
              rotate: false,
              manageAccess: false,
              delete: false,
            },
          },
          storedContent: sealSavedSecretResourceStoredContentV1({
            resourceId: plainResourceId,
            mode: 'plain',
            content: { v: 1, name: 'Healthy API key', kind: 'apiKey', value: 'healthy-value' },
          }),
          recipientEnvelope: null,
        }],
      },
    });

    await hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true) });

    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('expected active Account snapshot');
    const materializer = createSavedSecretMaterializerFromSnapshotV1(snapshot);
    expect(materializer.resolve(encryptedRef)).toEqual({ status: 'temporarily_unavailable' });
    expect(materializer.resolve(plainRef)).toMatchObject({
      status: 'ready',
      value: 'healthy-value',
      source: 'shared_resource',
    });
  });

  it('fails stale shared material closed while preserving it for a retryable refresh', async () => {
    const token = 'account-token';
    const resourceId = 'resource-revoked-during-refresh';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const storedContent = sealSavedSecretResourceStoredContentV1({
      resourceId,
      mode: 'plain',
      content: {
        v: 1,
        name: 'Shared API key',
        kind: 'apiKey',
        value: 'stale-provider-secret',
      },
    });
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
      savedSecretCatalogState: 'ready',
      savedSecretResources: [{
        resourceId,
        ownerAccountId: 'owner-account',
        displayName: 'Shared API key',
        kind: 'apiKey',
        encryptionMode: 'plain',
        revision: 4,
        storedContent,
        materialStatus: 'ready',
      }],
    });
    vi.mocked(axios.get).mockRejectedValue(new Error('network unavailable'));

    await expect(hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true) }))
      .rejects.toThrow('network unavailable');

    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('expected active Account snapshot');
    expect(snapshot.savedSecretCatalogState).toBe('temporarily_unavailable');
    expect(snapshot.savedSecretResources).toHaveLength(1);
    expect(snapshot.savedSecretResources?.[0]?.storedContent).toBeNull();
    expect(createSavedSecretMaterializerFromSnapshotV1(snapshot).resolve(ref)).toEqual({
      status: 'temporarily_unavailable',
    });
  });

  it('withdraws and zeroes an opened resource DEK when refresh loses authoritative observation', async () => {
    const token = 'account-token';
    const resourceDataKey = new Uint8Array(32).fill(19);
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
      savedSecretCatalogState: 'ready',
      savedSecretResources: [{
        resourceId: 'resource-e2ee',
        ownerAccountId: 'owner-account',
        displayName: 'Shared API key',
        kind: 'apiKey',
        encryptionMode: 'e2ee',
        revision: 4,
        storedContent: { t: 'encrypted', c: 'AA==' },
        materialStatus: 'ready',
        resourceDataKey,
      }],
    });
    vi.mocked(axios.get).mockRejectedValue(new Error('observer gap'));

    await expect(hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true) }))
      .rejects.toThrow('observer gap');

    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('expected active Account snapshot');
    expect(snapshot.savedSecretResources?.[0]?.resourceDataKey).toBeUndefined();
    expect([...resourceDataKey]).toEqual(new Array(32).fill(0));
  });

  it('clears shared material without affecting personal Saved Secrets when Teams is disabled', async () => {
    const token = 'account-token';
    const settingsKey = new Uint8Array(32).fill(17);
    const resourceDataKey = new Uint8Array(32).fill(23);
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({
        secrets: [{
          id: 'personal-secret',
          name: 'Personal token',
          kind: 'token',
          encryptedValue: {
            _isSecretValue: true,
            encryptedValue: encryptSecretStringV1(
              'personal-value',
              settingsKey,
              (length) => new Uint8Array(length).fill(18),
            ),
          },
          createdAt: 1,
          updatedAt: 1,
        }],
      }),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [settingsKey],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
      savedSecretCatalogState: 'ready',
      savedSecretResources: [{
        resourceId: 'resource-e2ee',
        ownerAccountId: 'owner-account',
        displayName: 'Shared token',
        kind: 'token',
        encryptionMode: 'e2ee',
        revision: 4,
        storedContent: { t: 'encrypted', c: 'AA==' },
        materialStatus: 'ready',
        resourceDataKey,
      }],
    });

    const hydrated = await hydrateSavedSecretCatalog({
      token,
      serverFeatures: serverFeatures(false, true),
    });

    expect(hydrated).toEqual({ resources: [], state: 'disabled' });
    expect(axios.get).not.toHaveBeenCalled();
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('expected active Account snapshot');
    expect(snapshot.savedSecretCatalogState).toBe('disabled');
    expect(snapshot.savedSecretResources).toEqual([]);
    expect([...resourceDataKey]).toEqual(new Array(32).fill(0));
    expect(createSavedSecretMaterializerFromSnapshotV1(snapshot).resolve('personal-secret')).toMatchObject({
      status: 'ready',
      value: 'personal-value',
      source: 'personal',
    });
  });

  it('refreshes shared references at operation admission so a missed invalidation cannot use revoked material', async () => {
    const token = 'account-token';
    const resourceId = 'resource-revoked-without-change-hint';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
      savedSecretCatalogState: 'ready',
      savedSecretResources: [{
        resourceId,
        ownerAccountId: 'owner-account',
        displayName: 'Revoked shared key',
        kind: 'apiKey',
        encryptionMode: 'plain',
        revision: 4,
        storedContent: sealSavedSecretResourceStoredContentV1({
          resourceId,
          mode: 'plain',
          content: { v: 1, name: 'Revoked shared key', kind: 'apiKey', value: 'stale-value' },
        }),
        materialStatus: 'ready',
      }],
    });
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token, encryption: null });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [] } });
    const overlay = {
      v: 1 as const,
      bindings: { API_KEY: { ref, revision: 4 } },
    };

    await expect(refreshSavedSecretCatalogForOperation({
      expectedScopeKey: resolveAccountSettingsScopeKeyForToken(token),
      secretReferenceOverlay: overlay,
    })).rejects.toMatchObject({
      reason: 'reference_stale',
      reference: ref,
    });

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('does not contact the shared catalog for a personal-only operation overlay', async () => {
    const token = 'account-token';
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token, encryption: null });

    await expect(refreshSavedSecretCatalogForOperation({
      expectedScopeKey: resolveAccountSettingsScopeKeyForToken(token),
      secretReferenceOverlay: {
        v: 1,
        bindings: { API_KEY: { ref: 'personal-secret' } },
      },
    })).resolves.toMatchObject({ settingsVersion: 1 });

    expect(axios.get).not.toHaveBeenCalled();
  });

  it('keeps a legacy colliding Profile reference personal before rekey', async () => {
    const token = 'account-token';
    const ref = 'happier:shared-secret:v1:legacy-personal';
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({
        secrets: [{
          id: ref, name: 'Legacy personal', kind: 'token', updatedAt: 7,
          createdAt: 1,
          encryptedValue: { _isSecretValue: true, value: 'exact-personal-value' },
        }],
      }),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });

    const refreshed = await refreshSavedSecretCatalogForOperation({
      expectedScopeKey: resolveAccountSettingsScopeKeyForToken(token),
      references: [{ ref }],
    });

    expect(createSavedSecretMaterializerFromSnapshotV1(refreshed).resolve(ref)).toMatchObject({
      status: 'ready',
      value: 'exact-personal-value',
      source: 'personal',
    });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('refuses a shared operation that collides with an extant personal record until rekey', async () => {
    const token = 'account-token';
    const ref = 'happier:shared-secret:v1:legacy-personal';
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({
        secrets: [{
          id: ref, name: 'Legacy personal', kind: 'token', updatedAt: 7,
          createdAt: 1,
          encryptedValue: { _isSecretValue: true, value: 'exact-personal-value' },
        }],
      }),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });

    await expect(refreshSavedSecretCatalogForOperation({
      expectedScopeKey: resolveAccountSettingsScopeKeyForToken(token),
      references: [{ ref, revision: 1 }],
    })).rejects.toMatchObject({
      reason: 'reference_collision_migration_required',
      reference: ref,
    });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('rejects freshly hydrated shared material whose authenticated content cannot be opened', async () => {
    const token = 'account-token';
    const resourceId = 'resource-corrupt-content';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const accountMachineKey = new Uint8Array(32).fill(7);
    const accountPublicKey = tweetnacl.box.keyPair.fromSecretKey(accountMachineKey).publicKey;
    const resourceDataKey = new Uint8Array(32).fill(11);
    const storedContent = sealSavedSecretResourceStoredContentV1({
      resourceId,
      mode: 'e2ee',
      resourceDataKey,
      randomBytes: (length) => new Uint8Array(length).fill(12),
      content: { v: 1, name: 'Corrupt token', kind: 'token', value: 'must-not-open' },
    });
    if (storedContent.t !== 'encrypted') throw new Error('expected encrypted Saved Secret fixture');
    const corruptedBytes = Buffer.from(storedContent.c, 'base64');
    corruptedBytes[corruptedBytes.length - 1] ^= 1;
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
    persistenceMocks.readStoredCredentials.mockResolvedValue({
      token,
      encryption: {
        type: 'dataKey',
        machineKey: accountMachineKey,
        publicKey: accountPublicKey,
      },
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        resources: [{
          resourceId,
          encryptionMode: 'e2ee',
          entry: {
            ref,
            source: 'shared_resource',
            relationship: 'recipient',
            name: 'Corrupt token',
            kind: 'token',
            ownerAccountId: 'owner-account',
            revision: 3,
            materialStatus: 'ready',
            capabilities: {
              use: true,
              rename: false,
              rotate: false,
              manageAccess: false,
              delete: false,
            },
          },
          storedContent: { t: 'encrypted', c: corruptedBytes.toString('base64') },
          recipientEnvelope: {
            encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({
              dataKey: resourceDataKey,
              recipientPublicKey: accountPublicKey,
              randomBytes: (length) => new Uint8Array(length).fill(13),
            })).toString('base64'),
            recipientContentPublicKeyFingerprint: 'content-fingerprint',
          },
        }],
      },
    });

    await expect(refreshSavedSecretCatalogForOperation({
      expectedScopeKey: resolveAccountSettingsScopeKeyForToken(token),
      references: [{ ref, revision: 3 }],
    })).rejects.toMatchObject({
      reason: 'reference_corrupt',
      reference: ref,
    });
  });

  it('rejects freshly hydrated shared material whose authenticated metadata disagrees with its catalog row', async () => {
    const token = 'account-token';
    const resourceId = 'resource-mismatched-content';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token, encryption: null });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        resources: [{
          resourceId,
          encryptionMode: 'plain',
          entry: {
            ref,
            source: 'shared_resource',
            relationship: 'recipient',
            name: 'Catalog API key',
            kind: 'apiKey',
            ownerAccountId: 'owner-account',
            revision: 5,
            materialStatus: 'ready',
            capabilities: {
              use: true,
              rename: false,
              rotate: false,
              manageAccess: false,
              delete: false,
            },
          },
          storedContent: sealSavedSecretResourceStoredContentV1({
            resourceId,
            mode: 'plain',
            content: { v: 1, name: 'Different token', kind: 'token', value: 'must-not-open' },
          }),
          recipientEnvelope: null,
        }],
      },
    });

    await expect(refreshSavedSecretCatalogForOperation({
      expectedScopeKey: resolveAccountSettingsScopeKeyForToken(token),
      references: [{ ref, revision: 5 }],
    })).rejects.toMatchObject({
      reason: 'reference_corrupt',
      reference: ref,
    });
  });

  it('admits freshly hydrated shared material whose value is whitespace', async () => {
    const token = 'account-token';
    const resourceId = 'resource-whitespace-value';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token, encryption: null });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        resources: [{
          resourceId,
          encryptionMode: 'plain',
          entry: {
            ref,
            source: 'shared_resource',
            relationship: 'recipient',
            name: 'Whitespace token',
            kind: 'token',
            ownerAccountId: 'owner-account',
            revision: 8,
            materialStatus: 'ready',
            capabilities: {
              use: true,
              rename: false,
              rotate: false,
              manageAccess: false,
              delete: false,
            },
          },
          storedContent: sealSavedSecretResourceStoredContentV1({
            resourceId,
            mode: 'plain',
            content: { v: 1, name: 'Whitespace token', kind: 'token', value: ' \t\n ' },
          }),
          recipientEnvelope: null,
        }],
      },
    });

    const refreshed = await refreshSavedSecretCatalogForOperation({
      expectedScopeKey: resolveAccountSettingsScopeKeyForToken(token),
      references: [{ ref, revision: 8 }],
    });

    expect(createSavedSecretMaterializerFromSnapshotV1(refreshed).resolve(ref)).toMatchObject({
      status: 'ready',
      value: ' \t\n ',
    });
  });

  it('admits a current persisted Profile shared reference without requiring an overlay revision', async () => {
    const token = 'account-token';
    const resourceId = 'resource-profile-current';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const storedContent = sealSavedSecretResourceStoredContentV1({
      resourceId,
      mode: 'plain',
      content: {
        v: 1,
        name: 'Current Profile key',
        kind: 'apiKey',
        value: 'current-value',
      },
    });
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token, encryption: null });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        resources: [{
          resourceId,
          encryptionMode: 'plain',
          entry: {
            ref,
            source: 'shared_resource',
            relationship: 'recipient',
            name: 'Current Profile key',
            kind: 'apiKey',
            ownerAccountId: 'owner-account',
            revision: 9,
            materialStatus: 'ready',
            capabilities: {
              use: true,
              rename: false,
              rotate: false,
              manageAccess: false,
              delete: false,
            },
          },
          storedContent,
          recipientEnvelope: null,
        }],
      },
    });

    const refreshed = await refreshSavedSecretCatalogForOperation({
      expectedScopeKey: resolveAccountSettingsScopeKeyForToken(token),
      references: [{ ref }],
    });

    expect(createSavedSecretMaterializerFromSnapshotV1(refreshed).resolve(ref))
      .toMatchObject({ status: 'ready', value: 'current-value' });
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('publishes one Account Settings snapshot per refresh, and only when the authorized catalog changed', async () => {
    const token = 'account-token';
    const resourceId = 'resource-published-on-change';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const row = {
      resourceId,
      encryptionMode: 'plain' as const,
      entry: {
        ref,
        source: 'shared_resource' as const,
        relationship: 'recipient' as const,
        name: 'Shared API key',
        kind: 'apiKey' as const,
        ownerAccountId: 'owner-account',
        revision: 4,
        materialStatus: 'ready' as const,
        capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
      },
      storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId,
        mode: 'plain',
        content: { v: 1, name: 'Shared API key', kind: 'apiKey', value: 'shared-value' },
      }),
      recipientEnvelope: null,
    };
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: AccountSettingsSchema.parse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token, encryption: null });
    const publications = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(publications);
    const resolveActive = () => {
      const snapshot = getActiveAccountSettingsSnapshot();
      if (!snapshot) throw new Error('expected active Account snapshot');
      return createSavedSecretMaterializerFromSnapshotV1(snapshot).resolve(ref);
    };
    try {
      vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [row] } });
      await hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true) });
      expect(publications).toHaveBeenCalledTimes(1);
      expect(resolveActive()).toMatchObject({ status: 'ready', value: 'shared-value' });

      // An AccountChange wake or an operation admission that observes the same
      // authorized catalog must not wake any consumer. While the Home is being
      // observed, a synchronous reader still sees the material withdrawn.
      vi.mocked(axios.get).mockImplementation(async () => {
        expect(resolveActive()).toEqual({ status: 'temporarily_unavailable' });
        return { status: 200, data: { resources: [row] } };
      });
      await hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true) });
      await refreshSavedSecretCatalogForOperation({
        expectedScopeKey: resolveAccountSettingsScopeKeyForToken(token),
        references: [{ ref }],
      });
      expect(axios.get).toHaveBeenCalledTimes(3);
      expect(publications).toHaveBeenCalledTimes(1);
      expect(resolveActive()).toMatchObject({ status: 'ready', value: 'shared-value' });

      // A real revocation is published once.
      vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [] } });
      await hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true) });
      expect(publications).toHaveBeenCalledTimes(2);
      expect(resolveActive().status).not.toBe('ready');

      // A lost observation withdraws and publishes once; repeating it changes nothing.
      vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [row] } });
      await hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true) });
      expect(publications).toHaveBeenCalledTimes(3);
      vi.mocked(axios.get).mockResolvedValue({ status: 503, data: {} });
      await expect(hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true) }))
        .rejects.toThrow('saved_secret_catalog_http_503');
      expect(publications).toHaveBeenCalledTimes(4);
      expect(resolveActive()).toEqual({ status: 'temporarily_unavailable' });
      await expect(hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true) }))
        .rejects.toThrow('saved_secret_catalog_http_503');
      expect(publications).toHaveBeenCalledTimes(4);

      // A malformed Home answer also ends the refresh with the withdrawn state published.
      vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [row] } });
      await hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true) });
      expect(publications).toHaveBeenCalledTimes(5);
      vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: 'malformed' } });
      await expect(hydrateSavedSecretCatalog({ token, serverFeatures: serverFeatures(true) }))
        .rejects.toThrow();
      expect(publications).toHaveBeenCalledTimes(6);
      expect(resolveActive()).toEqual({ status: 'temporarily_unavailable' });
    } finally {
      unsubscribe();
    }
  });
});
