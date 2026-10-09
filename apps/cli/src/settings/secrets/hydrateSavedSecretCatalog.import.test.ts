import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, FeaturesResponseSchema, type AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol';
import { createAccountScopedCryptoMaterialSnapshotV1, deriveAccountMachineKeyFromRecoverySecret, openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { AccountSettingsPersistedObjectSchema } from '@happier-dev/protocol/account/settings/accountSettingsPersistedObject';
import { AccountSettingsV2HistoryMutationRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { deriveSettingsSecretsKeySetV1, encryptSecretStringV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { ProfileRecordV1Schema, sealProfileRecordContentV1, type ProfileRowV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, sealConnectedAccountCatalogContentV1, openConnectedAccountCatalogContentV1,
  type ConnectedAccountCatalogRecordV1, type ConnectedAccountCatalogRowReadResponseV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { REMOTE_HOST_ROWS_ROUTE_V1, REMOTE_HOST_ACCOUNT_CIPHER_KIND_V1, RemoteHostCatalogRecordV1Schema,
  sealRemoteHostCatalogContentV1, openRemoteHostCatalogContentV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1, NOTIFICATION_CHANNELS_CIPHER_KIND_V1, NotificationChannelCatalogRecordV1Schema,
  sealNotificationChannelCatalogContentV1, openNotificationChannelCatalogContentV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import type { StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { deriveSettingsSecretsReadKeysForCredentials } from './settingsSecretsKey';
import { createSavedSecretMaterializerFromSnapshotV1 } from './savedSecretCatalog';
import { createInvocationSavedSecretOperationContextV1, refreshSavedSecretCatalogForOperation } from './hydrateSavedSecretCatalog';
import * as savedSecretOperations from './hydrateSavedSecretCatalog';

// HTTP and credential persistence are process-external boundaries; all import decisions remain real.
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const persistenceBoundary = vi.hoisted(() => ({ readStoredCredentials: vi.fn() }));
vi.mock('@/persistence', async importOriginal => ({ ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: persistenceBoundary.readStoredCredentials }));

describe('SavedSecret material-demand legacy import', () => {
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    vi.mocked(axios.get).mockReset();
    vi.mocked(axios.post).mockReset();
    persistenceBoundary.readStoredCredentials.mockReset();
  });
  afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    vi.unstubAllGlobals();
  });

  it.each(['plain', 'e2ee'] as const)('selects two new %s secrets in one catalog transaction despite unrelated Settings drift', async mode => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'batch-account' })).toString('base64url')}.signature`;
    const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(4) } };
    const material = credentials.encryption;
    const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
    const raw = { preferredLanguage: 'fr', futureSibling: { preserved: true } };
    const context = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://batch-home.example',
      snapshot: { source: 'network', settings: AccountSettingsSchema.parse(raw), rawSettings: raw, settingsVersion: 4,
        loadedAtMs: 1, scopeKey, settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials) }, isCurrent: async () => true });
    const preparedSavedSecrets = ['first', 'second'].map(id => ({ id, record: { id, name: id, kind: 'token' as const,
      createdAt: 1, updatedAt: 1, encryptedValue: material ? { _isSecretValue: true as const,
        encryptedValue: encryptSecretStringV1(`${id}-private`, deriveSettingsSecretsKeySetV1(material).writeKey,
          length => new Uint8Array(length).fill(12)) } : { _isSecretValue: true as const, value: `${id}-private` } } }));
    const record = { key: 'configurations' as const, value: { v: 1 as const, entries: [{ service: { pluginId: 'fixture.service', localId: 'api' },
      modeId: 'api_key', revision: 'r1', values: {}, secretRefs: { first: 'first', second: 'second' } }] } };
    const currentContent = sealConnectedAccountCatalogContentV1({ mode, material,
      record: { key: 'configurations', value: { v: 1, entries: [] } } });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} }))));
    vi.mocked(axios.get).mockImplementation(async url => {
      expect(new URL(String(url)).origin).toBe('https://batch-home.example');
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode, version: 1, settingsVersion: 9,
        signingKeyFingerprint: null, contentKeyFingerprint: material ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
          createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint) : null,
        updatedAt: 1, recipientEnvelopeReadiness: mode === 'plain' ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' } } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
      if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`) return { status: 200, data: { status: 'present', revision: 7, content: currentContent } };
      if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [] } };
      throw new Error(`Unexpected fixture read ${path}`);
    });
    let observed: ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse> | undefined;
    vi.mocked(axios.post).mockImplementation(async (url, body) => {
      expect(String(url)).toBe('https://batch-home.example/v1/account/saved-secrets/resources/promote');
      observed = SharedSavedSecretPromoteInputV1Schema.parse(body);
      return { status: 200, data: { resourceId: observed.resourceId, settingsVersion: 9 } };
    });
    const result = await savedSecretOperations.promoteSavedSecretsWithConnectedAccountCatalog({ credentials, operationContext: context,
      preparedSavedSecrets, connectedAccountCatalog: { expectedRevision: 7, record } });
    expect(result).toMatchObject({ status: 'applied', settingsVersion: 9 });
    if (!observed) throw new Error('fixture_missing_atomic_request');
    const ids = preparedSavedSecrets.map(secret => deriveSavedSecretImportResourceIdV1({ accountId: 'batch-account',
      source: { kind: 'personal-saved-secret', secretId: secret.id } }));
    expect(observed.resourceId).toBe(ids[0]);
    expect(observed.additionalSavedSecretResources?.map(resource => resource.resourceId)).toEqual([ids[1]]);
    // Privately prepared credentials are not persisted personal source identities.
    expect(observed.personalSecretPromotions).toBeUndefined();
    const values = [observed, ...(observed.additionalSavedSecretResources ?? [])].map(created => {
      expect(created.encryptionMode).toBe(mode);
      if (created.encryptionMode === 'plain') return openSavedSecretResourceStoredContentV1({ resourceId: created.resourceId,
        mode: 'plain', storedContent: created.storedContent })?.value;
      if (material?.type !== 'legacy') throw new Error('fixture_missing_account_key');
      const envelope = created.keyEnvelopes?.find(candidate => candidate.recipientAccountId === 'batch-account');
      if (!envelope) throw new Error('fixture_missing_owner_envelope');
      const resourceDataKey = openEncryptedDataKeyEnvelopeV1({ envelope: Buffer.from(envelope.encryptedDataKey, 'base64'),
        recipientSecretKeyOrSeed: deriveAccountMachineKeyFromRecoverySecret(material.secret) });
      if (!resourceDataKey) throw new Error('fixture_unreadable_owner_envelope');
      return openSavedSecretResourceStoredContentV1({ resourceId: created.resourceId, mode: 'e2ee',
        storedContent: created.storedContent, resourceDataKey })?.value;
    });
    expect(values).toEqual(['first-private', 'second-private']);
    expect(observed.nextSettings).toBeNull();
    expect(observed).not.toHaveProperty('expectedSettingsVersion');
    expect(observed.referenceCensus).toEqual({ scope: 'catalogs', accountMode: mode, catalogs: { connectedConfigurations: 7 } });
    const mutation = observed.catalogMutations?.connectedConfigurations;
    expect(mutation).toMatchObject({ expectedRevision: 7, referencedSavedSecretIds: ids.map(id => `happier:shared-secret:v1:${id}`),
      savedSecretRevisions: ids.map(resourceId => ({ resourceId, expectedRevision: 1 })) });
    if (!mutation?.content) throw new Error('fixture_missing_atomic_catalog');
    expect(openConnectedAccountCatalogContentV1({ key: 'configurations', mode, material, content: mutation.content })).toEqual({ status: 'opened',
      record: { ...record, value: { ...record.value, entries: [{ ...record.value.entries[0], secretRefs: {
        first: `happier:shared-secret:v1:${ids[0]}`, second: `happier:shared-secret:v1:${ids[1]}`,
      } }] } } });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(context.readSnapshot()).toMatchObject({ rawSettings: raw, settingsVersion: 4 });
  });

  it('retains available resource material without discarding an uncharacterized legacy source', async () => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'import-account' })).toString('base64url')}.signature`;
    const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
    const credentials: StoredCredentials = { token, encryption: null };
    const raw = { secrets: [{ id: 'future-material', name: 'Future', kind: 'token', createdAt: 1, updatedAt: 1,
      encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'future-secret-envelope', c: 'opaque' } } }] };
    persistenceBoundary.readStoredCredentials.mockResolvedValue(credentials);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({
      features: { teams: { enabled: true } }, capabilities: {} }))));
    vi.mocked(axios.get).mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 4, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: raw } } };
      if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [], nextCursor: null,
        complete: true, diagnostics: [], referenceGuardRevision: 3, transferControl: { status: 'absent' } } };
      if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 3 } };
      if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [{
        resourceId: 'already-ready', encryptionMode: 'plain', recipientEnvelope: null,
        storedContent: { t: 'plain', v: { v: 1, name: 'Current', kind: 'token', value: 'current-private' } },
        entry: { ref: 'happier:shared-secret:v1:already-ready', source: 'shared_resource', relationship: 'owner',
          ownerAccountId: 'import-account', name: 'Current', kind: 'token', revision: 1, materialStatus: 'ready',
          capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
      }] } };
      return { status: 404, data: { error: 'not_found' } };
    });
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse(raw), rawSettings: raw,
      settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    const snapshot = await runWithServerHttpBaseUrl('https://import-home.example', () => refreshSavedSecretCatalogForOperation({
      expectedScopeKey: scopeKey, references: [{ ref: 'happier:shared-secret:v1:already-ready', revision: 1 }] }));
    expect(createSavedSecretMaterializerFromSnapshotV1(snapshot).resolve('happier:shared-secret:v1:already-ready'))
      .toMatchObject({ status: 'ready', value: 'current-private' });
    expect(snapshot.rawSettings).toBe(raw);
    expect(Reflect.get(snapshot, 'savedSecretLegacyImport')).toMatchObject({ status: 'pending', reason: 'source-uncharacterized' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it.each([['plain', false, 'ambient'], ['e2ee', false, 'ambient'], ['plain', true, 'ambient'], ['e2ee', true, 'ambient'],
    ['plain', false, 'invocation'], ['e2ee', false, 'invocation'], ['plain', false, 'invocation-native-artifact'],
    ['plain', false, 'invocation-native-artifact-projection'],
    ['plain', false, 'invocation-history-retry'], ['e2ee', false, 'invocation-history-retry'],
    ['plain', false, 'invocation-active-connected'], ['e2ee', false, 'invocation-active-connected'],
    ['plain', false, 'invocation-invalid-active-connected'],
    ['plain', false, 'invocation-active-reference-catalogs'], ['e2ee', false, 'invocation-active-reference-catalogs'],
    ['plain', false, 'invocation-partial-notification'], ['e2ee', false, 'invocation-partial-notification'],
    ['plain', false, 'invocation-partial-remote-host'], ['e2ee', false, 'invocation-partial-remote-host'],
    ['plain', false, 'invocation-inference-history-retry'], ['e2ee', false, 'invocation-inference-history-retry']] as const)(
    'imports at the public refresh boundary using genuine %s content with retained future source %s in %s custody and never replays committed material', async (mode, retainFuture, custody) => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'import-account' })).toString('base64url')}.signature`;
    const secret = new Uint8Array(32).fill(4);
    const credentials: StoredCredentials = mode === 'e2ee'
      ? { token, encryption: { type: 'legacy', secret } } : { token, encryption: null };
    const material = credentials.encryption;
    const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
    const invocation = custody !== 'ambient';
    const inheritedArtifactBindings = custody === 'invocation-native-artifact';
    const nativeArtifact = inheritedArtifactBindings || custody === 'invocation-native-artifact-projection';
    const inference = custody === 'invocation-inference-history-retry';
    const historyRetry = custody === 'invocation-history-retry' || inference;
    const invalidActiveConnected = custody === 'invocation-invalid-active-connected';
    const activeConnected = custody === 'invocation-active-connected' || invalidActiveConnected;
    const partialNotification = custody === 'invocation-partial-notification';
    const partialRemoteHost = custody === 'invocation-partial-remote-host';
    const activeReferenceCatalogs = custody === 'invocation-active-reference-catalogs' || partialNotification || partialRemoteHost;
    const inheritedRef = 'happier:shared-secret:v1:inherited';
    const maskedRef = 'happier:shared-secret:v1:masked';
    const remoteHostRecord = RemoteHostCatalogRecordV1Schema.parse({ v: 1, hosts: [{ id: 'host', name: 'Private host',
      createdAt: 1, updatedAt: 1, lastUsedAt: null, ssh: { target: 'user@host.example', authMode: 'password', passwordSecretRef: inheritedRef } }] });
    const notificationRecord = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{ v: 1, id: 'webhook',
      kind: 'webhook', url: 'https://notification.example/hook', signingSecretRef: inheritedRef, topics: {} }] });
    // Future retained entries are genuine stored HTTP inputs, not outputs of the strict current writer.
    const unknownRemoteHostRecord = { ...remoteHostRecord, hosts: [...remoteHostRecord.hosts,
      { id: 'future-host', ssh: { passwordSecretRef: inheritedRef } }] };
    const unknownNotificationRecord = { ...notificationRecord, channels: [...notificationRecord.channels,
      { id: 'future-channel', kind: 'future-channel', signingSecretRef: inheritedRef }] };
    const retainedContent = (kind: typeof REMOTE_HOST_ACCOUNT_CIPHER_KIND_V1 | typeof NOTIFICATION_CHANNELS_CIPHER_KIND_V1,
      payload: unknown) => material ? { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind, material, payload,
        randomBytes: length => new Uint8Array(length).fill(11) }) }
      : { t: 'plain' as const, v: payload };
    const remoteHostContent = partialRemoteHost ? retainedContent(REMOTE_HOST_ACCOUNT_CIPHER_KIND_V1, unknownRemoteHostRecord)
      : sealRemoteHostCatalogContentV1({ mode, material, record: remoteHostRecord });
    const notificationContent = partialNotification ? retainedContent(NOTIFICATION_CHANNELS_CIPHER_KIND_V1, unknownNotificationRecord)
      : sealNotificationChannelCatalogContentV1({ mode, material, record: notificationRecord });
    if (partialRemoteHost) expect(openRemoteHostCatalogContentV1({ mode, material, content: remoteHostContent }).status).toBe('partial');
    if (partialNotification) expect(openNotificationChannelCatalogContentV1({ mode, material, content: notificationContent }).status).toBe('partial');
    const legacy = { id: 'old-token', name: 'Legacy token', kind: 'token' as const,
      encryptedValue: material ? { _isSecretValue: true as const,
        encryptedValue: encryptSecretStringV1('fixture-private', deriveSettingsSecretsKeySetV1(material).writeKey,
          length => new Uint8Array(length).fill(12)) }
        : { _isSecretValue: true as const, value: 'fixture-private' }, createdAt: 1, updatedAt: 2 };
    const future = { id: 'future-material', name: 'Future', kind: 'token', createdAt: 1, updatedAt: 1,
      encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'future-secret-envelope', c: 'opaque' } } };
    let raw: Readonly<Record<string, unknown>> = inference ? { inferenceOpenAIKey: 'fixture-private',
      preferredLanguage: 'fr', futureSibling: { preserve: true } } : { secrets: [legacy, ...(retainFuture ? [future] : [])],
      ...(nativeArtifact ? {} : { secretBindingsByProfileId: { 'builtin-default': { TOKEN: legacy.id } } }), futureSibling: { preserve: true } };
    const connectedRecord: ConnectedAccountCatalogRecordV1 = { key: 'configurations', value: { v: 1,
      entries: [{ service: { pluginId: 'fixture.service', localId: 'api' }, modeId: 'api_key', revision: 'r1',
        values: {}, secretRefs: { token: invalidActiveConnected ? legacy.id : inheritedRef } }] } };
    const connectedConfigurationRow: ConnectedAccountCatalogRowReadResponseV1 = activeConnected
      ? { status: 'present', revision: 5, content: invalidActiveConnected
        // Retained invalid HTTP bytes cannot be produced by the current strict writer.
        ? { t: 'plain', v: connectedRecord }
        : sealConnectedAccountCatalogContentV1({ mode, material, record: connectedRecord }) }
      : { status: 'absent' };
    let referenceGuardRevision = 3;
    const profileRows: ProfileRowV1[] = nativeArtifact ? [{ id: 'p', revision: 2,
      content: sealProfileRecordContentV1({ mode: 'plain', material: null, record: ProfileRecordV1Schema.parse({
        v: 1, id: 'p', definition: { kind: 'artifact', artifactId: 'selected' }, enabled: true, promptStack: [],
        secretBindings: inheritedArtifactBindings ? { MASKED: null } : {},
      }) }) }] : [];
    const artifactBody = JSON.stringify({ kind: 'launch-profile.v1', profile: { id: 'p', name: 'Selected',
      environmentVariables: [], envVarRequirements: [{ name: 'TOKEN', kind: 'secret' }], createdAt: 1, updatedAt: 1 },
      secretBindings: { TOKEN: legacy.id, ...(inheritedArtifactBindings ? { SECOND: inheritedRef, MASKED: maskedRef } : {}) } });
    let version = 4;
    const resources: unknown[] = inheritedArtifactBindings || activeConnected || activeReferenceCatalogs ? [{ resourceId: 'inherited', encryptionMode: 'plain', recipientEnvelope: null,
      storedContent: { t: 'plain', v: { v: 1, name: 'Inherited', kind: 'token', value: 'inherited-private' } },
      entry: { ref: inheritedRef, source: 'shared_resource', relationship: activeConnected ? 'recipient' : 'owner',
        ownerAccountId: activeConnected ? 'shared-source' : 'import-account',
        name: 'Inherited', kind: 'token', revision: 7, materialStatus: 'ready',
        capabilities: { use: true, rename: !activeConnected, rotate: !activeConnected, manageAccess: !activeConnected, delete: !activeConnected } } }] : [];
    const applied: ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>[] = [];
    const randomBytes = (length: number) => new Uint8Array(length).fill(11);
    const storedSettings = (): AccountSettingsStoredContentEnvelope => {
      if (mode === 'plain') return { t: 'plain', v: raw };
      if (!material) throw new Error('missing_fixture_account_encryption_material');
      return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material, payload: raw, randomBytes }) };
    };
    let retained: AccountSettingsStoredContentEnvelope | null = storedSettings();
    const historyMutations: ReturnType<typeof AccountSettingsV2HistoryMutationRequestSchema.parse>[] = [];
    let historyAttempts = 0;
    const currentness = { mode, version: 1, settingsVersion: version, signingKeyFingerprint: null,
      contentKeyFingerprint: material ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint) : null,
      updatedAt: 1, recipientEnvelopeReadiness: mode === 'plain'
        ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' } };
    const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(features)));
    const ambientCredentials: StoredCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'ambient-account' })).toString('base64url')}.signature`, encryption: null };
    persistenceBoundary.readStoredCredentials.mockResolvedValue(invocation ? ambientCredentials : credentials);
    vi.mocked(axios.get).mockImplementation(async url => {
      expect(new URL(String(url)).origin).toBe('https://import-home.example');
      const path = new URL(String(url)).pathname;
      if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`) return { status: 200, data: connectedConfigurationRow };
      if (path === REMOTE_HOST_ROWS_ROUTE_V1) return { status: 200, data: activeReferenceCatalogs
        ? { status: 'present', revision: 8, content: remoteHostContent } : { status: 'absent' } };
      if (path === NOTIFICATION_CHANNELS_ROUTE_V1) return { status: 200, data: activeReferenceCatalogs
        ? { status: 'present', revision: 9, content: notificationContent } : { status: 'absent' } };
      if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) return { status: 200, data: activeConnected ? { status: 'deleted', revision: 6 } : { status: 'absent' } };
      if (path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1 || path === ACP_CATALOG_ROWS_ROUTE_V1 || path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) {
        return { status: 200, data: { status: 'absent' } };
      }
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { ...currentness, settingsVersion: version } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version, content: storedSettings() } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{ version: 4,
        createdAt: '2026-01-01T00:00:00.000Z', contentKind: mode === 'plain' ? 'plain' : 'encrypted',
        byteLength: JSON.stringify(retained).length }] } };
      if (path === '/v2/account/settings/history/4') return { status: 200, data: { version: 4,
        createdAt: '2026-01-01T00:00:00.000Z', content: retained } };
      if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: referenceGuardRevision } };
      if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
      if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: profileRows, nextCursor: null,
        complete: true, diagnostics: [], referenceGuardRevision, transferControl: { status: 'absent' } } };
      if (path === '/v1/artifacts/selected') return { status: 200, data: { id: 'selected', ownerAccountId: 'foreign-account',
        access: 'view', encryptionMode: 'plain', headerVersion: 2, bodyVersion: 4,
        header: encodePlainArtifactStoredContent({ kind: 'launch-profile.v1', profileId: 'p', name: 'Selected' }),
        body: encodePlainArtifactStoredContent({ body: artifactBody }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        seq: 1, createdAt: 1, updatedAt: 1 } };
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources } };
      return { status: 404, data: { error: 'not_found' } };
    });
    vi.mocked(axios.post).mockImplementation(async (url, body) => {
      expect(new URL(String(url)).origin).toBe('https://import-home.example');
      const path = new URL(String(url)).pathname;
      if (path === '/v2/account/settings/history/4/mutate') {
        historyAttempts++;
        if (historyRetry && historyAttempts === 1) return { status: 503, data: { error: 'history_unavailable' } };
        const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse(body);
        expect(mutation.expectedSettingsVersion).toBe(version);
        expect(mutation.expectedContent).toEqual(retained);
        if (mutation.operation.kind !== 'normalize') throw new Error('fixture_requires_normalization');
        retained = mutation.operation.content;
        historyMutations.push(mutation);
        return { status: 200, data: { status: 'applied' } };
      }
      expect(path).toBe('/v1/account/saved-secrets/resources/promote');
      const mutation = SharedSavedSecretPromoteInputV1Schema.parse(body);
      expect(mutation.expectedSettingsVersion).toBe(version);
      expect(mutation.referenceCensus).toMatchObject({ accountMode: mode, profileTransferRevision: 'absent',
        profiles: { referenceGuardRevision: 3, rows: nativeArtifact ? [{ id: 'p', revision: 2 }] : [] } });
      if (activeConnected) {
        expect(mutation.catalogMutations?.connectedConfigurations).toBeUndefined();
      }
      if (nativeArtifact) {
        expect(mutation.referenceCensus.artifacts).toEqual([{ artifactId: 'selected', headerVersion: 2, bodyVersion: 4 }]);
        expect(mutation.profileMutations).toMatchObject([{ id: 'p', operation: 'update', expectedRevision: 2 }]);
      const rowMutation = mutation.profileMutations[0]!;
        profileRows[0] = { id: rowMutation.id, revision: 3, content: rowMutation.content };
        referenceGuardRevision = 4;
      } else expect(mutation.profileMutations).toEqual([]);
      if (mutation.nextSettings?.t === 'plain') raw = mutation.nextSettings.v;
      else if (mutation.nextSettings?.t === 'encrypted') {
        if (!material) throw new Error('missing_fixture_account_encryption_material');
        const opened = openAccountScopedBlobCiphertext({ kind: 'account_settings', material, ciphertext: mutation.nextSettings.c });
        raw = AccountSettingsPersistedObjectSchema.parse(opened?.value);
      } else throw new Error('missing_fixture_settings');
      applied.push(mutation);
      const envelope = mutation.keyEnvelopes?.[0];
      resources.push({ resourceId: mutation.resourceId, encryptionMode: mode, storedContent: mutation.storedContent,
        recipientEnvelope: envelope ? { encryptedDataKey: envelope.encryptedDataKey,
          recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint } : null,
        entry: { ref: `happier:shared-secret:v1:${mutation.resourceId}`, source: 'shared_resource', relationship: 'owner',
          ownerAccountId: 'import-account', name: mutation.displayName, kind: mutation.kind, revision: 1, materialStatus: 'ready',
          capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } });
      return { status: 200, data: { resourceId: mutation.resourceId, settingsVersion: ++version } };
    });
    const sourceSnapshot = { source: 'network' as const, settings: AccountSettingsSchema.parse(raw), rawSettings: raw,
      settingsVersion: version, loadedAtMs: 1, settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials), scopeKey };
    let operationContext = invocation ? createInvocationSavedSecretOperationContextV1({
      credentials, snapshot: sourceSnapshot, serverHttpBaseUrl: 'https://import-home.example', isCurrent: async () => true,
    }) : undefined;
    setActiveAccountSettingsSnapshot(invocation
      ? { source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: { ambientOnly: true }, settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(ambientCredentials.token) }
      : sourceSnapshot);
    const ambientBefore = getActiveAccountSettingsSnapshot();
    const refresh = () => runWithServerHttpBaseUrl(invocation ? 'https://unrelated-home.example' : 'https://import-home.example', () =>
      refreshSavedSecretCatalogForOperation({ expectedScopeKey: scopeKey, refreshCatalog: true, operationContext }));
    await refresh();
    if (invalidActiveConnected || partialNotification || partialRemoteHost) {
      expect(applied).toHaveLength(0);
      expect(axios.post).not.toHaveBeenCalled();
      expect(operationContext?.readSnapshot()?.rawSettings).toEqual(raw);
      expect(operationContext?.readSnapshot()?.savedSecretLegacyImport).toMatchObject({ status: 'pending' });
      return;
    }
    expect(applied).toHaveLength(1);
    expect(applied[0]!.referenceCensus).toMatchObject({ catalogs: {
      mcp: 'absent', acp: 'absent', providerConnections: 'absent',
      connectedConfigurations: activeConnected ? 5 : 'absent', connectedPurposes: activeConnected ? 6 : 'absent',
    } });
    expect(applied[0]!.referenceCensus).toMatchObject({
      remoteHosts: { revision: activeReferenceCatalogs ? 8 : 'absent', resourceRefs: activeReferenceCatalogs ? [inheritedRef] : [] },
      notificationChannels: { revision: activeReferenceCatalogs ? 9 : 'absent', resourceRefs: activeReferenceCatalogs ? [inheritedRef] : [] },
    });
    const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: 'import-account',
      source: inference ? { kind: 'legacy-inference-openai-key' } : { kind: 'personal-saved-secret', secretId: legacy.id } });
    const ref = `happier:shared-secret:v1:${resourceId}`;
    if (nativeArtifact) expect(applied[0]!.profileMutations[0]!.artifactRevision).toEqual({ artifactId: 'selected', headerVersion: 2, bodyVersion: 4 });
    if (inheritedArtifactBindings) {
      const rowMutation = applied[0]!.profileMutations[0]!;
      expect(rowMutation.referencedSavedSecretIds).toEqual(expect.arrayContaining([inheritedRef, ref]));
      expect(rowMutation.referencedSavedSecretIds).toHaveLength(2);
      expect(rowMutation.referencedSavedSecretIds).not.toContain(maskedRef);
      expect(rowMutation.savedSecretRevisions).toEqual(expect.arrayContaining([
        { resourceId, expectedRevision: 1 }, { resourceId: 'inherited', expectedRevision: 7 },
      ]));
    }
    if (inference) {
      expect(raw).toEqual({ preferredLanguage: 'fr', futureSibling: { preserve: true } });
      expect(applied[0]!.profileMutations).toEqual([]);
    } else expect(raw).toMatchObject({ secrets: retainFuture ? [future] : [],
      ...(nativeArtifact ? {} : { secretBindingsByProfileId: { 'builtin-default': { TOKEN: ref } } }),
      futureSibling: { preserve: true } });
    const snapshot = operationContext ? operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('missing_import_snapshot');
    expect(snapshot.settingsVersion).toBe(5);
    expect(createSavedSecretMaterializerFromSnapshotV1(snapshot, operationContext
      ? { isCurrent: () => operationContext.readSnapshot() === snapshot } : undefined).resolve(ref))
      .toMatchObject({ status: 'ready', value: 'fixture-private' });
    if (operationContext) {
      expect(getActiveAccountSettingsSnapshot()).toBe(ambientBefore);
      expect(snapshot.profileCatalog).toMatchObject(nativeArtifact ? { status: 'ready', source: 'destination', referenceGuardRevision: 4,
        records: [{ revision: 3, record: { secretBindings: { TOKEN: ref } } }] }
        : { status: 'ready', source: inference ? 'destination' : 'legacy', referenceGuardRevision: 3 });
      if (nativeArtifact) expect(artifactBody).toContain(legacy.id);
    }
    expect(historyMutations).toHaveLength(historyRetry ? 0 : 1);
    if (historyRetry) {
      expect(snapshot.savedSecretLegacyImport).toEqual({ status: 'pending', reason: 'history-pending' });
      operationContext?.withdrawCatalog();
      // A new controller invocation has only the current durable source and
      // resource rows; no call-local transfer proof survives this restart.
      operationContext = createInvocationSavedSecretOperationContextV1({ credentials,
        snapshot: { ...sourceSnapshot, settings: AccountSettingsSchema.parse(raw), rawSettings: raw, settingsVersion: version },
        serverHttpBaseUrl: 'https://import-home.example', isCurrent: async () => true });
    }
    if (operationContext) expect(getActiveAccountSettingsSnapshot()).toBe(ambientBefore);
    await refresh();
    expect(applied).toHaveLength(1);
    expect(historyMutations).toHaveLength(1);
    expect(historyMutations[0]?.operation).toMatchObject({ kind: 'normalize', removedRoots: activeConnected
      ? ['connectedAccountServiceConfigurationsV1', 'connectedAccountPurposeBindingsV1'] : [],
      savedSecretTransfers: [{ ...(inference ? { source: { kind: 'legacy-inference-openai-key' } } : { savedSecretId: legacy.id }), resourceId, expectedRevision: 1 }] });
    if (inference) {
      const historical = retained?.t === 'plain' ? retained.v : retained?.t === 'encrypted' && material
        ? openAccountScopedBlobCiphertext({ kind: 'account_settings', material, ciphertext: retained.c })?.value : null;
      expect(historical).toEqual({ preferredLanguage: 'fr', futureSibling: { preserve: true } });
    }
    expect(operationContext?.readSnapshot()?.savedSecretLegacyImport ?? getActiveAccountSettingsSnapshot()?.savedSecretLegacyImport)
      .toEqual(retainFuture ? { status: 'pending', reason: 'source-uncharacterized' } : { status: 'complete' });
  });
});
