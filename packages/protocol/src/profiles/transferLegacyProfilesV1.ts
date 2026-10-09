import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import type { ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
import type { ProfileCatalogSnapshotV1 } from './profileCatalogV1.js';
import { hasProfileTransferSourceV1, listTransferredProfileIdsV1, prepareLegacyProfileRecordsV1, readLegacyProfileRecordsV1, readAiLaunchProfileRecords, readEffectiveProfileSecretBindingsV1, removeTransferredProfileSourcesV1,
  PROFILE_TRANSFERRED_SOURCE_ROOTS_V1, type LegacyProfileRecordPreparationV1 } from './read.js';
import { ProfileRecordV1Schema, sealProfileRecordContentV1, type ProfileRecordV1, type ProfileRowMutationV1 } from './profileRecordV1.js';
import { ProfileTransferMutationV1Schema, profileTransferInventoriesEqualV1, sealProfileTransferContentV1,
  type ProfileTransferControlV1, type ProfileTransferInventoryEntryV1, type ProfileTransferMutationV1, type ProfileTransferMutationResponseV1 } from './profileTransferV1.js';
import type { ProviderContributionV1 } from '../providers/contributions/v1.js';
import { requiresLegacyAiLaunchProfileProviderSourcePreparationV1, listLegacyAiLaunchProfileUnpromotedCredentialEnvironmentVariableNamesV1 } from '../providers/migrations/legacyProfilesV1.js';
import type { DaemonProviderProfileMigrationPrepareSourceResponseV1 } from '../rpc/providers.js';

export type ProfileTransferResourceRevisionsV1<T> =
  | Readonly<{ status: 'ready'; resourcesByRef: ReadonlyMap<string, T> }>
  | Readonly<{ status: 'partial' | 'unavailable' }>;

export type LegacyProfileTransferInputV1 = Readonly<{
  source: Readonly<{ raw: Readonly<Record<string, unknown>>; version: number }>;
  catalog: ProfileCatalogSnapshotV1;
  artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
  providerContributions: readonly Pick<ProviderContributionV1, 'legacyProfileMigrations'>[] | null;
  homeServerId: string;
  mode: 'plain' | 'e2ee';
  material: AccountScopedCryptoMaterial | null;
  assertCurrent(): void;
  signal?: AbortSignal;
  randomBytes?: (length: number) => Uint8Array;
  legacySourcePreparation?: Readonly<{
    prepare(input: Readonly<{ expectedSettingsVersion: number }>): Promise<DaemonProviderProfileMigrationPrepareSourceResponseV1>;
    reloadSource(): Promise<Readonly<{ raw: Readonly<Record<string, unknown>>; version: number }>>;
  }>;
  readSavedSecretRevisions(refs: readonly string[]): Promise<ProfileTransferResourceRevisionsV1<Readonly<{ resourceId: string; revision: number }>>>;
  readArtifactRevisions(ids: readonly string[]): Promise<ProfileTransferResourceRevisionsV1<Readonly<{ headerVersion: number; bodyVersion: number }>>>;
  mutateTransfer(mutation: ProfileTransferMutationV1): Promise<ProfileTransferMutationResponseV1>;
  reloadCatalog(): Promise<ProfileCatalogSnapshotV1>;
}>;

export type LegacyProfileTransferResultV1 =
  | Readonly<{ status: 'active'; control: ProfileTransferControlV1; revision: number }>
  | Readonly<{ status: 'not-required'; reason: 'no-predecessor-source' }>
  | Readonly<{ status: 'incomplete'; diagnostics: LegacyProfileRecordPreparationV1['diagnostics'] }>
  | Readonly<{ status: 'pending'; reason: 'cancelled' | 'catalog-not-ready' | 'destination-diverged' | 'resources-not-ready' | 'provider-classification-unavailable' | 'provider-source-unavailable' | 'source-version-conflict' | 'account-mode-mismatch' | 'encryption-material-unavailable' | 'authority-not-confirmed'; response?: ProfileTransferMutationResponseV1 }>;

export type ProfileTransferSourceCleanupInputV1 = Readonly<{
  control: Readonly<{ record: ProfileTransferControlV1; revision: number }>;
  assertCurrent(): void;
  signal?: AbortSignal;
  reloadCatalog(): Promise<ProfileCatalogSnapshotV1>;
  readSource(): Promise<Readonly<{ raw: Readonly<Record<string, unknown>>; version: number }>>;
  replaceSource(input: Readonly<{ raw: Readonly<Record<string, unknown>>; expectedVersion: number; expectedProfileTransferRevision: number }>): Promise<
    Readonly<{ status: 'applied'; settingsVersion: number }> | Readonly<{ status: 'conflict'; currentSettingsVersion: number }>
    | Readonly<{ status: 'outcomeUnknown'; lastKnownSettingsVersion: number }> | Readonly<{ status: 'rejected' }>>;
  normalizeHistory(input: Readonly<{ activeTransferredRoots: readonly string[]; expectedProfileTransferRevision: number }>): Promise<
    Readonly<{ status: 'complete' }> | Readonly<{ status: 'cleanup-pending'; versions: readonly number[] }>>;
}>;
export type ProfileTransferSourceCleanupResultV1 = Readonly<{ status: 'complete' }> | Readonly<{
  status: 'cleanup-pending'; reason: 'authority-not-confirmed' | 'source-conflict' | 'source-unavailable' | 'history-incomplete' | 'cancelled';
  versions?: readonly number[];
}>;

/** Post-activation cleanup can remain pending; it never changes destination authority. */
export async function cleanupTransferredProfileSourcesV1(input: ProfileTransferSourceCleanupInputV1): Promise<ProfileTransferSourceCleanupResultV1> {
  const pending = (reason: Extract<ProfileTransferSourceCleanupResultV1, { status: 'cleanup-pending' }>['reason']): ProfileTransferSourceCleanupResultV1 =>
    ({ status: 'cleanup-pending', reason });
  input.assertCurrent();
  if (input.signal?.aborted) return pending('cancelled');
  if (input.control.record.phase !== 'active') return pending('authority-not-confirmed');
  let catalog: ProfileCatalogSnapshotV1;
  try { catalog = await input.reloadCatalog(); }
  catch { input.assertCurrent(); return pending(input.signal?.aborted ? 'cancelled' : 'authority-not-confirmed'); }
  input.assertCurrent();
  if (input.signal?.aborted) return pending('cancelled');
  if (catalog.status !== 'ready' || catalog.control?.record.phase !== 'active' || catalog.control.revision !== input.control.revision) {
    return pending('authority-not-confirmed');
  }
  let source: Awaited<ReturnType<ProfileTransferSourceCleanupInputV1['readSource']>>;
  try { source = await input.readSource(); }
  catch { input.assertCurrent(); return pending(input.signal?.aborted ? 'cancelled' : 'source-unavailable'); }
  input.assertCurrent();
  if (input.signal?.aborted) return pending('cancelled');
  const ids = listTransferredProfileIdsV1(input.control.record);
  const raw = removeTransferredProfileSourcesV1(source.raw, ids);
  if (JSON.stringify(raw) !== JSON.stringify(source.raw)) {
    let response: Awaited<ReturnType<ProfileTransferSourceCleanupInputV1['replaceSource']>>;
    try { response = await input.replaceSource({ raw, expectedVersion: source.version, expectedProfileTransferRevision: input.control.revision }); }
    catch { input.assertCurrent(); return pending(input.signal?.aborted ? 'cancelled' : 'source-unavailable'); }
    input.assertCurrent();
    if (input.signal?.aborted) return pending('cancelled');
    if (response.status !== 'applied') return pending(response.status === 'conflict' ? 'source-conflict' : 'source-unavailable');
  }
  let history: Awaited<ReturnType<ProfileTransferSourceCleanupInputV1['normalizeHistory']>>;
  try { history = await input.normalizeHistory({ activeTransferredRoots: PROFILE_TRANSFERRED_SOURCE_ROOTS_V1,
    expectedProfileTransferRevision: input.control.revision }); }
  catch { input.assertCurrent(); return pending(input.signal?.aborted ? 'cancelled' : 'history-incomplete'); }
  input.assertCurrent();
  if (input.signal?.aborted) return pending('cancelled');
  return history.status === 'complete' ? { status: 'complete' } : { status: 'cleanup-pending', reason: 'history-incomplete', versions: history.versions };
}

function activeAuthority(catalog: ProfileCatalogSnapshotV1): Extract<LegacyProfileTransferResultV1, { status: 'active' }> | null {
  return (catalog.status === 'ready' || catalog.status === 'partial') && catalog.authority === 'active' && catalog.control?.record.phase === 'active'
    ? { status: 'active', control: catalog.control.record, revision: catalog.control.revision } : null;
}

function recordsEqual(left: ProfileRecordV1, right: ProfileRecordV1): boolean {
  // Canonical schema fields plus unordered configuration dictionaries, not ciphertext equality.
  const encode = (record: ProfileRecordV1) => JSON.stringify(ProfileRecordV1Schema.parse(record), (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return encode(left) === encode(right);
}

/** Shared destination-first transition; admitted hosts retain transport and resource ownership. */
export async function transferLegacyProfilesV1(input: LegacyProfileTransferInputV1): Promise<LegacyProfileTransferResultV1> {
  const pending = (reason: Extract<LegacyProfileTransferResultV1, { status: 'pending' }>['reason'], response?: ProfileTransferMutationResponseV1): LegacyProfileTransferResultV1 =>
    ({ status: 'pending', reason, ...(response ? { response } : {}) });
  input.assertCurrent();
  if (input.signal?.aborted) return pending('cancelled');
  if (input.mode === 'plain' && input.material !== null) return pending('account-mode-mismatch');
  if (input.mode === 'e2ee' && input.material === null) return pending('encryption-material-unavailable');
  const activated = activeAuthority(input.catalog);
  if (activated) return activated;
  if (input.catalog.status !== 'ready') return pending('catalog-not-ready');
  if (!hasProfileTransferSourceV1(input.source.raw)) return { status: 'not-required', reason: 'no-predecessor-source' };
  const rereadActive = async () => {
    input.assertCurrent();
    if (input.signal?.aborted) return null;
    const catalog = await input.reloadCatalog();
    input.assertCurrent();
    return input.signal?.aborted ? null : activeAuthority(catalog);
  };
  let source = input.source;
  let prepared = prepareLegacyProfileRecordsV1(source.raw, { artifactsById: input.artifactsById,
    ...(input.providerContributions === null ? {} : { providerContributions: input.providerContributions }) });
  const requiresSourcePreparation = readLegacyProfileRecordsV1(source.raw, { artifactsById: input.artifactsById }).records
    .some(record => record.definition.kind === 'legacy' && (requiresLegacyAiLaunchProfileProviderSourcePreparationV1(record.definition.profile, record.secretBindings)
      || listLegacyAiLaunchProfileUnpromotedCredentialEnvironmentVariableNamesV1(record.definition.profile,
        input.providerContributions ?? [], record.secretBindings).length > 0));
  if (requiresSourcePreparation && input.legacySourcePreparation) {
    // The incumbent RPC owner validates its response; it also owns descriptor admission.
    const response = await input.legacySourcePreparation.prepare({ expectedSettingsVersion: source.version });
    input.assertCurrent();
    if (input.signal?.aborted) return pending('cancelled');
    if (response.status === 'partial') return { status: 'incomplete', diagnostics: response.diagnostics };
    if (response.status === 'error') return await rereadActive() ?? pending('provider-source-unavailable');
    const currentSource = await input.legacySourcePreparation.reloadSource();
    input.assertCurrent();
    if (input.signal?.aborted) return pending('cancelled');
    if (currentSource.version !== response.settingsVersion) return await rereadActive() ?? pending('source-version-conflict');
    source = currentSource;
    prepared = { status: 'complete', records: response.records, diagnostics: [] };
  } else {
    if (prepared.status !== 'complete') return { status: 'incomplete', diagnostics: prepared.diagnostics };
    if (input.providerContributions === null && requiresSourcePreparation) return pending('provider-classification-unavailable');
  }

  const retained = new Map(input.catalog.records.map(row => [row.record.id, row]));
  const deleted = new Set(input.catalog.tombstones?.map(row => row.id));
  const ids = new Set(prepared.records.map(record => record.id));
  // An unexpected staged row cannot be silently promoted into the captured legacy inventory.
  if (input.catalog.records.some(row => !ids.has(row.record.id))) return pending('destination-diverged');
  const inventory: ProfileTransferInventoryEntryV1[] = [];
  const imports: ProfileRowMutationV1[] = [];
  for (const record of prepared.records) {
    const existing = retained.get(record.id);
    if (deleted.has(record.id) || (existing && !recordsEqual(existing.record, record))) return pending('destination-diverged');
    inventory.push({ kind: 'account_row', id: record.id, revision: existing?.revision ?? 0 });
    if (!existing) {
      const bindings = readEffectiveProfileSecretBindingsV1(record, { artifactsById: input.artifactsById });
      if (!bindings) return pending('resources-not-ready');
      const artifactId = record.definition.kind === 'artifact' ? record.definition.artifactId : undefined;
      const artifact = artifactId ? input.artifactsById.get(artifactId) : undefined;
      if (artifactId && !artifact?.revision) return pending('resources-not-ready');
      imports.push({ id: record.id, operation: 'import', expectedRevision: 'absent',
        content: sealProfileRecordContentV1({ mode: input.mode, material: input.material, record, randomBytes: input.randomBytes }),
        referencedSavedSecretIds: [...new Set(Object.values(bindings))],
        artifactRevision: artifactId && artifact?.revision ? { artifactId,
          headerVersion: artifact.revision.headerVersion, bodyVersion: artifact.revision.bodyVersion } : null });
    }
  }
  const opened = readAiLaunchProfileRecords(prepared.records, { artifactsById: input.artifactsById });
  if (opened.diagnostics.length) return pending('resources-not-ready');
  const secretRefs = [...new Set(opened.entries.flatMap(entry => entry.kind === 'opaque' ? [] : Object.values(entry.profile.secretBindings ?? {}).filter(binding => binding !== null)))];
  const artifactIds = [...new Set(prepared.records.flatMap(record => [
    ...(record.definition.kind === 'artifact' ? [record.definition.artifactId] : []), ...record.promptStack
      .filter(entry => entry.ref.serverId === undefined || entry.ref.serverId === input.homeServerId).map(entry => entry.ref.artifactId),
  ]))];
  const [secrets, artifacts] = await Promise.all([
    secretRefs.length ? input.readSavedSecretRevisions(secretRefs) : Promise.resolve({ status: 'ready' as const, resourcesByRef: new Map<string, Readonly<{ resourceId: string; revision: number }>>() }),
    artifactIds.length ? input.readArtifactRevisions(artifactIds) : Promise.resolve({ status: 'ready' as const, resourcesByRef: new Map<string, Readonly<{ headerVersion: number; bodyVersion: number }>>() }),
  ]);
  input.assertCurrent();
  if (input.signal?.aborted) return pending('cancelled');
  if (secrets.status !== 'ready' || artifacts.status !== 'ready') return pending('resources-not-ready');
  const resourceIds = new Set<string>();
  for (const ref of secretRefs) {
    const resource = secrets.resourcesByRef.get(ref);
    if (!resource) return pending('resources-not-ready');
    if (!resourceIds.has(resource.resourceId)) {
      inventory.push({ kind: 'saved_secret', id: resource.resourceId, revision: resource.revision });
      resourceIds.add(resource.resourceId);
    }
  }
  for (const row of imports) {
    const proofs = new Map<string, number>();
    for (const ref of row.referencedSavedSecretIds) {
      const resource = secrets.resourcesByRef.get(ref);
      if (!resource) return pending('resources-not-ready');
      proofs.set(resource.resourceId, resource.revision);
    }
    row.savedSecretRevisions = [...proofs].map(([resourceId, expectedRevision]) => ({ resourceId, expectedRevision }));
  }
  for (const id of artifactIds) {
    const revision = artifacts.resourcesByRef.get(id);
    if (!revision) return pending('resources-not-ready');
    const validatedRevision = input.artifactsById.get(id)?.revision;
    if (prepared.records.some(record => record.definition.kind === 'artifact' && record.definition.artifactId === id)
      && (!validatedRevision || validatedRevision.headerVersion !== revision.headerVersion || validatedRevision.bodyVersion !== revision.bodyVersion)) {
      return pending('resources-not-ready');
    }
    inventory.push({ kind: 'artifact', id, revision });
  }
  const proof: ProfileTransferControlV1 = { v: 1, phase: 'prepared', sourceSettingsVersion: source.version,
    migratedLogicalRevision: source.version, inventory };
  const mutate = async (mutation: ProfileTransferMutationV1): Promise<ProfileTransferMutationResponseV1 | Extract<LegacyProfileTransferResultV1, { status: 'active' }>> => {
    input.assertCurrent();
    try {
      const response = await input.mutateTransfer(ProfileTransferMutationV1Schema.parse(mutation));
      input.assertCurrent();
      return response;
    } catch (error) {
      // A lost response can follow a durable activation. Read the authority, never replay.
      const current = await rereadActive();
      if (current) return current;
      throw error;
    }
  };
  let revision = input.catalog.controlRevision;
  const currentControl = input.catalog.control?.record;
  let activationProof = proof;
  if (!currentControl || currentControl.sourceSettingsVersion !== proof.sourceSettingsVersion
    || !profileTransferInventoriesEqualV1(currentControl.inventory, inventory)) {
    const response = await mutate({ operation: 'prepare', sourceSettingsVersion: proof.sourceSettingsVersion, expectedRevision: revision,
      inventory, imports, content: sealProfileTransferContentV1({ mode: input.mode, material: input.material, record: proof, randomBytes: input.randomBytes }) });
    if (response.status === 'active') return response;
    if (input.signal?.aborted) return pending('cancelled');
    if (response.status !== 'updated') return await rereadActive() ?? pending('authority-not-confirmed', response);
    revision = response.revision;
  } else {
    activationProof = currentControl;
  }
  input.assertCurrent();
  if (input.signal?.aborted) return pending('cancelled');
  const activeProof = { ...activationProof, phase: 'active' as const };
  const response = await mutate({ operation: 'activate', sourceSettingsVersion: proof.sourceSettingsVersion, expectedRevision: revision,
    inventory, content: sealProfileTransferContentV1({ mode: input.mode, material: input.material, record: activeProof, randomBytes: input.randomBytes }) });
  if (response.status === 'active') return response;
  return await rereadActive() ?? pending(input.signal?.aborted ? 'cancelled' : 'authority-not-confirmed', response);
}
