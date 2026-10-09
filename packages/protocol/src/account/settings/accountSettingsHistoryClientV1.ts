import { AccountSettingsV2HistoryDetailResponseSchema, AccountSettingsV2HistoryListResponseSchema,
  AccountSettingsV2HistoryMutationRequestSchema, AccountSettingsV2HistoryMutationResponseSchema,
  AccountSettingsHistoryLegacyRoleArtifactTransferV1Schema } from './accountSettingsApiV2.js';
import { LEGACY_ROLE_GUIDANCE_HISTORY_ROOTS_V1, normalizeTransferredAccountSettingsHistoryV1, readAccountSettingsHistorySavedSecretIdV1, type AccountSettingsHistoryDestinationAuthorityV1 } from './accountSettingsHistoryRestoreV1.js';
import { deriveSavedSecretImportResourceIdV1, readSavedSecretTransferSourceV1, type SavedSecretImportSourceV1 } from './savedSecretMutationOwner.js';
import type { SavedSecretCatalogResourceV1 } from './savedSecretCatalogV1.js';
import type { AccountSettingsStoredContentEnvelope } from './accountSettingsStoredContentEnvelope.js';
import type { AccountSettingsPersistedObject } from './accountSettings.js';
import type { AccountEncryptionCurrentnessResponse } from '../encryptionMode.js';
import type { AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema, openProfileTransferContentV1 } from '../../profiles/profileTransferV1.js';
import { PROFILE_TRANSFERRED_SOURCE_ROOTS_V1, listTransferredProfileIdsV1 } from '../../profiles/read.js';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema,
  type PromptLibraryCatalogKeyV1 } from '../../prompts/library/promptLibraryRowsV1.js';
import { loadPromptLibraryCatalogV1, PROMPT_LIBRARY_RETAINED_ROOTS_V1 } from '../../prompts/library/promptLibraryCatalogV1.js';

export type AccountSettingsHistoryCleanupResultV1 = Readonly<{ status: 'complete' }>
  | Readonly<{ status: 'cleanup-pending'; versions: readonly number[] }>;

/** Fresh opened source and admitted current resources, not a persisted import ledger. */
export type AccountSettingsHistorySavedSecretRecoveryV1 = Readonly<{
  accountId: string;
  source: Readonly<{ raw: AccountSettingsPersistedObject; version: number }>;
  resources: readonly Pick<SavedSecretCatalogResourceV1, 'resourceId' | 'ownerAccountId' | 'revision' | 'materialStatus'>[];
}>;

/** Platform adapters supply captured transport, lifetime and existing crypto owners only. */
export type AccountSettingsHistoryClientPortsV1 = Readonly<{
  request(path: string, input: Readonly<{ method: 'GET' | 'POST'; body?: unknown }>): Promise<Readonly<{ status: number; data: unknown }>>;
  readCurrentness(): Promise<AccountEncryptionCurrentnessResponse>;
  isCurrent(): boolean | Promise<boolean>;
  resolveTransferMaterial(mode: 'plain' | 'e2ee'): AccountScopedCryptoMaterial | null | Promise<AccountScopedCryptoMaterial | null>;
  openSnapshot(content: AccountSettingsStoredContentEnvelope): AccountSettingsPersistedObject | Promise<AccountSettingsPersistedObject>;
  resealSnapshot(raw: AccountSettingsPersistedObject, recorded: AccountSettingsStoredContentEnvelope): AccountSettingsStoredContentEnvelope | Promise<AccountSettingsStoredContentEnvelope>;
  unavailable(status: number, message: string): never;
}>;

type CapturePorts = Pick<AccountSettingsHistoryClientPortsV1, 'request' | 'readCurrentness' | 'isCurrent' | 'resolveTransferMaterial' | 'unavailable'>;

async function assertCurrent(ports: CapturePorts): Promise<void> {
  if (!await ports.isCurrent()) ports.unavailable(0, 'Captured Account Settings scope retired');
}

function recoverSavedSecretHistoryAuthority(raw: AccountSettingsPersistedObject,
  authority: AccountSettingsHistoryDestinationAuthorityV1, settingsVersion: number,
  recovery: AccountSettingsHistorySavedSecretRecoveryV1 | undefined,
): AccountSettingsHistoryDestinationAuthorityV1 {
  if (!recovery || recovery.source.version !== settingsVersion) return authority;
  const currentSecrets = recovery.source.raw.secrets;
  let personalSourceComplete = currentSecrets === undefined || Array.isArray(currentSecrets);
  const currentIds = new Set<string>();
  for (const secret of Array.isArray(currentSecrets) ? currentSecrets : []) {
    const id = readAccountSettingsHistorySavedSecretIdV1(secret);
    // Uncharacterized current material cannot prove that a source is absent.
    if (id === null) personalSourceComplete = false;
    else currentIds.add(id);
  }
  const transfers = [...(authority.savedSecretTransfers ?? [])];
  const transferredIds = new Set(transfers.flatMap(transfer => 'savedSecretId' in transfer ? [transfer.savedSecretId] : []));
  const importedResource = (source: SavedSecretImportSourceV1) => {
    const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: recovery.accountId, source });
    return recovery.resources.find(candidate => candidate.resourceId === resourceId
      && candidate.ownerAccountId === recovery.accountId && candidate.materialStatus === 'ready');
  };
  for (const secret of personalSourceComplete && Array.isArray(raw.secrets) ? raw.secrets : []) {
    const id = readAccountSettingsHistorySavedSecretIdV1(secret);
    if (id === null || currentIds.has(id) || transferredIds.has(id)) continue;
    const resource = importedResource({ kind: 'personal-saved-secret', secretId: id });
    if (resource) {
      transfers.push({ savedSecretId: id, resourceId: resource.resourceId, expectedRevision: resource.revision });
      transferredIds.add(id);
    }
  }
  const inference = readSavedSecretTransferSourceV1({ inferenceOpenAIKey: raw.inferenceOpenAIKey }).inferenceCredential;
  const currentInference = readSavedSecretTransferSourceV1({ inferenceOpenAIKey: recovery.source.raw.inferenceOpenAIKey });
  if (inference && currentInference.complete && !currentInference.inferenceCredential
    && !transfers.some(transfer => 'source' in transfer && transfer.source.kind === inference.source.kind)) {
    const resource = importedResource(inference.source);
    if (resource) transfers.push({ source: inference.source, resourceId: resource.resourceId, expectedRevision: resource.revision });
  }
  return transfers.length ? { ...authority, savedSecretTransfers: transfers } : authority;
}

/** Only an actually opened active control grants Profile history authority. */
export async function captureAccountSettingsHistoryDestinationAuthorityV1(input: Readonly<{
  ports: CapturePorts; currentness?: AccountEncryptionCurrentnessResponse;
  destinationAuthority?: AccountSettingsHistoryDestinationAuthorityV1;
}>): Promise<Readonly<{
  expectedProfileTransferRevision: number | 'absent'; authority: AccountSettingsHistoryDestinationAuthorityV1;
}>> {
  const { ports } = input;
  await assertCurrent(ports);
  const response = await ports.request(PROFILE_TRANSFER_ROUTE_V1, { method: 'GET' });
  await assertCurrent(ports);
  if (response.status < 200 || response.status >= 300) ports.unavailable(response.status, 'Profile transfer authority unavailable');
  const control = ProfileTransferRowReadResponseV1Schema.parse(response.data);
  if (control.status !== 'absent' && control.status !== 'deleted' && control.status !== 'present') {
    return ports.unavailable(0, 'Profile transfer authority unavailable');
  }
  const promptRoots = new Set<string>(Object.values(PROMPT_LIBRARY_RETAINED_ROOTS_V1));
  const roots = new Set((input.destinationAuthority?.activeTransferredRoots ?? [])
    .filter(root => root !== 'secrets' && !promptRoots.has(root) && !(PROFILE_TRANSFERRED_SOURCE_ROOTS_V1 as readonly string[]).includes(root)
      && !(LEGACY_ROLE_GUIDANCE_HISTORY_ROOTS_V1 as readonly string[]).includes(root)));
  const legacyRoleArtifactTransfers = input.destinationAuthority?.legacyRoleArtifactTransfers?.map(receipt =>
    AccountSettingsHistoryLegacyRoleArtifactTransferV1Schema.parse(receipt));
  if (legacyRoleArtifactTransfers !== undefined) LEGACY_ROLE_GUIDANCE_HISTORY_ROOTS_V1.forEach(root => roots.add(root));
  let activeTransferredProfileIds: readonly string[] | undefined;
  if (control.status === 'present') {
    const currentness = input.currentness ?? await ports.readCurrentness();
    const opened = openProfileTransferContentV1({ mode: currentness.mode,
      material: await ports.resolveTransferMaterial(currentness.mode), content: control.content });
    await assertCurrent(ports);
    if (opened.status !== 'opened') return ports.unavailable(0, 'Profile transfer authority cannot be opened');
    if (opened.record.phase === 'active') {
      PROFILE_TRANSFERRED_SOURCE_ROOTS_V1.forEach(root => roots.add(root));
      activeTransferredProfileIds = listTransferredProfileIdsV1(opened.record);
    }
  }
  const promptResponse = await ports.request(PROMPT_LIBRARY_ROWS_ROUTE_V1, { method: 'GET' });
  await assertCurrent(ports);
  let activePromptLibraryKeys: readonly PromptLibraryCatalogKeyV1[] | undefined;
  // A supported older Home without this domain cannot have activated its rows.
  if (promptResponse.status !== 404) {
    if (promptResponse.status < 200 || promptResponse.status >= 300) ports.unavailable(promptResponse.status, 'Prompt catalog authority unavailable');
    const currentness = input.currentness ?? await ports.readCurrentness();
    const catalog = await loadPromptLibraryCatalogV1({ mode: currentness.mode,
      material: await ports.resolveTransferMaterial(currentness.mode),
      readRows: async () => PromptLibraryRowsListResponseV1Schema.parse(promptResponse.data) });
    await assertCurrent(ports);
    if (catalog.status !== 'ready' && catalog.status !== 'partial') return ports.unavailable(0, 'Prompt catalog authority cannot be opened');
    activePromptLibraryKeys = [...catalog.rows.map(row => row.record.key), ...catalog.tombstones.map(row => row.key)];
    for (const key of activePromptLibraryKeys) if (key !== 'coding' && key !== 'voice') roots.add(PROMPT_LIBRARY_RETAINED_ROOTS_V1[key]);
  }
  return { expectedProfileTransferRevision: control.status === 'absent' ? 'absent' as const : control.revision,
    authority: { activeTransferredRoots: [...roots], ...(activeTransferredProfileIds === undefined ? {} : { activeTransferredProfileIds }),
      ...(activePromptLibraryKeys === undefined ? {} : { activePromptLibraryKeys }),
      ...(legacyRoleArtifactTransfers === undefined ? {} : { legacyRoleArtifactTransfers }),
      ...(input.destinationAuthority?.savedSecretTransfers ? { savedSecretTransfers: input.destinationAuthority.savedSecretTransfers } : {}) } };
}

/** One post-cleanup pass, including the previous document retained by source CAS. */
export async function normalizeAccountSettingsHistoryClientV1(input: Readonly<{
  ports: AccountSettingsHistoryClientPortsV1; destinationAuthority: AccountSettingsHistoryDestinationAuthorityV1;
  /** Original source-cleanup proof; never substitute a newly captured control. */
  expectedProfileTransferRevision?: number | 'absent';
  savedSecretRecovery?: AccountSettingsHistorySavedSecretRecoveryV1;
}>): Promise<AccountSettingsHistoryCleanupResultV1> {
  const { ports } = input;
  const pending = new Set<number>();
  await assertCurrent(ports);
  const currentness = await ports.readCurrentness();
  const settingsVersion = currentness.settingsVersion;
  if (settingsVersion === undefined) return ports.unavailable(0, 'Settings currentness unavailable');
  const destination = await captureAccountSettingsHistoryDestinationAuthorityV1({ ...input, currentness });
  const readList = async () => {
    const response = await ports.request('/v2/account/settings/history', { method: 'GET' });
    await assertCurrent(ports);
    if (response.status < 200 || response.status >= 300) ports.unavailable(response.status, 'History inventory unavailable');
    return AccountSettingsV2HistoryListResponseSchema.parse(response.data).snapshots;
  };
  const inventory = await readList();
  if (input.expectedProfileTransferRevision !== undefined
    && input.expectedProfileTransferRevision !== destination.expectedProfileTransferRevision) {
    return { status: 'cleanup-pending', versions: inventory.map(snapshot => snapshot.version).sort((a, b) => a - b) };
  }
  for (const snapshot of inventory) {
    try {
      await assertCurrent(ports);
      const detailResponse = await ports.request(`/v2/account/settings/history/${snapshot.version}`, { method: 'GET' });
      await assertCurrent(ports);
      if (detailResponse.status < 200 || detailResponse.status >= 300) ports.unavailable(detailResponse.status, 'History snapshot unavailable');
      const detail = AccountSettingsV2HistoryDetailResponseSchema.parse(detailResponse.data);
      if (detail.content === null) continue;
      const raw = await ports.openSnapshot(detail.content);
      const authority = recoverSavedSecretHistoryAuthority(raw, destination.authority,
        settingsVersion, input.savedSecretRecovery);
      const application = normalizeTransferredAccountSettingsHistoryV1(raw, authority);
      if (application.status === 'invalid') { pending.add(snapshot.version); continue; }
      if (application.cleanupPending) pending.add(snapshot.version);
      if (application.status === 'unchanged') continue;
      const content = await ports.resealSnapshot(application.raw, detail.content);
      const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse({
        expectedSettingsVersion: currentness.settingsVersion,
        expectedProfileTransferRevision: destination.expectedProfileTransferRevision,
        expectedEncryptionCurrentness: { mode: currentness.mode, signingKeyFingerprint: currentness.signingKeyFingerprint,
          contentKeyFingerprint: currentness.contentKeyFingerprint }, expectedContent: detail.content,
        operation: { kind: 'normalize', removedRoots: authority.activeTransferredRoots, content,
          ...(authority.activeTransferredProfileIds === undefined ? {} : { transferredProfileIds: authority.activeTransferredProfileIds }),
          ...(authority.activePromptLibraryKeys === undefined ? {} : { transferredPromptLibraryKeys: authority.activePromptLibraryKeys }),
          ...(authority.savedSecretTransfers ? { savedSecretTransfers: authority.savedSecretTransfers } : {}),
          ...(authority.legacyRoleArtifactTransfers === undefined ? {} : {
            legacyRoleArtifactTransfers: authority.legacyRoleArtifactTransfers }) },
      });
      await assertCurrent(ports);
      const response = await ports.request(`/v2/account/settings/history/${snapshot.version}/mutate`, { method: 'POST', body: mutation });
      const result = AccountSettingsV2HistoryMutationResponseSchema.safeParse(response.data);
      if (response.status < 200 || response.status >= 300 || !result.success
        || (result.data.status !== 'applied' && result.data.status !== 'unchanged')) pending.add(snapshot.version);
    } catch {
      await assertCurrent(ports);
      pending.add(snapshot.version);
    }
  }
  const latest = await readList();
  const known = new Set(inventory.map(snapshot => snapshot.version));
  latest.forEach(snapshot => { if (!known.has(snapshot.version)) pending.add(snapshot.version); });
  const finalCurrentness = await ports.readCurrentness();
  const finalDestination = await captureAccountSettingsHistoryDestinationAuthorityV1({ ...input, currentness: finalCurrentness });
  if (!sameStrictJsonValue(currentness, finalCurrentness)
    || finalDestination.expectedProfileTransferRevision !== destination.expectedProfileTransferRevision
    || !sameStrictJsonValue(destination.authority, finalDestination.authority)) {
    latest.forEach(snapshot => pending.add(snapshot.version));
  }
  return pending.size ? { status: 'cleanup-pending', versions: [...pending].sort((a, b) => a - b) } : { status: 'complete' };
}
