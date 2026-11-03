import type { SavedSecretOperationContextV1 } from './savedSecretOperationContext';
import {
  readRequestedSavedSecretOperationReferences,
  readSavedSecretCatalogForOperation,
  captureSavedSecretReferencesForOperation,
  type SavedSecretCatalogRefreshInputV1,
} from './savedSecretCatalogRead';
import axios from 'axios';
import { isDeepStrictEqual } from 'node:util';

import { sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1";
import { decryptSecretValueWithKeysV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { sealSavedSecretResourceStoredContentV1, SavedSecretResourceContentV1Schema, type SavedSecretResourceSourceV1, type SavedSecretResourceContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { deriveSavedSecretImportResourceIdV1, promoteProfileEnvironmentVariableSavedSecretReferenceV1, promotePersonalSavedSecretReference,
  promoteLegacyInferenceSavedSecretReferenceV1,
  promoteLegacyVoiceSavedSecretReferenceV1,
  readSavedSecretTransferSourceV1,
  listSavedSecretReferenceCatalogRefsV1,
  rewriteSavedSecretReferenceCatalogsV1,
  type SavedSecretReferenceCatalogsV1,
  type SavedSecretReferenceRewriteResultV1,
  type SavedSecretLegacyChatCredentialV1,
  type SavedSecretLegacyVoiceCredentialV1,
  type SavedSecretImportSourceV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { openMcpServerCatalogContentV1, sealMcpServerCatalogContentV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { openAcpCatalogContentV1, sealAcpCatalogContentV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { openProviderConnectionsContentV1, sealProviderConnectionsContentV1, type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { openConnectedAccountCatalogContentV1, sealConnectedAccountCatalogContentV1, type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { openRemoteHostCatalogContentV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { openNotificationChannelCatalogContentV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import type { ProfileCatalogRecordV1, ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';

import { loadPromptLibraryCatalogV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';

import { loadAiLaunchProfileArtifacts, resolveProfileCatalogAuthorityV1, removeTransferredProfileSourcesV1, listTransferredProfileIdsV1,
  readEffectiveProfileSecretBindingsV1 } from '@happier-dev/protocol/profiles/read';
import { AccountSettingsSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import { SavedSecretSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import type { SavedSecret } from '@happier-dev/protocol';
import { sealProfileRecordContentV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { deriveAccountMachineKeyFromRecoverySecret, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import tweetnacl from 'tweetnacl';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import { SharedSavedSecretPromoteInputV1Schema, SharedSavedSecretPromoteOutputV1Schema,
  SharedSavedSecretCreateInputV1Schema, type SharedSavedSecretCreateInputV1,
  type SavedSecretReferenceCensusV1, type SavedSecretCatalogMutationsV1,
} from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';

import { encodeBase64, getRandomBytes } from "@/api/encryption";
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { prepareAccountSettingsV2Content, parseSettingsFromContent } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { normalizeCliAccountSettingsHistoryAfterTransfer } from '@/settings/accountSettings/accountSettingsHistoryNormalization';
import type { AccountSettingsHistorySavedSecretTransferV1 } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { hasUsableAccountSettingsEncryptionMaterial } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliProfileStore, createCliProfileStoreForOperation } from '@/settings/profiles/profileStore';
import { createCliProviderConnectionsStore, createCliProviderConnectionsStoreForOperation } from '@/providers/settings/catalogStore';
import { createCliConnectedAccountCatalogStore } from '@/settings/connectedAccounts/connectedAccountCatalogStore';
import { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import { openPromptLibraryContentV1, sealPromptLibraryContentV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { deriveSettingsSecretsReadKeysForCredentials } from './settingsSecretsKey';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';

import { readStoredCredentials, type StoredCredentials } from '@/persistence';

import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, type ActiveAccountSettingsSnapshot, commitActiveAccountSettingsSnapshot, commitActiveSavedSecretLegacyImport } from "@/settings/accountSettings/activeAccountSettingsSnapshot";
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

import { createSavedSecretMaterializerFromSnapshotV1, type SavedSecretLegacyImportResultV1 } from "./savedSecretCatalog";
export { savedSecretOperationAdmissionStatus } from './savedSecretCatalog';
export type { SavedSecretOperationAdmissionFailureReason } from './savedSecretCatalog';
export type { SavedSecretLegacyImportResultV1 } from './savedSecretCatalog';
type SharedSavedSecretPromoteInputV1 = ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>;

export async function refreshSavedSecretCatalogForOperation(input: SavedSecretCatalogRefreshInputV1): Promise<ActiveAccountSettingsSnapshot> {
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const result = await importLegacySavedSecretsForOperation(input);
  const observedSourceVersion = (input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot())?.settingsVersion;
  const refreshed = await readSavedSecretCatalogForOperation(input);
  const currentResult: SavedSecretLegacyImportResultV1 = observedSourceVersion === refreshed.settingsVersion
    ? result : { status: 'pending', reason: 'source-unavailable' };
  const committed = input.operationContext
    ? await input.operationContext.commitLegacyImportResult({ expectedSettingsVersion: refreshed.settingsVersion, result: currentResult })
    : commitActiveSavedSecretLegacyImport({ scopeKey: input.expectedScopeKey, lifetimeToken,
      expectedSettingsVersion: refreshed.settingsVersion, result: currentResult });
  const snapshot = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
  if (!committed || !snapshot) throw new Error('saved_secret_account_lifetime_changed');
  return snapshot;
}

type SavedSecretDomainReferenceCatalogsV1 = Pick<SavedSecretReferenceCatalogsV1,
  'mcp' | 'acp' | 'providerConnections' | 'connectedConfigurations' | 'connectedPurposes' | 'registrySources'>;
type SavedSecretDomainReferenceCensusV1 = Record<keyof SavedSecretDomainReferenceCatalogsV1, number | 'absent'>;
type SavedSecretSourceReferenceCatalogsV1 = SavedSecretDomainReferenceCatalogsV1 & Pick<SavedSecretReferenceCatalogsV1,
  'remoteHostRecords' | 'notificationChannels'>;

/** Capture raw rows only: absence retains the source adapter; deletion suppresses it. */
export async function captureSavedSecretReferenceCatalogsForOperation(input: Readonly<{
  credentials: StoredCredentials;
  operationContext?: SavedSecretOperationContextV1;
  signal?: AbortSignal;
}>): Promise<Readonly<{ catalogs: SavedSecretSourceReferenceCatalogsV1; census: SavedSecretDomainReferenceCensusV1;
  remoteHosts: NonNullable<SavedSecretReferenceCensusV1['remoteHosts']>;
  notificationChannels: NonNullable<SavedSecretReferenceCensusV1['notificationChannels']> }>> {
  const context = input.operationContext;
  if (context && (context.credentials.token !== input.credentials.token || !await context.isCurrent())) {
    throw new Error('saved_secret_account_lifetime_changed');
  }
  input.signal?.throwIfAborted();
  // Catalog readers consume secret admission; load their transports only for
  // this cross-catalog capture, after the Account operation has been admitted.
  const [{ createCliMcpServerStore, createCliMcpServerStoreForOperation },
    { createCliAcpCatalogStore }, { createCliRemoteHostStore, createCliRemoteHostStoreForOperation },
    { createCliNotificationChannelStore }] = await Promise.all([
    import('@/settings/mcp/mcpServerStore'), import('@/agent/acp/catalog/acpCatalogStore'),
    import('@/settings/remoteHosts/remoteHostStore'), import('@/settings/notifications/notificationChannelStore'),
  ]);
  input.signal?.throwIfAborted();
  const mcp = context ? createCliMcpServerStoreForOperation({ operationContext: context, signal: input.signal }) : createCliMcpServerStore(input);
  const acp = createCliAcpCatalogStore(input);
  const providers = context ? createCliProviderConnectionsStoreForOperation({ operationContext: context, signal: input.signal }) : createCliProviderConnectionsStore(input);
  const connected = createCliConnectedAccountCatalogStore(input);
  const remoteHosts = context ? createCliRemoteHostStoreForOperation({ operationContext: context, signal: input.signal }) : createCliRemoteHostStore(input);
  const notifications = createCliNotificationChannelStore(input);
  const prompts = createCliPromptLibraryStore(input);
  const storage = await mcp.readStorageContext();
  const otherStorage = await Promise.all([acp.readStorageContext(), providers.readStorageContext(), connected.readStorageContext(),
    remoteHosts.readStorageContext(), notifications.readStorageContext(), prompts.readStorageContext()]);
  if (otherStorage.some(value => value.mode !== storage.mode || !isDeepStrictEqual(value.material, storage.material))) {
    throw new Error('saved_secret_account_mode_or_identity_changed');
  }
  const [mcpRow, acpRow, providerRow, configurationRow, purposeRow, remoteHostRow, notificationRow, registryRow] = await Promise.all([
    mcp.readRow(), acp.readRow(), providers.readRow(), connected.readRow('configurations'), connected.readRow('purposes'),
    remoteHosts.readRow(), notifications.readRow(), prompts.readRow('registry-sources'),
  ]);
  const catalogs: { -readonly [Key in keyof SavedSecretSourceReferenceCatalogsV1]: SavedSecretSourceReferenceCatalogsV1[Key] } = {};
  const census: SavedSecretDomainReferenceCensusV1 = { mcp: 'absent', acp: 'absent', providerConnections: 'absent',
    connectedConfigurations: 'absent', connectedPurposes: 'absent', registrySources: 'absent' };
  if (mcpRow.status === 'deleted') { census.mcp = mcpRow.revision; catalogs.mcp = null; }
  else if (mcpRow.status === 'present') {
    const opened = openMcpServerCatalogContentV1({ ...storage, content: mcpRow.content });
    if (opened.status !== 'opened') throw new Error('saved_secret_reference_catalog_unavailable');
    census.mcp = mcpRow.revision; catalogs.mcp = opened.catalog;
  } else if (mcpRow.status !== 'absent') throw new Error('saved_secret_reference_catalog_unavailable');
  if (acpRow.status === 'deleted') { census.acp = acpRow.revision; catalogs.acp = null; }
  else if (acpRow.status === 'present') {
    const opened = openAcpCatalogContentV1({ ...storage, content: acpRow.content });
    if (opened.status !== 'opened') throw new Error('saved_secret_reference_catalog_unavailable');
    census.acp = acpRow.revision; catalogs.acp = opened.record;
  } else if (acpRow.status !== 'absent') throw new Error('saved_secret_reference_catalog_unavailable');
  if (providerRow.status === 'deleted') { census.providerConnections = providerRow.revision; catalogs.providerConnections = null; }
  else if (providerRow.status === 'present') {
    const opened = openProviderConnectionsContentV1({ ...storage, content: providerRow.content });
    if (opened.status !== 'opened') throw new Error('saved_secret_reference_catalog_unavailable');
    census.providerConnections = providerRow.revision; catalogs.providerConnections = opened.catalog;
  } else if (providerRow.status !== 'absent') throw new Error('saved_secret_reference_catalog_unavailable');
  for (const [key, row] of [['configurations', configurationRow], ['purposes', purposeRow]] as const) {
    const domain = key === 'configurations' ? 'connectedConfigurations' : 'connectedPurposes';
    if (row.status === 'deleted') {
      census[domain] = row.revision;
      if (key === 'configurations') catalogs.connectedConfigurations = null; else catalogs.connectedPurposes = null;
    } else if (row.status === 'present') {
      const opened = openConnectedAccountCatalogContentV1({ ...storage, key, content: row.content });
      if (opened.status !== 'opened') throw new Error('saved_secret_reference_catalog_unavailable');
      census[domain] = row.revision;
      if (opened.record.key === 'configurations') catalogs.connectedConfigurations = opened.record.value;
      else catalogs.connectedPurposes = opened.record.value;
    } else if (row.status !== 'absent') throw new Error('saved_secret_reference_catalog_unavailable');
  }
  let remoteHostRevision: NonNullable<SavedSecretReferenceCensusV1['remoteHosts']>['revision'] = 'absent';
  if (remoteHostRow.status === 'deleted') { remoteHostRevision = remoteHostRow.revision; catalogs.remoteHostRecords = null; }
  else if (remoteHostRow.status === 'present') {
    const opened = openRemoteHostCatalogContentV1({ ...storage, content: remoteHostRow.content });
    if (opened.status !== 'ready') throw new Error('saved_secret_reference_catalog_unavailable');
    remoteHostRevision = remoteHostRow.revision; catalogs.remoteHostRecords = opened.hosts;
  } else if (remoteHostRow.status !== 'absent') throw new Error('saved_secret_reference_catalog_unavailable');
  let notificationRevision: NonNullable<SavedSecretReferenceCensusV1['notificationChannels']>['revision'] = 'absent';
  if (notificationRow.status === 'deleted') { notificationRevision = notificationRow.revision; catalogs.notificationChannels = null; }
  else if (notificationRow.status === 'present') {
    const opened = openNotificationChannelCatalogContentV1({ ...storage, content: notificationRow.content });
    if (opened.status !== 'opened') throw new Error('saved_secret_reference_catalog_unavailable');
    notificationRevision = notificationRow.revision; catalogs.notificationChannels = opened.record;
  } else if (notificationRow.status !== 'absent') throw new Error('saved_secret_reference_catalog_unavailable');
  if (registryRow.status === 'deleted') { census.registrySources = registryRow.revision; catalogs.registrySources = null; }
  else if (registryRow.status === 'present') {
    const opened = openPromptLibraryContentV1({ ...storage, key: 'registry-sources', content: registryRow.content });
    if (opened.status !== 'opened' || opened.record.key !== 'registry-sources') throw new Error('saved_secret_reference_catalog_unavailable');
    census.registrySources = registryRow.revision; catalogs.registrySources = opened.record.value;
  } else if (registryRow.status !== 'absent') throw new Error('saved_secret_reference_catalog_unavailable');
  const references = listSavedSecretReferenceCatalogRefsV1({ ...catalogs, profileRecords: [] });
  if (references.some(reference => reference.owner !== 'registrySource'
    && parseSavedSecretRefV1(reference.secretId).kind !== 'shared_resource')) {
    throw new Error('saved_secret_reference_catalog_unavailable');
  }
  const admitted = await mcp.readStorageContext();
  mcp.assertCurrent(); acp.assertCurrent(); providers.assertCurrent(); connected.assertCurrent(); remoteHosts.assertCurrent();
  await notifications.assertCurrent();
  prompts.assertCurrent();
  if (admitted.mode !== storage.mode || !isDeepStrictEqual(admitted.material, storage.material)
    || context && !await context.isCurrent()) throw new Error('saved_secret_account_mode_or_identity_changed');
  return { catalogs, census,
    remoteHosts: { revision: remoteHostRevision, resourceRefs: [...new Set(references.filter(reference => reference.owner === 'remoteHost').map(reference => reference.secretId))] },
    notificationChannels: { revision: notificationRevision, resourceRefs: [...new Set(references.filter(reference => reference.owner === 'notificationChannel').map(reference => reference.secretId))] } };
}

export type SavedSecretPromotionOperationResultV1 =
  | Readonly<{ status: 'applied'; resourceId: string; settingsVersion: number }>
  | Readonly<{ status: 'conflict' | 'unavailable' | 'invalid' }>
  | Readonly<{ status: 'outcome_unknown'; resourceObserved?: true }>;

type PreparedSavedSecretV1 = Readonly<{ id: string; record: SavedSecret }>;
type CatalogStorageCaptureV1 = Readonly<{ mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null }>;
type SavedSecretReferenceProofCaptureV1 = Awaited<ReturnType<typeof captureSavedSecretReferencesForOperation>>;

/** Select new material in an existing Provider authority in the same transaction. */
export async function promoteSavedSecretWithProviderConnectionsCatalog(input: Readonly<{
  credentials: StoredCredentials;
  preparedSavedSecret: PreparedSavedSecretV1;
  providerConnections: Readonly<{ expectedRevision: number | 'absent'; catalog: ProviderConnectionsCatalogV1; sourceSettingsVersion?: number }>;
  operationContext?: SavedSecretOperationContextV1;
  signal?: AbortSignal;
}>): Promise<SavedSecretPromotionOperationResultV1> {
  if (input.providerConnections.sourceSettingsVersion !== undefined) return { status: 'invalid' };
  if (input.operationContext && !input.operationContext.readSnapshot()) return { status: 'unavailable' };
  const store = input.operationContext ? createCliProviderConnectionsStoreForOperation({ operationContext: input.operationContext, signal: input.signal })
    : createCliProviderConnectionsStore(input);
  return promotePreparedSavedSecretsWithCatalog({ ...input, preparedSavedSecrets: [input.preparedSavedSecret],
    expectedRevision: input.providerConnections.expectedRevision,
    catalogs: { profileRecords: [], providerConnections: input.providerConnections.catalog },
    readStorageContext: store.readStorageContext, assertCurrent: store.assertCurrent,
    readRevision: async storage => {
      const row = await store.readRow();
      if (row.status === 'absent') return 'absent';
      if (row.status === 'deleted') return row.revision;
      if (row.status !== 'present') throw new Error('saved_secret_reference_catalog_unavailable');
      const opened = openProviderConnectionsContentV1({ ...storage, content: row.content });
      if (opened.status !== 'opened') throw new Error('saved_secret_reference_catalog_unavailable');
      assertSharedSavedSecretCatalogReferences({ profileRecords: [], providerConnections: opened.catalog });
      return row.revision;
    },
    sealCatalog: (catalogs, storage, capture, expectedRevision) => {
      if (!catalogs.providerConnections) throw new Error('saved_secret_reference_catalog_unavailable');
      return { providerConnections: { expectedRevision, ...capture,
        content: sealProviderConnectionsContentV1({ ...storage, catalog: catalogs.providerConnections }) } };
    },
    census: expectedRevision => ({ providerConnections: expectedRevision }),
  });
}

/** Connected-account selection is one resource batch plus one typed row CAS. */
export async function promoteSavedSecretsWithConnectedAccountCatalog(input: Readonly<{
  credentials: StoredCredentials;
  preparedSavedSecrets: readonly PreparedSavedSecretV1[];
  connectedAccountCatalog: Readonly<{ expectedRevision: number | 'absent'; record: ConnectedAccountCatalogRecordV1; sourceSettingsVersion?: number }>;
  operationContext?: SavedSecretOperationContextV1;
  signal?: AbortSignal;
  authorizeRequest?: (request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>): Promise<SavedSecretPromotionOperationResultV1> {
  if (input.connectedAccountCatalog.sourceSettingsVersion !== undefined) return { status: 'invalid' };
  if (input.operationContext && !input.operationContext.readSnapshot()) return { status: 'unavailable' };
  const store = createCliConnectedAccountCatalogStore(input);
  const { record } = input.connectedAccountCatalog;
  const catalogs: SavedSecretReferenceCatalogsV1 = record.key === 'configurations'
    ? { profileRecords: [], connectedConfigurations: record.value } : { profileRecords: [], connectedPurposes: record.value };
  return promotePreparedSavedSecretsWithCatalog({ ...input, catalogs,
    expectedRevision: input.connectedAccountCatalog.expectedRevision,
    readStorageContext: store.readStorageContext, assertCurrent: store.assertCurrent,
    readRevision: async storage => {
      const row = await store.readRow(record.key);
      if (row.status === 'absent') return 'absent';
      if (row.status === 'deleted') return row.revision;
      if (row.status !== 'present') throw new Error('saved_secret_reference_catalog_unavailable');
      const opened = openConnectedAccountCatalogContentV1({ ...storage, key: record.key, content: row.content });
      if (opened.status !== 'opened') throw new Error('saved_secret_reference_catalog_unavailable');
      assertSharedSavedSecretCatalogReferences(opened.record.key === 'configurations'
        ? { profileRecords: [], connectedConfigurations: opened.record.value } : { profileRecords: [], connectedPurposes: opened.record.value });
      return row.revision;
    },
    sealCatalog: (catalogs, storage, capture, expectedRevision) => {
      if (record.key === 'configurations') {
        if (!catalogs.connectedConfigurations) throw new Error('saved_secret_reference_catalog_unavailable');
        return { connectedConfigurations: { expectedRevision, ...capture, content: sealConnectedAccountCatalogContentV1({ ...storage,
          record: { key: record.key, value: catalogs.connectedConfigurations } }) } };
      }
      if (!catalogs.connectedPurposes) throw new Error('saved_secret_reference_catalog_unavailable');
      return { connectedPurposes: { expectedRevision, ...capture, content: sealConnectedAccountCatalogContentV1({ ...storage,
        record: { key: record.key, value: catalogs.connectedPurposes } }) } };
    },
    census: expectedRevision => record.key === 'configurations'
      ? { connectedConfigurations: expectedRevision } : { connectedPurposes: expectedRevision },
  });
}

function assertSharedSavedSecretCatalogReferences(catalogs: SavedSecretReferenceCatalogsV1): void {
  if (listSavedSecretReferenceCatalogRefsV1(catalogs).some(reference => parseSavedSecretRefV1(reference.secretId).kind !== 'shared_resource')) {
    throw new Error('saved_secret_reference_catalog_unavailable');
  }
}

async function promotePreparedSavedSecretsWithCatalog(input: Readonly<{
  credentials: StoredCredentials; preparedSavedSecrets: readonly PreparedSavedSecretV1[];
  expectedRevision: number | 'absent'; catalogs: SavedSecretReferenceCatalogsV1;
  operationContext?: SavedSecretOperationContextV1; signal?: AbortSignal;
  authorizeRequest?: (request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
  assertCurrent(): void;
  readStorageContext(): Promise<CatalogStorageCaptureV1>;
  readRevision(storage: CatalogStorageCaptureV1): Promise<number | 'absent'>;
  sealCatalog(catalogs: SavedSecretReferenceCatalogsV1, storage: CatalogStorageCaptureV1,
    capture: SavedSecretReferenceProofCaptureV1, expectedRevision: number): SavedSecretCatalogMutationsV1;
  census(expectedRevision: number): Partial<SavedSecretDomainReferenceCensusV1>;
}>): Promise<SavedSecretPromotionOperationResultV1> {
  if (input.expectedRevision === 'absent' || input.preparedSavedSecrets.length === 0) return { status: 'invalid' };
  const context = input.operationContext;
  const scopeKey = resolveAccountSettingsScopeKeyForToken(input.credentials.token);
  const accountId = readAccountIdFromToken(input.credentials.token);
  try {
    if (!accountId || context && (context.credentials.token !== input.credentials.token || !await context.isCurrent())) return { status: 'unavailable' };
    const storage = await input.readStorageContext();
    if (await input.readRevision(storage) !== input.expectedRevision) return { status: 'conflict' };
    const snapshot = context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
    if (!snapshot || snapshot.scopeKey !== scopeKey) return { status: 'unavailable' };
    const records = input.preparedSavedSecrets.map(secret => {
      const record = SavedSecretSchema.parse(secret.record);
      if (record.id !== secret.id) throw new Error('saved_secret_prepared_identity_changed');
      return record;
    });
    if (new Set(records.map(record => record.id)).size !== records.length) return { status: 'invalid' };
    const staged = { ...snapshot, settings: AccountSettingsSchema.parse({ secrets: records }), rawSettings: { secrets: records },
      settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(input.credentials) };
    const materializer = createSavedSecretMaterializerFromSnapshotV1(staged, {
      isCurrent: () => (context ? context.readSnapshot() : getActiveAccountSettingsSnapshot()) === snapshot,
    });
    let catalogs = input.catalogs;
    const resources = records.map(record => {
      const material = materializer.resolve(record.id);
      if (material.status !== 'ready' || material.source !== 'personal') throw new Error('saved_secret_prepared_material_unavailable');
      const resourceId = deriveSavedSecretImportResourceIdV1({ accountId, source: { kind: 'personal-saved-secret', secretId: record.id } });
      catalogs = rewriteSavedSecretReferenceCatalogsV1(catalogs, record.id, formatSharedSavedSecretRefV1(resourceId));
      return prepareSavedSecretResourceCreateForOperation({ credentials: input.credentials, accountId, accountMode: storage.mode,
        resourceId, displayName: record.name, kind: record.kind, value: material.value });
    });
    const references = [...new Set(listSavedSecretReferenceCatalogRefsV1(catalogs).map(reference => reference.secretId))];
    assertSharedSavedSecretCatalogReferences(catalogs);
    if (resources.some(resource => !references.includes(formatSharedSavedSecretRefV1(resource.resourceId)))) return { status: 'invalid' };
    const newResourceIds = new Set(resources.map(resource => resource.resourceId));
    const baseUrl = context?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
    const existing = await runWithServerHttpBaseUrl(baseUrl, () => captureSavedSecretReferencesForOperation({ expectedScopeKey: scopeKey,
      references: references.filter(ref => { const parsed = parseSavedSecretRefV1(ref); return parsed.kind === 'shared_resource' && !newResourceIds.has(parsed.resourceId); }),
      operationContext: context, signal: input.signal }));
    const capture: SavedSecretReferenceProofCaptureV1 = { referencedSavedSecretIds: references,
      savedSecretRevisions: references.map(ref => {
        const parsed = parseSavedSecretRefV1(ref);
        if (parsed.kind !== 'shared_resource') throw new Error('saved_secret_reference_revision_unavailable');
        if (newResourceIds.has(parsed.resourceId)) return { resourceId: parsed.resourceId, expectedRevision: 1 };
        const proof = existing.savedSecretRevisions.find(candidate => candidate.resourceId === parsed.resourceId);
        if (!proof) throw new Error('saved_secret_reference_revision_unavailable');
        return proof;
      }) };
    const admitted = await input.readStorageContext();
    input.assertCurrent();
    if (admitted.mode !== storage.mode || !isDeepStrictEqual(admitted.material, storage.material)) return { status: 'unavailable' };
    const mutation = SharedSavedSecretPromoteInputV1Schema.parse({ ...resources[0], additionalSavedSecretResources: resources.slice(1),
      nextSettings: null, profileMutations: [], referenceCensus: { scope: 'catalogs', accountMode: admitted.mode, catalogs: input.census(input.expectedRevision) },
      catalogMutations: input.sealCatalog(catalogs, admitted, capture, input.expectedRevision) });
    return await runWithServerHttpBaseUrl(baseUrl, () => promoteSavedSecretResourceForOperation({ expectedScopeKey: scopeKey,
      input: mutation, operationContext: context, signal: input.signal, authorizeRequest: input.authorizeRequest }));
  } catch {
    return { status: 'unavailable' };
  }
}

/** Prepare privately; the incumbent composite transport owns currentness and the only dispatch. */
type SavedSecretPromotionPreparationV1 = Readonly<{
  credentials: StoredCredentials;
  accountId: string;
  accountMode: 'plain' | 'e2ee';
  rawSettings: Readonly<Record<string, unknown>>;
  expectedSettingsVersion: number;
  referenceCensus: SavedSecretReferenceCensusV1;
  referenceCatalogs?: SavedSecretSourceReferenceCatalogsV1;
  profileCatalog: Extract<ProfileCatalogSnapshotV1, { status: 'ready' }>;
  artifactsById?: ReadonlyMap<string, ArtifactSharingResourceV1>;
  savedSecretRevisions?: SharedSavedSecretPromoteInputV1['profileMutations'][number]['savedSecretRevisions'];
  displayName: string;
  kind: SharedSavedSecretPromoteInputV1['kind'];
  randomBytes?: (length: number) => Uint8Array;
  personalSecretId?: string;
}>;

export type SavedSecretSourcePreparationV1 = Omit<SavedSecretPromotionPreparationV1,
  'displayName' | 'kind' | 'randomBytes' | 'personalSecretId'> & Readonly<{
  source: Awaited<ReturnType<ReturnType<typeof createCliProfileStore>['readSourceSnapshot']>>;
  resources: ActiveAccountSettingsSnapshot;
  referenceCatalogs: SavedSecretReferenceCatalogsV1;
  artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
  savedSecretRevisions: NonNullable<SavedSecretPromotionPreparationV1['savedSecretRevisions']>;
}>;

/** The incumbent full-source preparation, without choosing or promoting a candidate. */
export async function captureSavedSecretSourcePreparationForOperation(input: Readonly<{
  credentials: StoredCredentials;
  expectedScopeKey: string;
  operationContext?: SavedSecretOperationContextV1;
  signal?: AbortSignal;
}>): Promise<SavedSecretSourcePreparationV1> {
  const context = input.operationContext;
  const credentials = context?.credentials ?? input.credentials;
  const baseUrl = context?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const readSnapshot = () => context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  const isCurrent = async () => !input.signal?.aborted && (context
    ? await context.isCurrent() && context.readSnapshot()?.scopeKey === input.expectedScopeKey
    : getActiveAccountSettingsSnapshot()?.scopeKey === input.expectedScopeKey
      && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken);
  return runWithServerHttpBaseUrl(baseUrl, async () => {
    if (credentials.token !== input.credentials.token
      || resolveAccountSettingsScopeKeyForToken(credentials.token) !== input.expectedScopeKey || !await isCurrent()) {
      throw new Error('saved_secret_account_lifetime_changed');
    }
    const accountId = readAccountIdFromToken(credentials.token);
    if (!accountId) throw new Error('saved_secret_account_snapshot_unavailable');
    const store = context ? createCliProfileStoreForOperation({ operationContext: context, signal: input.signal })
      : createCliProfileStore({ credentials, signal: input.signal });
    const source = await store.readSourceSnapshot();
    let profileCatalog = await store.readProfileCatalog();
    if (profileCatalog.status !== 'ready' || profileCatalog.source === undefined) {
      throw new Error('saved_secret_profile_catalog_unavailable');
    }
    if (context) {
      const ownerSnapshot = context.readSnapshot();
      if (!ownerSnapshot || !await context.commitProfileCatalog({ expectedSettingsVersion: ownerSnapshot.settingsVersion, catalog: profileCatalog })) {
        throw new Error('saved_secret_profile_catalog_unavailable');
      }
      const publishedCatalog = context.readSnapshot()?.profileCatalog;
      if (publishedCatalog?.status !== 'ready' || publishedCatalog.source === undefined) {
        throw new Error('saved_secret_profile_catalog_unavailable');
      }
      profileCatalog = publishedCatalog;
    }
    const domains = await captureSavedSecretReferenceCatalogsForOperation({ credentials, operationContext: context, signal: input.signal });
    const control = profileCatalog.control?.record ?? null;
    const effectiveSource = control && resolveProfileCatalogAuthorityV1({ rawSettings: source.raw, control }) === 'destination'
      ? removeTransferredProfileSourcesV1(source.raw, listTransferredProfileIdsV1(control)) : source.raw;
    const { createCredentialedAccountArtifactStore } = await import('@/api/artifacts/accountArtifactStore');
    const artifactStore = createCredentialedAccountArtifactStore(credentials);
    const artifactsById = await loadAiLaunchProfileArtifacts([
      ...profileCatalog.records.map(row => row.record), ...(Array.isArray(effectiveSource.profiles) ? effectiveSource.profiles : []),
    ], { read: (id, options) => artifactStore.read(id, options) }, input.signal);
    store.assertCurrent();
    if (!await isCurrent()) throw new Error('saved_secret_account_lifetime_changed');
    const resources = await readSavedSecretCatalogForOperation({ expectedScopeKey: input.expectedScopeKey,
      refreshCatalog: true, signal: input.signal, operationContext: context });
    if (!await isCurrent() || !readSnapshot()) throw new Error('saved_secret_account_lifetime_changed');
    const artifacts = [...artifactsById.values()].map(artifact => {
      if (!artifact.revision || !artifact.access) throw new Error('saved_secret_artifact_census_unavailable');
      return { artifactId: artifact.artifactId, ...artifact.revision };
    });
    const referenceCatalogs = { ...domains.catalogs, profileRecords: profileCatalog.records.map(row => row.record), artifactsById, profileControl: control };
    listSavedSecretReferenceCatalogRefsV1(referenceCatalogs);
    return {
      credentials, accountId, accountMode: source.mode, rawSettings: source.raw, expectedSettingsVersion: source.version,
      source, resources, profileCatalog, artifactsById,
      referenceCatalogs,
      referenceCensus: { accountMode: source.mode, profileTransferRevision: profileCatalog.controlRevision,
        catalogs: domains.census, remoteHosts: domains.remoteHosts, notificationChannels: domains.notificationChannels,
        profiles: { referenceGuardRevision: profileCatalog.referenceGuardRevision,
          rows: [...profileCatalog.records.map(row => ({ id: row.record.id, revision: row.revision })), ...(profileCatalog.tombstones ?? [])] },
        ...(artifacts.length ? { artifacts } : {}) },
      savedSecretRevisions: (resources.savedSecretResources ?? []).map(resource => ({ resourceId: resource.resourceId, expectedRevision: resource.revision })),
    };
  });
}

export function prepareProfileEnvironmentVariableSavedSecretPromotionForOperation(input: SavedSecretPromotionPreparationV1 & Readonly<{
  source: Extract<SavedSecretImportSourceV1, { kind: 'profile-environment-variable' }>;
}>): SharedSavedSecretPromoteInputV1 {
  if (input.profileCatalog.source !== 'legacy' || input.profileCatalog.control?.record.phase === 'active') {
    throw new Error('saved_secret_profile_source_changed');
  }
  if (input.profileCatalog.tombstones?.some(row => row.id === input.source.profileId)) {
    throw new Error('saved_secret_profile_source_deleted');
  }
  const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: input.accountId, source: input.source });
  const promoted = promoteProfileEnvironmentVariableSavedSecretReferenceV1(input.rawSettings,
    { source: input.source, sharedSecretRef: formatSharedSavedSecretRefV1(resourceId) },
    { ...input.referenceCatalogs, profileRows: input.profileCatalog.records, artifactsById: input.artifactsById });
  return prepareSavedSecretPromotion(input, resourceId, promoted);
}

/** Resource preparation is shared by composite Settings and Remote host transactions. */
export function prepareSavedSecretResourceCreateForOperation(input: Readonly<{
  credentials: StoredCredentials; accountId: string; accountMode: 'plain' | 'e2ee';
  resourceId: string; displayName: string; kind: SharedSavedSecretCreateInputV1['kind']; value?: string;
  source?: SavedSecretResourceSourceV1;
  content?: SavedSecretResourceContentV1;
  createdByPlugin?: Readonly<{ pluginId: string; secretId: string }>;
  randomBytes?: (length: number) => Uint8Array;
}>): SharedSavedSecretCreateInputV1 {
  if (readAccountIdFromToken(input.credentials.token) !== input.accountId) throw new Error('saved_secret_account_mode_or_identity_changed');
  const content = input.content ?? SavedSecretResourceContentV1Schema.parse(input.source
    ? { v: 2 as const, name: input.displayName, kind: input.kind, source: input.source,
        ...(input.createdByPlugin ? { createdByPlugin: input.createdByPlugin } : {}) }
    : { v: 1 as const, name: input.displayName, kind: input.kind, value: input.value!,
        ...(input.createdByPlugin ? { createdByPlugin: input.createdByPlugin } : {}) });
  if (input.accountMode === 'plain') return SharedSavedSecretCreateInputV1Schema.parse({
    resourceId: input.resourceId, displayName: input.displayName, kind: input.kind, encryptionMode: 'plain',
    storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: input.resourceId, mode: 'plain', content }),
    keyEnvelopes: [], accountGrants: [], teamGrants: [], groupGrants: [],
  });
  if (!hasUsableAccountSettingsEncryptionMaterial(input.credentials)) throw new Error('saved_secret_encryption_unavailable');
  const encryption = input.credentials.encryption;
  const randomBytes = input.randomBytes ?? getRandomBytes;
  const recipientMachineKey = encryption.type === 'legacy' ? deriveAccountMachineKeyFromRecoverySecret(encryption.secret) : null;
  const resourceDataKey = randomBytes(32);
  try {
    const publicKey = encryption.type === 'dataKey' ? encryption.publicKey : tweetnacl.box.keyPair.fromSecretKey(recipientMachineKey!).publicKey;
    return SharedSavedSecretCreateInputV1Schema.parse({
      resourceId: input.resourceId, displayName: input.displayName, kind: input.kind, encryptionMode: 'e2ee',
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: input.resourceId, mode: 'e2ee', content, resourceDataKey, randomBytes }),
      keyEnvelopes: [{ recipientAccountId: input.accountId,
        encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceDataKey, recipientPublicKey: publicKey, randomBytes })),
        recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) }],
      accountGrants: [], teamGrants: [], groupGrants: [],
    });
  } finally {
    resourceDataKey.fill(0);
    recipientMachineKey?.fill(0);
  }
}

function prepareSavedSecretPromotion(input: SavedSecretPromotionPreparationV1, resourceId: string, promoted: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  value: string;
  profileRows?: readonly ProfileCatalogRecordV1[];
}> & SavedSecretSourceReferenceCatalogsV1): SharedSavedSecretPromoteInputV1 {
  if (readAccountIdFromToken(input.credentials.token) !== input.accountId
    || input.referenceCensus.accountMode !== input.accountMode) {
    throw new Error('saved_secret_account_mode_or_identity_changed');
  }
  const catalog = input.profileCatalog;
  const censusRows = [...catalog.records.map(row => ({ id: row.record.id, revision: row.revision })), ...(catalog.tombstones ?? [])];
  if (catalog.source === undefined || catalog.diagnostics.length > 0
    || catalog.referenceGuardRevision !== input.referenceCensus.profiles.referenceGuardRevision
    || catalog.controlRevision !== (input.referenceCensus.profileTransferRevision ?? 'absent')
    || !isDeepStrictEqual([...censusRows].sort((a, b) => a.id.localeCompare(b.id)),
      [...input.referenceCensus.profiles.rows].sort((a, b) => a.id.localeCompare(b.id)))) {
    throw new Error('saved_secret_profile_census_changed');
  }
  const randomBytes = input.randomBytes ?? getRandomBytes;
  const nextSettings = prepareAccountSettingsV2Content({ credentials: input.credentials,
    raw: promoted.settings, envelopeKind: input.accountMode === 'plain' ? 'plain' : 'encrypted', randomBytes });
  let profileMaterial: AccountScopedCryptoMaterial | null = null;
  const preparedResource = prepareSavedSecretResourceCreateForOperation({ ...input, resourceId, value: promoted.value });
  if (input.accountMode === 'e2ee') profileMaterial = input.credentials.encryption;
  const artifactsById = input.artifactsById ?? new Map();
  const profileMutations = (promoted.profileRows ?? []).flatMap((row, index) => {
      if (row.record === catalog.records[index]?.record) return [];
      const bindings = readEffectiveProfileSecretBindingsV1(row.record, { artifactsById });
      if (bindings === null) throw new Error('saved_secret_profile_artifact_unavailable');
      const references = [...new Set(Object.values(bindings))];
      const artifact = row.record.definition.kind === 'artifact' ? artifactsById.get(row.record.definition.artifactId) : null;
      if (row.record.definition.kind === 'artifact' && !artifact?.revision) throw new Error('saved_secret_profile_artifact_revision_unavailable');
      const artifactRevision = artifact?.revision ? { artifactId: artifact.artifactId, ...artifact.revision } : null;
      const savedSecretRevisions = references.flatMap(ref => {
        const parsed = parseSavedSecretRefV1(ref);
        if (parsed.kind !== 'shared_resource') return [];
        if (parsed.resourceId === resourceId) return [{ resourceId, expectedRevision: 1 }];
        const proofs = input.savedSecretRevisions?.filter(proof => proof.resourceId === parsed.resourceId) ?? [];
        if (proofs.length !== 1) throw new Error('saved_secret_reference_revision_unavailable');
        return [proofs[0]!];
      });
      return [{ id: row.record.id, operation: catalog.source === 'legacy' && catalog.control?.record.phase !== 'active'
        ? 'import' as const : 'update' as const, expectedRevision: row.revision,
        content: sealProfileRecordContentV1({ mode: input.accountMode, material: profileMaterial, record: row.record, randomBytes }),
        referencedSavedSecretIds: references, savedSecretRevisions, artifactRevision }];
    });
  const catalogMutations: SavedSecretCatalogMutationsV1 = {};
  const capture = (key: keyof SavedSecretDomainReferenceCatalogsV1) => {
    const expectedRevision = input.referenceCensus.catalogs?.[key];
    if (typeof expectedRevision !== 'number' || input.referenceCatalogs?.[key] === undefined) {
      throw new Error('saved_secret_reference_catalog_census_changed');
    }
    const references = [...new Set(listSavedSecretReferenceCatalogRefsV1({ profileRecords: [], [key]: promoted[key] })
      .map(reference => reference.secretId))];
    const savedSecretRevisions = references.map(ref => {
      const parsed = parseSavedSecretRefV1(ref);
      if (parsed.kind !== 'shared_resource') throw new Error('saved_secret_reference_revision_unavailable');
      if (parsed.resourceId === resourceId) return { resourceId, expectedRevision: 1 };
      const proofs = input.savedSecretRevisions?.filter(proof => proof.resourceId === parsed.resourceId) ?? [];
      if (proofs.length !== 1) throw new Error('saved_secret_reference_revision_unavailable');
      return proofs[0]!;
    });
    return { expectedRevision, referencedSavedSecretIds: references, savedSecretRevisions };
  };
  const changed = (key: keyof SavedSecretDomainReferenceCatalogsV1) => !isDeepStrictEqual(input.referenceCatalogs?.[key], promoted[key]);
  const storage = { mode: input.accountMode, material: profileMaterial, randomBytes };
  if (promoted.mcp && changed('mcp')) catalogMutations.mcp = { ...capture('mcp'), content: sealMcpServerCatalogContentV1({ ...storage, catalog: promoted.mcp }) };
  if (promoted.acp && changed('acp')) catalogMutations.acp = { ...capture('acp'), content: sealAcpCatalogContentV1({ ...storage, record: promoted.acp }) };
  if (promoted.providerConnections && changed('providerConnections')) catalogMutations.providerConnections = { ...capture('providerConnections'),
    content: sealProviderConnectionsContentV1({ ...storage, catalog: promoted.providerConnections }) };
  if (promoted.connectedConfigurations && changed('connectedConfigurations')) catalogMutations.connectedConfigurations = { ...capture('connectedConfigurations'),
    content: sealConnectedAccountCatalogContentV1({ ...storage, record: { key: 'configurations', value: promoted.connectedConfigurations } }) };
  if (promoted.connectedPurposes && changed('connectedPurposes')) catalogMutations.connectedPurposes = { ...capture('connectedPurposes'),
    content: sealConnectedAccountCatalogContentV1({ ...storage, record: { key: 'purposes', value: promoted.connectedPurposes } }) };
  if (promoted.registrySources && changed('registrySources')) catalogMutations.registrySources = { ...capture('registrySources'),
    content: sealPromptLibraryContentV1({ ...storage, record: { key: 'registry-sources', value: promoted.registrySources } }) };
  return SharedSavedSecretPromoteInputV1Schema.parse({ ...preparedResource,
      expectedSettingsVersion: input.expectedSettingsVersion, nextSettings, referenceCensus: input.referenceCensus, profileMutations,
      ...(input.personalSecretId ? { personalSecretPromotions: [{ personalSecretId: input.personalSecretId, resourceId }] } : {}),
      ...(Object.keys(catalogMutations).length ? { catalogMutations } : {}) });
}

type InlineVoiceTransferReceiptV1 =
  | Readonly<{ kind: 'chat'; credential: SavedSecretLegacyChatCredentialV1 }>
  | Readonly<{ kind: 'voice'; credential: SavedSecretLegacyVoiceCredentialV1 }>;

function readCurrentInlineVoiceReceipt(raw: Readonly<Record<string, unknown>>, receipt: InlineVoiceTransferReceiptV1) {
  const source = readSavedSecretTransferSourceV1(raw);
  return receipt.kind === 'chat' ? source.legacyChatCredential
    : source.legacyVoiceCredentials?.find(credential => isDeepStrictEqual(credential.candidate, receipt.credential.candidate));
}

/** Material demand imports recognized legacy sources, without making partial import a catalog failure. */
export async function importLegacySavedSecretsForOperation(input: SavedSecretCatalogRefreshInputV1): Promise<SavedSecretLegacyImportResultV1> {
  const context = input.operationContext;
  const captured = context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  const raw = captured?.rawSettings;
  if (!raw || !captured || captured.scopeKey !== input.expectedScopeKey || input.signal?.aborted) return { status: 'pending', reason: 'source-unavailable' };
  let sourceFrontier = input.sourceExpectation;
  const matchesSourceFrontier = (source: Readonly<{ mode: 'plain' | 'e2ee'; raw: Readonly<Record<string, unknown>>; version: number }>) =>
    !sourceFrontier || source.mode === sourceFrontier.mode && source.version === sourceFrontier.version
      && isDeepStrictEqual(source.raw, sourceFrontier.raw);
  // A personal-only launch has no Resource demand. Retained-history recovery
  // belongs to the same explicit material demand that observes its destinations.
  if ((raw.secrets === undefined || Array.isArray(raw.secrets) && raw.secrets.length === 0)
    && input.refreshCatalog !== true
    && !input.sourceExpectation
    && !readRequestedSavedSecretOperationReferences(input).some(reference => parseSavedSecretRefV1(reference.ref).kind === 'shared_resource')) {
    return { status: 'complete' };
  }
  let initialSource: ReturnType<typeof readSavedSecretTransferSourceV1>;
  let sourceComplete: boolean;
  try { initialSource = readSavedSecretTransferSourceV1(raw); sourceComplete = initialSource.complete; }
  catch { return { status: 'pending', reason: 'source-uncharacterized' }; }
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const baseUrl = context?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const readSnapshot = () => context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  const ambientIsCurrent = () => !input.signal?.aborted && getActiveAccountSettingsSnapshot()?.scopeKey === input.expectedScopeKey
    && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken;
  const isCurrent = async () => !input.signal?.aborted && (context
    ? await context.isCurrent() && context.readSnapshot()?.scopeKey === input.expectedScopeKey : ambientIsCurrent());
  let pending: SavedSecretLegacyImportResultV1 | null = sourceComplete ? null : { status: 'pending', reason: 'source-uncharacterized' };
  let historyStarted = false;
  const readOnlyReceiptChecks: Array<(refreshMaterial?: true) => Promise<boolean>> = [];
  let capturedControlRevision: number | 'absent' | undefined;
  const transfers: AccountSettingsHistorySavedSecretTransferV1[] = [];
  const verifiedReferences: Array<Readonly<{ source: SavedSecretImportSourceV1; resourceRef: string; revision: number; value: string }>> = [];
  try {
    const credentials = context?.credentials ?? await readStoredCredentials();
    if (!credentials || resolveAccountSettingsScopeKeyForToken(credentials.token) !== input.expectedScopeKey || !await isCurrent()) {
      return { status: 'pending', reason: 'source-unavailable' };
    }
    const accountId = readAccountIdFromToken(credentials.token);
    if (!accountId) return { status: 'pending', reason: 'source-unavailable' };
    const store = context ? createCliProfileStoreForOperation({ operationContext: context, signal: input.signal })
      : runWithServerHttpBaseUrl(baseUrl, () => createCliProfileStore({ credentials, signal: input.signal }));
    let acknowledgedSource: Awaited<ReturnType<typeof store.readSourceSnapshot>> | undefined;
    if (sourceFrontier && !matchesSourceFrontier(await store.readSourceSnapshot())) return { status: 'pending', reason: 'conflict' };
    const admitInlineResourceReceipt = async (receipt: InlineVoiceTransferReceiptV1,
      source: Awaited<ReturnType<typeof store.readSourceSnapshot>>, resources: ActiveAccountSettingsSnapshot, ref: string) => {
      // A structural binding is not an import receipt: prove the original
      // inline carrier against the actual owned Resource, without creating an alias.
      const parsed = parseSavedSecretRefV1(ref);
      const resource = parsed.kind === 'shared_resource'
        ? resources.savedSecretResources?.find(resource => resource.resourceId === parsed.resourceId) : undefined;
      const material = createSavedSecretMaterializerFromSnapshotV1(resources,
        context ? { isCurrent: () => context.readSnapshot() === resources } : undefined).resolve(ref);
      const originalValue = decryptSecretValueWithKeysV1(receipt.credential.encryptedValue,
        source.mode === 'plain' ? [] : deriveSettingsSecretsReadKeysForCredentials(credentials));
      if (!resource || resource.relationship !== 'owner' || resource.ownerAccountId !== accountId
        || resource.capabilities?.use !== true || material.status !== 'ready' || material.source !== 'shared_resource'
        || originalValue === null || material.value !== originalValue) return false;
      const expectedReceipt = readCurrentInlineVoiceReceipt(source.raw, receipt);
      const verify = async (refreshMaterial?: true) => {
        if (refreshMaterial) await readSavedSecretCatalogForOperation({ expectedScopeKey: input.expectedScopeKey,
          refreshCatalog: true, references: [{ ref }], signal: input.signal, operationContext: context });
        const frontier = acknowledgedSource ?? source;
        const readback = await store.readSourceSnapshot();
        if (!await isCurrent() || readback.mode !== frontier.mode || readback.version !== frontier.version
          || !isDeepStrictEqual(readback.raw, frontier.raw)
          || !isDeepStrictEqual(readCurrentInlineVoiceReceipt(readback.raw, receipt), expectedReceipt)) return false;
        const current = readSnapshot();
        if (!current || current.settingsVersion !== frontier.version || !isDeepStrictEqual(current.rawSettings, frontier.raw)) return false;
        const currentResource = current.savedSecretResources?.find(candidate => candidate.resourceId === resource.resourceId);
        const currentMaterial = createSavedSecretMaterializerFromSnapshotV1(current,
          context ? { isCurrent: () => context.readSnapshot() === current } : undefined).resolve(ref);
        return currentResource?.relationship === 'owner' && currentResource.ownerAccountId === accountId
          && currentResource.capabilities?.use === true && currentResource.revision === resource.revision
          && currentResource.encryptionMode === resource.encryptionMode
          && currentMaterial.status === 'ready' && currentMaterial.source === 'shared_resource'
          && currentMaterial.value === originalValue && currentMaterial.fingerprint === material.fingerprint;
      };
      if (!await verify()) return false;
      readOnlyReceiptChecks.push(verify);
      return true;
    };
    const chat = initialSource.legacyChatCredential;
    const readOnlyReceipts: InlineVoiceTransferReceiptV1[] = [
      ...(chat?.source.kind === 'existing-resource-reference' ? [{ kind: 'chat' as const, credential: chat }] : []),
      ...(initialSource.legacyVoiceCredentials ?? []).filter(credential => credential.source.kind === 'existing-resource-reference')
        .map(credential => ({ kind: 'voice' as const, credential })),
    ];
    for (const receipt of readOnlyReceipts) {
      const source = await store.readSourceSnapshot();
      if (source.version !== captured.settingsVersion || !isDeepStrictEqual(source.raw, raw)
        || !isDeepStrictEqual(readCurrentInlineVoiceReceipt(source.raw, receipt), receipt.credential)
        || receipt.credential.source.kind !== 'existing-resource-reference') {
        return { status: 'pending', reason: 'conflict' };
      }
      const ref = receipt.credential.source.resourceRef;
      const resources = await readSavedSecretCatalogForOperation({ expectedScopeKey: input.expectedScopeKey,
        refreshCatalog: true, references: [{ ref }], signal: input.signal, operationContext: context });
      if (!await admitInlineResourceReceipt(receipt, source, resources, ref)) {
        return { status: 'pending', reason: 'source-uncharacterized' };
      }
    }
    const personalVoiceReceipts = (initialSource.legacyVoiceCredentials ?? []).filter(credential => credential.source.kind === 'personal-saved-secret');
    const voicePersonalIds = new Set(personalVoiceReceipts.flatMap(credential => credential.source.kind === 'personal-saved-secret' ? [credential.source.secretId] : []));
    const candidates = [...initialSource.secrets.filter(secret => !voicePersonalIds.has(secret.id)).map(secret => ({ kind: 'personal' as const, secret })),
      ...(initialSource.inferenceCredential ? [{ kind: 'inference' as const, credential: initialSource.inferenceCredential }] : []),
      ...(chat?.source.kind === 'personal-saved-secret' ? [{ kind: 'chat' as const, credential: chat }] : []),
      ...personalVoiceReceipts.map(credential => ({ kind: 'voice' as const, credential }))];
    for (const candidate of candidates) {
      const preparation = await captureSavedSecretSourcePreparationForOperation({ credentials,
        expectedScopeKey: input.expectedScopeKey, operationContext: context, signal: input.signal });
      const { source, profileCatalog: catalog, resources, referenceCatalogs } = preparation;
      if (!matchesSourceFrontier(source)) { pending = { status: 'pending', reason: 'conflict' }; break; }
      if (capturedControlRevision !== undefined && capturedControlRevision !== catalog.controlRevision) {
        pending = { status: 'pending', reason: 'conflict' }; break;
      }
      capturedControlRevision ??= catalog.controlRevision;
      const currentSource = readSavedSecretTransferSourceV1(source.raw);
      const inline: InlineVoiceTransferReceiptV1 | null = candidate.kind === 'chat' ? { kind: 'chat', credential: candidate.credential }
        : candidate.kind === 'voice' ? { kind: 'voice', credential: candidate.credential } : null;
      if (inline) {
        const currentReceipt = readCurrentInlineVoiceReceipt(source.raw, inline);
        if (!currentReceipt) continue;
        if (!isDeepStrictEqual(currentReceipt, inline.credential) || inline.credential.source.kind !== 'personal-saved-secret') {
          pending = { status: 'pending', reason: 'conflict' }; break;
        }
      }
      const inlinePersonalId = inline?.credential.source.kind === 'personal-saved-secret' ? inline.credential.source.secretId : undefined;
      const legacy = candidate.kind === 'personal' ? currentSource.secrets.find(secret => secret.id === candidate.secret.id)
        : inline?.kind === 'voice' && inlinePersonalId ? currentSource.secrets.find(secret => secret.id === inlinePersonalId) : null;
      const inference = candidate.kind === 'inference' ? currentSource.inferenceCredential : null;
      if (!legacy && !inference && !inline) continue;
      const sourceSnapshot: ActiveAccountSettingsSnapshot = { ...resources, settings: AccountSettingsSchema.parse(source.raw),
        rawSettings: source.raw, settingsVersion: source.version,
        settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials) };
      if (!await isCurrent()) return { status: 'pending', reason: 'source-unavailable' };
      const material = legacy ? createSavedSecretMaterializerFromSnapshotV1(sourceSnapshot, {
        isCurrent: context ? () => !input.signal?.aborted && context.readSnapshot() === resources : ambientIsCurrent,
      }).resolve(legacy.id) : null;
      if (legacy && (material?.status !== 'ready' || material.source !== 'personal')) {
        pending = { status: 'pending', reason: 'source-uncharacterized' }; continue;
      }
      const identity = legacy ? { kind: 'personal-saved-secret' as const, secretId: legacy.id }
        : inline?.credential.source.kind === 'personal-saved-secret' ? inline.credential.source : inference!.source;
      const resourceId = deriveSavedSecretImportResourceIdV1({ accountId, source: identity });
      const ref = formatSharedSavedSecretRefV1(resourceId);
      if (inline?.kind === 'chat' && resources.savedSecretResources?.some(resource => resource.resourceId === resourceId)) {
        if (!await admitInlineResourceReceipt(inline, source, resources, ref)) {
          pending = { status: 'pending', reason: 'source-uncharacterized' };
        }
        continue;
      }
      const value = material?.status === 'ready' ? material.value : inference?.value
        ?? (inline ? decryptSecretValueWithKeysV1(inline.credential.encryptedValue,
          source.mode === 'plain' ? [] : deriveSettingsSecretsReadKeysForCredentials(credentials)) : null);
      if (value === null || value === undefined) { pending = { status: 'pending', reason: 'source-uncharacterized' }; continue; }
      const promoted: SavedSecretReferenceRewriteResultV1 = inline?.kind === 'voice'
        ? promoteLegacyVoiceSavedSecretReferenceV1(source.raw, { credential: inline.credential, sharedSecretRef: ref }, referenceCatalogs)
        : inline?.kind === 'chat' ? { settings: source.raw }
        : legacy ? promotePersonalSavedSecretReference(source.raw,
        { secretId: legacy.id, expectedUpdatedAt: legacy.updatedAt, sharedSecretRef: formatSharedSavedSecretRefV1(resourceId) },
        referenceCatalogs)
        : promoteLegacyInferenceSavedSecretReferenceV1(source.raw, { source: inference!.source, sharedSecretRef: formatSharedSavedSecretRefV1(resourceId) });
      const mutation = prepareSavedSecretPromotion({ ...preparation,
        displayName: legacy?.name ?? inline?.credential.displayName ?? inference!.displayName,
        kind: legacy?.kind ?? inline?.credential.kind ?? inference!.kind,
        ...(legacy ? { personalSecretId: legacy.id } : {}),
      }, resourceId, { ...promoted, value,
        profileRows: promoted.profileRecords?.map((record, index) => ({ record, revision: catalog.records[index]!.revision })) });
      const beforeDispatch = await store.readSourceSnapshot();
      if (beforeDispatch.mode !== source.mode || beforeDispatch.version !== source.version || !isDeepStrictEqual(beforeDispatch.raw, source.raw)) {
        pending = { status: 'pending', reason: 'conflict' }; break;
      }
      const result = await promoteSavedSecretResourceForOperation({ expectedScopeKey: input.expectedScopeKey,
        input: mutation, signal: input.signal, operationContext: context });
      if (result.status !== 'applied') {
        pending = { status: 'pending', reason: result.status === 'outcome_unknown' ? 'outcome-unknown' : result.status === 'conflict' ? 'conflict' : 'source-unavailable' };
        break;
      }
      const readback = await store.readSourceSnapshot();
      if (!mutation.nextSettings) throw new Error('saved_secret_source_readback_unavailable');
      const expected = await parseSettingsFromContent({ credentials, content: mutation.nextSettings, emptyEnvelopeKind: mutation.nextSettings.t });
      if (readback.version !== result.settingsVersion || readback.mode !== source.mode || !isDeepStrictEqual(readback.raw, expected.raw) || !await isCurrent()) {
        pending = { status: 'pending', reason: 'outcome-unknown' }; break;
      }
      const observedSnapshot = readSnapshot();
      if (!observedSnapshot) { pending = { status: 'pending', reason: 'outcome-unknown' }; break; }
      const nextSnapshot: ActiveAccountSettingsSnapshot = { ...observedSnapshot, source: 'network',
        settings: AccountSettingsSchema.parse(readback.raw), rawSettings: readback.raw, settingsVersion: readback.version,
        settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials) };
      if (context) {
        if (!await context.replaceAccountSettings(nextSnapshot)) { pending = { status: 'pending', reason: 'outcome-unknown' }; break; }
      } else commitActiveAccountSettingsSnapshot(nextSnapshot);
      const publishedSource = readSnapshot();
      if (!publishedSource || publishedSource.settingsVersion !== result.settingsVersion
        || !isDeepStrictEqual(publishedSource.rawSettings, expected.raw)) {
        pending = { status: 'pending', reason: 'outcome-unknown' }; break;
      }
      // Advance this invocation's receipt frontier only through our sealed
      // transaction and exact acknowledged source readback, never user churn.
      acknowledgedSource = readback;
      if (sourceFrontier) sourceFrontier = readback;
      verifiedReferences.push({ source: identity, resourceRef: ref, revision: 1, value });
      // The same composite may have replaced native Profile rows. Re-read
      // their canonical projection at the acknowledged Settings frontier;
      // carrying the pre-dispatch rows forward would stale this invocation.
      const publishedCatalog = await store.readProfileCatalog();
      if (publishedCatalog.status !== 'ready' || !await isCurrent()) {
        pending = { status: 'pending', reason: 'outcome-unknown' }; break;
      }
      if (context) {
        if (!await context.commitProfileCatalog({ expectedSettingsVersion: result.settingsVersion, catalog: publishedCatalog })) {
          pending = { status: 'pending', reason: 'outcome-unknown' }; break;
        }
      } else {
        const current = getActiveAccountSettingsSnapshot();
        if (!current || current.settingsVersion !== result.settingsVersion) {
          pending = { status: 'pending', reason: 'outcome-unknown' }; break;
        }
        commitActiveAccountSettingsSnapshot({ ...current, profileCatalog: publishedCatalog });
      }
      if (mutation.catalogMutations?.registrySources) {
        const prompts = createCliPromptLibraryStore({ credentials, operationContext: context, signal: input.signal });
        const storage = await prompts.readStorageContext();
        const publishedPrompts = await loadPromptLibraryCatalogV1({ ...storage, signal: input.signal, readRows: prompts.readRows });
        const acknowledged = publishedPrompts.status === 'ready' || publishedPrompts.status === 'partial'
          ? publishedPrompts.rows.find(row => row.record.key === 'registry-sources') : undefined;
        const expectedRevision = mutation.catalogMutations.registrySources.expectedRevision;
        if (!acknowledged || acknowledged.revision !== (expectedRevision === 'absent' ? 0 : expectedRevision + 1)
          || acknowledged.record.key !== 'registry-sources' || !isDeepStrictEqual(acknowledged.record.value, promoted.registrySources)
          || !await isCurrent()) { pending = { status: 'pending', reason: 'outcome-unknown' }; break; }
        if (context) {
          if (!await context.commitPromptLibraryCatalog({ expectedSettingsVersion: result.settingsVersion, catalog: publishedPrompts })) {
            pending = { status: 'pending', reason: 'outcome-unknown' }; break;
          }
        } else {
          const current = getActiveAccountSettingsSnapshot();
          if (!current || current.settingsVersion !== result.settingsVersion) { pending = { status: 'pending', reason: 'outcome-unknown' }; break; }
          commitActiveAccountSettingsSnapshot({ ...current, promptLibraryCatalog: publishedPrompts });
        }
      }
      if (inline) {
        const admitted = await readSavedSecretCatalogForOperation({ expectedScopeKey: input.expectedScopeKey,
          refreshCatalog: true, references: [{ ref, revision: 1 }], signal: input.signal, operationContext: context });
        if (!await admitInlineResourceReceipt(inline, readback, admitted, ref)) {
          pending = { status: 'pending', reason: 'outcome-unknown' }; break;
        }
      }
      if (inline?.kind !== 'chat') transfers.push(identity.kind === 'personal-saved-secret' ? { savedSecretId: identity.secretId, resourceId, expectedRevision: 1 }
        : { source: identity, resourceId, expectedRevision: 1 });
    }
    if (await isCurrent()) {
      const source = await store.readSourceSnapshot();
      if (!matchesSourceFrontier(source)) return { status: 'pending', reason: 'conflict' };
      const resources = await readSavedSecretCatalogForOperation({ expectedScopeKey: input.expectedScopeKey,
        refreshCatalog: true, signal: input.signal, operationContext: context });
      const materializer = createSavedSecretMaterializerFromSnapshotV1(resources,
        context ? { isCurrent: () => context.readSnapshot() === resources } : undefined);
      const admittedResources = (resources.savedSecretResources ?? []).filter(resource =>
        materializer.resolve(formatSharedSavedSecretRefV1(resource.resourceId)).status === 'ready');
      historyStarted = true;
      const cleanup = await normalizeCliAccountSettingsHistoryAfterTransfer({ credentials, serverBaseUrl: baseUrl,
        isCurrent, signal: input.signal, expectedProfileTransferRevision: capturedControlRevision,
        savedSecretRecovery: { accountId, source: { raw: source.raw, version: source.version }, resources: admittedResources },
        destinationAuthority: { activeTransferredRoots: [], savedSecretTransfers: transfers } });
      if (cleanup.status !== 'complete') pending ??= { status: 'pending', reason: 'history-pending' };
    }
    const retained = readSnapshot()?.rawSettings?.secrets;
    const result: SavedSecretLegacyImportResultV1 = pending ?? (retained === undefined || Array.isArray(retained) && retained.length === 0 ? { status: 'complete' }
      : { status: 'pending', reason: 'source-uncharacterized' });
    if (result.status === 'complete') for (const verify of readOnlyReceiptChecks) {
      if (!await verify(true)) return { status: 'pending', reason: 'conflict' };
    }
    if (result.status === 'complete' && sourceFrontier) {
      if (verifiedReferences.length) {
        const admitted = await readSavedSecretCatalogForOperation({ expectedScopeKey: input.expectedScopeKey,
          refreshCatalog: true, operationContext: context, signal: input.signal,
          references: verifiedReferences.map(reference => ({ ref: reference.resourceRef, revision: reference.revision })) });
        const materializer = createSavedSecretMaterializerFromSnapshotV1(admitted,
          context ? { isCurrent: () => context.readSnapshot() === admitted } : undefined);
        for (const reference of verifiedReferences) {
          const resource = admitted.savedSecretResources?.find(resource => formatSharedSavedSecretRefV1(resource.resourceId) === reference.resourceRef);
          const material = materializer.resolve(reference.resourceRef);
          if (resource?.relationship !== 'owner' || resource.ownerAccountId !== accountId
            || material.status !== 'ready' || material.source !== 'shared_resource' || material.value !== reference.value) {
            return { status: 'pending', reason: 'source-unavailable' };
          }
        }
      }
      if (!matchesSourceFrontier(await store.readSourceSnapshot())) return { status: 'pending', reason: 'conflict' };
      const current = readSnapshot();
      if (!current || current.settingsVersion !== sourceFrontier.version || !isDeepStrictEqual(current.rawSettings, sourceFrontier.raw)) {
        return { status: 'pending', reason: 'conflict' };
      }
      return { status: 'complete', sourceSettingsVersion: sourceFrontier.version,
        ...(verifiedReferences.length ? { verifiedReferences: verifiedReferences.map(({ source, resourceRef, revision }) =>
          ({ source, resourceRef, revision })) } : {}) };
    }
    return result;
  } catch {
    // A retained unsupported source or failed cleanup cannot revoke unrelated,
    // already-admitted resource material. No committed import is replayed here.
    return pending ?? { status: 'pending', reason: transfers.length || historyStarted ? 'history-pending' : 'source-unavailable' };
  }
}

/** One atomic import dispatch; the source owner prepares its exact Settings and Profile CAS. */
export async function promoteSavedSecretResourceForOperation(input: Readonly<{
  expectedScopeKey: string;
  input: SharedSavedSecretPromoteInputV1;
  signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
  authorizeRequest?: (request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>): Promise<SavedSecretPromotionOperationResultV1> {
  const parsed = SharedSavedSecretPromoteInputV1Schema.safeParse(input.input);
  if (!parsed.success) return { status: 'invalid' };
  const mutation = parsed.data;
  const newResources = [mutation, ...(mutation.additionalSavedSecretResources ?? [])];
  const newResourceIds = new Set(newResources.map(resource => resource.resourceId));
  const context = input.operationContext;
  const captured = context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const baseUrl = context?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const isCurrent = async () => !input.signal?.aborted && (context ? await context.isCurrent()
    && context.readSnapshot()?.scopeKey === input.expectedScopeKey
    : getActiveAccountSettingsSnapshot()?.scopeKey === input.expectedScopeKey
      && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken);
  if (!captured || captured.scopeKey !== input.expectedScopeKey || input.signal?.aborted) return { status: 'unavailable' };
  let token: string;
  try {
    const refreshed = await readSavedSecretCatalogForOperation({
      expectedScopeKey: input.expectedScopeKey, refreshCatalog: true, signal: input.signal,
      operationContext: context,
      references: [...mutation.profileMutations, ...Object.values(mutation.catalogMutations ?? {})].flatMap(row => (row.savedSecretRevisions ?? [])
        .filter(resource => !newResourceIds.has(resource.resourceId))
        .map(resource => ({ ref: formatSharedSavedSecretRefV1(resource.resourceId), revision: resource.expectedRevision }))),
    });
    if (!await isCurrent()) return { status: 'unavailable' };
    // A linked, tombstoned or divergent existing identity is never overwritten.
    if (refreshed.savedSecretResources?.some(resource => newResourceIds.has(resource.resourceId))) return { status: 'conflict' };
    const credentials = context?.credentials ?? await readStoredCredentials();
    if (!credentials || resolveAccountSettingsScopeKeyForToken(credentials.token) !== input.expectedScopeKey || !await isCurrent()) {
      return { status: 'unavailable' };
    }
    token = credentials.token;
  } catch {
    return { status: 'unavailable' };
  }
  try {
    input.signal?.throwIfAborted();
    if (!await isCurrent()) return { status: 'unavailable' };
    const request = bindHomeDomainActionHttpRequestV1('secrets.shared.promote', mutation);
    const authorization = input.authorizeRequest ? input.authorizeRequest(request) : { Authorization: `Bearer ${token}` };
    if (!authorization) return { status: 'unavailable' };
    const response = await axios.post(`${baseUrl}${request.path}`, request.body, {
      headers: { ...authorization, ...buildCurrentAccountStoredContentCompatibilityHttpHeaders() },
      signal: input.signal, validateStatus: () => true,
    });
    if (response.status === 409) return { status: 'conflict' };
    if (response.status === 404) return { status: 'unavailable' };
    if (response.status >= 200 && response.status < 300) {
      const result = SharedSavedSecretPromoteOutputV1Schema.safeParse(response.data);
      if (result.success && result.data.resourceId === mutation.resourceId) return { status: 'applied', ...result.data };
    } else if (response.status >= 400 && response.status < 500) return { status: 'invalid' };
  } catch {
    // Once issued, a missing response is not permission to replay the source mutation.
  }
  try {
    if (!await isCurrent()) return { status: 'outcome_unknown' };
    const observed = await readSavedSecretCatalogForOperation({ expectedScopeKey: input.expectedScopeKey, refreshCatalog: true,
      operationContext: context, signal: input.signal });
    if (newResources.every(created => {
      const resource = observed.savedSecretResources?.find(candidate => candidate.resourceId === created.resourceId);
      return resource?.materialStatus === 'ready' && resource.encryptionMode === created.encryptionMode
        && isDeepStrictEqual(resource.storedContent, created.storedContent);
    })) {
      return { status: 'outcome_unknown', resourceObserved: true };
    }
  } catch {
    // Preserve uncertainty while the caller retains its source proof and draft.
  }
  return { status: 'outcome_unknown' };
}

export type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
export { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
export type { HydratedSavedSecretCatalog } from '@/settings/secrets/savedSecretCatalogRead';
export type { SavedSecretOperationReferenceV1 } from '@/settings/secrets/savedSecretCatalogRead';
export { SavedSecretOperationAdmissionError } from '@/settings/secrets/savedSecretCatalogRead';
export { hydrateSavedSecretCatalog } from '@/settings/secrets/savedSecretCatalogRead';
export { readSavedSecretCatalogForOperation } from '@/settings/secrets/savedSecretCatalogRead';
export { captureSavedSecretReferencesForOperation } from '@/settings/secrets/savedSecretCatalogRead';
