import type { StoredCredentials } from '@/persistence';
import { isDeepStrictEqual } from 'node:util';
import { migrateLegacyAiLaunchProfilesV1, confirmLegacyAiLaunchProfileMigrationV1, createLegacyProfileMigrationSourceFingerprintV1,
  listLegacyAiLaunchProfileUnpromotedCredentialEnvironmentVariableNamesV1 } from '@happier-dev/protocol/providers/migrations/legacyProfilesV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { StoredLaunchProfileV2Schema } from '@happier-dev/protocol/profiles/v2/schema';
import { ProfileRecordV1Schema, sealProfileRecordContentV1, resolveEffectiveProfileSecretBindingsV1, type ProfileRowMutationV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { createCliProfileStore } from '@/settings/profiles/profileStore';
import { createCliProviderConnectionsStore } from './catalogStore';
import { composeProviderSettingsV1, splitProviderSettingsV1, sealProviderConnectionsContentV1,
  listProviderConnectionsCatalogSavedSecretRefsV1, ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { ProviderSettingsV1 } from '@happier-dev/protocol/providers/settings/v1';
import { loadAiLaunchProfileArtifacts, prepareLegacyProfileRecordsV1, readLegacyProfileRecordsV1,
  readAiLaunchProfileEnabledV1 } from '@happier-dev/protocol/profiles/read';
import { AccountSettingsSavedSecretMutationError, promoteProfileEnvironmentVariableSavedSecretReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { formatSharedSavedSecretRefV1, parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { prepareProfileEnvironmentVariableSavedSecretPromotionForOperation, promoteSavedSecretResourceForOperation,
  createInvocationSavedSecretOperationContextV1,
  captureSavedSecretReferencesForOperation, captureSavedSecretReferenceCatalogsForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readLegacyProfileMigrationContributionMap } from '../migrations/coordinator';
import type { AccountSettings, ProviderAccountSettingsMigrationContextV1, ProviderSettingsMigrationSourceOutcomeV1, LegacyProfileReviewedMappingV1 } from '@happier-dev/protocol';

import {
  replaceAccountSettingsV2RawForOwnerCutover,
  type AccountSettingsUpdateV2Deps,
} from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import {
  readAuthoringMemoryLastUsedProfile,
  clearAuthoringMemoryLastUsedProfileIfEqual,
} from '@/settings/profiles/readAuthoringMemoryLastUsedProfile';

/** The catalog owner distinguishes genuine transfer state from native rows. */
async function readActiveMigrationSource(credentials: StoredCredentials, includeLegacy = false) {
  const store = createCliProfileStore({ credentials });
  const catalog = await store.readProfileCatalog();
  if (catalog.status !== 'ready') throw new ProviderSettingsMigrationError('profile_catalog_unavailable');
  if (catalog.source !== 'destination' && !includeLegacy) return null;
  const providerStore = createCliProviderConnectionsStore({ credentials });
  const providerCatalog = await providerStore.readCatalog();
  if (providerCatalog.status !== 'ready') throw new ProviderSettingsMigrationError('provider_catalog_unavailable');
  const source = await store.readSourceSnapshot();
  const providerStorage = await providerStore.readStorageContext();
  if (providerStorage.mode !== source.mode) throw new ProviderSettingsMigrationError('provider_catalog_unavailable');
  const providerSettings = composeProviderSettingsV1(providerCatalog.catalog,
    ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema.parse(source.raw.providerDefaultModelSelectionsByAgentTargetKeyV1 ?? {}));
  const ordinaryEnabledById = accountSettingsParse(source.raw).profileEnabledById;
  return { store, catalog, source, providerStore, providerCatalog, providerSettings,
    raw: catalog.source !== 'destination' ? source.raw : {
    ...source.raw,
    profiles: catalog.records.map(({ record }) => record.definition.kind === 'artifact'
      ? { id: record.id, artifactId: record.definition.artifactId } : record.definition.profile),
    secretBindingsByProfileId: Object.fromEntries(catalog.records.map(({ record }) => [record.id, record.secretBindings])),
    profileEnabledById: { ...ordinaryEnabledById, ...Object.fromEntries(catalog.records.map(({ record }) => {
      const profile = record.definition.kind === 'artifact' ? { id: record.id, artifactId: record.definition.artifactId }
        : record.definition.profile;
      return [record.id, readAiLaunchProfileEnabledV1({ ...profile, enabled: record.enabled }, ordinaryEnabledById)];
    })) },
  }, recordContext: catalog.source === 'destination'
    ? { profileRecordIds: catalog.records.map(({ record }) => record.id), records: catalog.records } : undefined };
}

type ActiveMigrationSource = NonNullable<Awaited<ReturnType<typeof readActiveMigrationSource>>>;

/** Accepted Provider descriptors are captured once; raw credentials never leave this owner. */
export async function prepareLegacyProfileMigrationSource(params: Readonly<{
  credentials: StoredCredentials;
  expectedSettingsVersion: number;
  acquireRegistryLease: () => Promise<Readonly<{ registry: unknown; release: () => Promise<void> }>>;
  signal?: AbortSignal;
}>) {
  const lease = await params.acquireRegistryLease();
  try {
    const prepared = await prepareCapturedLegacyProfileMigrationSource({ ...params, registry: lease.registry });
    return prepared.result;
  } finally { await lease.release(); }
}

/** The automatic and guided entry points borrow the same accepted registry generation. */
async function prepareCapturedLegacyProfileMigrationSource(params: Readonly<{
  credentials: StoredCredentials; registry: unknown; expectedSettingsVersion?: number; signal?: AbortSignal;
}>) {
  const store = createCliProfileStore({ credentials: params.credentials, signal: params.signal });
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  let catalog = await store.readProfileCatalog();
  let source = await store.readSourceSnapshot();
  if (params.expectedSettingsVersion !== undefined && source.version !== params.expectedSettingsVersion) {
    throw new ProviderSettingsMigrationError('legacy_profile_source_changed');
  }
  const providerContributions = [...readLegacyProfileMigrationContributionMap(params.registry).values()].map(({ definition }) => definition);
  const { createCredentialedAccountArtifactStore } = await import('@/api/artifacts/accountArtifactStore');
  const artifactStore = createCredentialedAccountArtifactStore(params.credentials);
  let operationContext: ReturnType<typeof createInvocationSavedSecretOperationContextV1> | undefined;
  for (;;) {
    if (catalog.status !== 'ready') throw new ProviderSettingsMigrationError('profile_catalog_unavailable');
    if (catalog.source !== 'legacy') {
      throw new ProviderSettingsMigrationError('legacy_profile_source_changed');
    }
    const artifactsById = await loadAiLaunchProfileArtifacts([
      ...(Array.isArray(source.raw.profiles) ? source.raw.profiles : []), ...catalog.records.map(({ record }) => record),
    ], { read: artifactStore.read }, params.signal);
    const preparation = prepareLegacyProfileRecordsV1(source.raw, { artifactsById, providerContributions });
    const current = await store.readSourceSnapshot();
    if (current.version !== source.version || current.mode !== source.mode || !isDeepStrictEqual(current.raw, source.raw)) {
      throw new ProviderSettingsMigrationError('legacy_profile_source_changed');
    }
    store.assertCurrent();
    if (preparation.status === 'complete') return { source, catalog, store, result: {
      status: 'ready' as const, settingsVersion: source.version, records: [...preparation.records] } };
    const partial = { source, catalog, store, result: { status: 'partial' as const, settingsVersion: source.version,
      diagnostics: [...preparation.diagnostics] } };
    if (preparation.diagnostics.some(diagnostic => diagnostic.reason !== 'inline-secret-requires-promotion')) return partial;
    const accountId = readAccountIdFromToken(params.credentials.token);
    if (!accountId) throw new ProviderSettingsMigrationError('profile_catalog_unavailable');
    const candidates = readLegacyProfileRecordsV1(source.raw, { artifactsById }).records.flatMap(record => {
      if (record.definition.kind === 'artifact') return [];
      const profile = record.definition.profile;
      return listLegacyAiLaunchProfileUnpromotedCredentialEnvironmentVariableNamesV1({
        environmentVariables: record.definition.kind === 'inline' ? record.definition.profile.extraEnvironmentVariables
          : record.definition.profile.environmentVariables, envVarRequirements: profile.envVarRequirements ?? [],
      }, providerContributions, record.secretBindings).map(envName => ({ profileId: record.id, envName, displayName: profile.name }));
    });
    const scopeKey = resolveAccountSettingsScopeKey(params.credentials);
    if (!operationContext) {
      const capturedSnapshot = getActiveAccountSettingsSnapshot();
      if (!capturedSnapshot || capturedSnapshot.scopeKey !== scopeKey) throw new ProviderSettingsMigrationError('profile_catalog_unavailable');
      operationContext = createInvocationSavedSecretOperationContextV1({ credentials: params.credentials, serverHttpBaseUrl,
        snapshot: { ...capturedSnapshot, settings: accountSettingsParse(source.raw), rawSettings: source.raw, settingsVersion: source.version },
        isCurrent: async () => { store.assertCurrent(); return true; } });
    }
    const capturedCatalog = catalog;
    const artifactCensus = [...artifactsById.values()].map(artifact => {
      if (!artifact.revision) throw new ProviderSettingsMigrationError('profile_catalog_unavailable');
      return { artifactId: artifact.artifactId, ...artifact.revision };
    });
    const sharedRefs = [...new Set(catalog.records.flatMap(({ record }) => Object.values(record.secretBindings)))]
      .filter(ref => parseSavedSecretRefV1(ref).kind === 'shared_resource');
    const referenceCatalogs = await captureSavedSecretReferenceCatalogsForOperation({ credentials: params.credentials,
      operationContext, signal: params.signal });
    const secretCapture = await captureSavedSecretReferencesForOperation({ expectedScopeKey: scopeKey,
      references: sharedRefs, signal: params.signal, operationContext });
    let promoted = false;
    for (const candidate of candidates) {
      const selected = { kind: 'profile-environment-variable' as const, profileId: candidate.profileId, envName: candidate.envName };
      let mutation: ReturnType<typeof prepareProfileEnvironmentVariableSavedSecretPromotionForOperation>;
      try {
        mutation = prepareProfileEnvironmentVariableSavedSecretPromotionForOperation({ credentials: params.credentials, accountId,
          accountMode: source.mode, rawSettings: source.raw, expectedSettingsVersion: source.version, source: selected,
          profileCatalog: capturedCatalog, artifactsById,
          referenceCatalogs: referenceCatalogs.catalogs,
          referenceCensus: { accountMode: source.mode, profileTransferRevision: catalog.controlRevision,
            catalogs: referenceCatalogs.census,
            remoteHosts: referenceCatalogs.remoteHosts,
            notificationChannels: referenceCatalogs.notificationChannels,
            profiles: { referenceGuardRevision: catalog.referenceGuardRevision,
              rows: [...catalog.records.map(({ record, revision }) => ({ id: record.id, revision })), ...(catalog.tombstones ?? [])] },
            ...(artifactCensus.length > 0 ? { artifacts: artifactCensus } : {}) },
          savedSecretRevisions: secretCapture.savedSecretRevisions,
          displayName: candidate.displayName, kind: 'apiKey' });
      } catch (error) {
        // The canonical source selector, not a second template parser, refuses
        // unresolved templates, ambiguous carriers and already-bound literals.
        if (error instanceof AccountSettingsSavedSecretMutationError) continue;
        throw error;
      }
      const expected = promoteProfileEnvironmentVariableSavedSecretReferenceV1(source.raw, {
        source: selected, sharedSecretRef: formatSharedSavedSecretRefV1(mutation.resourceId),
      }, { ...referenceCatalogs.catalogs, profileRows: catalog.records, artifactsById });
      store.assertCurrent();
      const outcome = await promoteSavedSecretResourceForOperation({ expectedScopeKey: scopeKey, input: mutation, signal: params.signal, operationContext });
      if (outcome.status === 'outcome_unknown') throw new ProviderSettingsMigrationError('migration_outcome_unknown');
      if (outcome.status === 'conflict') throw new ProviderSettingsMigrationError('legacy_profile_source_changed');
      if (outcome.status !== 'applied') throw new ProviderSettingsMigrationError('profile_catalog_unavailable');
      let nextSource: Awaited<ReturnType<typeof store.readSourceSnapshot>>;
      let nextCatalog: Awaited<ReturnType<typeof store.readProfileCatalog>>;
      try {
        nextSource = await store.readSourceSnapshot();
        nextCatalog = await store.readProfileCatalog();
      } catch { throw new ProviderSettingsMigrationError('migration_outcome_unknown'); }
      const expectedRows = expected.profileRows ?? catalog.records;
      if (nextCatalog.status !== 'ready') throw new ProviderSettingsMigrationError('migration_outcome_unknown');
      const acknowledgedCatalog = nextCatalog;
      if (nextSource.version !== outcome.settingsVersion || nextSource.mode !== source.mode || !isDeepStrictEqual(nextSource.raw, expected.settings)
        || acknowledgedCatalog.source !== 'legacy' || acknowledgedCatalog.controlRevision !== capturedCatalog.controlRevision
        || (mutation.profileMutations.length === 0
          ? acknowledgedCatalog.referenceGuardRevision !== capturedCatalog.referenceGuardRevision
          : acknowledgedCatalog.referenceGuardRevision === capturedCatalog.referenceGuardRevision)
        || !isDeepStrictEqual(acknowledgedCatalog.tombstones ?? [], capturedCatalog.tombstones ?? [])
        || acknowledgedCatalog.records.length !== expectedRows.length || expectedRows.some((row, index) => {
          const actual = acknowledgedCatalog.records.find(value => value.record.id === row.record.id);
          return !actual || !isDeepStrictEqual(actual.record, row.record)
            || actual.revision !== row.revision + (row.record === capturedCatalog.records[index]?.record ? 0 : 1);
        })) throw new ProviderSettingsMigrationError('migration_outcome_unknown');
      const capturedResources = operationContext.readSnapshot();
      if (!capturedResources || !await operationContext.replaceAccountSettings({ ...capturedResources,
        settings: accountSettingsParse(nextSource.raw), rawSettings: nextSource.raw, settingsVersion: nextSource.version })) {
        throw new ProviderSettingsMigrationError('migration_outcome_unknown');
      }
      source = nextSource;
      catalog = nextCatalog;
      promoted = true;
      break;
    }
    if (!promoted) return partial;
  }
}

async function commitActiveMigrationSource(input: Readonly<{
  credentials: StoredCredentials; captured: ActiveMigrationSource;
  settings: Readonly<Record<string, unknown>>; deps?: AccountSettingsUpdateV2Deps;
  providerSettings: ProviderSettingsV1;
}>) {
  const { captured } = input;
  const profiles = Array.isArray(input.settings.profiles) ? input.settings.profiles : [];
  const byProfile = input.settings.secretBindingsByProfileId;
  const bindings = byProfile && typeof byProfile === 'object' && !Array.isArray(byProfile) ? byProfile : {};
  const mutations: ProfileRowMutationV1[] = [];
  for (const { record, revision } of captured.catalog.records) {
    if (captured.catalog.source !== 'destination') break;
    if (record.definition.kind === 'artifact') continue;
    const matches = profiles.filter((profile) => profile && typeof profile === 'object' && Reflect.get(profile, 'id') === record.id);
    if (matches.length !== 1) throw new ProviderSettingsMigrationError('legacy_profile_source_changed');
    const slim = StoredLaunchProfileV2Schema.safeParse(matches[0]);
    const legacy = slim.success ? null : AIBackendProfileSchema.safeParse(matches[0]);
    if (!slim.success && !legacy?.success) throw new ProviderSettingsMigrationError('legacy_profile_source_changed');
    const nextRecord = ProfileRecordV1Schema.parse({ ...record,
      definition: slim.success ? { kind: 'inline', profile: slim.data } : { kind: 'legacy', profile: legacy?.success ? legacy.data : null },
      secretBindings: Object.hasOwn(bindings, record.id) ? Reflect.get(bindings, record.id) : {},
    });
    if (!isDeepStrictEqual(record, nextRecord)) mutations.push({ id: record.id, operation: 'update', expectedRevision: revision,
      content: sealProfileRecordContentV1({ mode: captured.source.mode, material: captured.source.material, record: nextRecord }),
      // Artifact records are excluded above; this conversion only carries private bindings.
      referencedSavedSecretIds: [...new Set(Object.values(resolveEffectiveProfileSecretBindingsV1({}, nextRecord.secretBindings)))],
      artifactRevision: null });
  }
  // These roots existed only to feed the incumbent translator. They never
  // become a second persisted Profile catalog after the cutover.
  const nextSettings = { ...input.settings };
  for (const key of captured.catalog.source === 'destination' ? ['profiles', 'secretBindingsByProfileId', 'profileEnabledById'] as const : []) {
    if (Object.hasOwn(captured.source.raw, key)) nextSettings[key] = captured.source.raw[key];
    else delete nextSettings[key];
  }
  const { catalog: nextProviderCatalog, defaults } = splitProviderSettingsV1(input.providerSettings);
  nextSettings.providerDefaultModelSelectionsByAgentTargetKeyV1 = defaults;
  if (mutations.length === 0 && isDeepStrictEqual(nextSettings, captured.source.raw)
    && isDeepStrictEqual(nextProviderCatalog, captured.providerCatalog.catalog)) {
    captured.store.assertCurrent();
    return { version: captured.source.version, settings: accountSettingsParse(nextSettings) };
  }
  const providerReferences = listProviderConnectionsCatalogSavedSecretRefsV1(nextProviderCatalog).map(reference => reference.secretId);
  const allReferences = [...new Set([...providerReferences, ...mutations.flatMap(mutation => mutation.referencedSavedSecretIds)])];
  const secretCapture = await captureSavedSecretReferencesForOperation({ expectedScopeKey: resolveAccountSettingsScopeKey(input.credentials),
    references: allReferences });
  const revisionsFor = (references: readonly string[]) => {
    const ids = new Set(references.flatMap(reference => {
      const parsed = parseSavedSecretRefV1(reference);
      return parsed.kind === 'shared_resource' ? [parsed.resourceId] : [];
    }));
    return secretCapture.savedSecretRevisions.filter(resource => ids.has(resource.resourceId));
  };
  const providerMutation = { expectedRevision: captured.providerCatalog.revision,
    ...(captured.providerCatalog.revision === 'absent' ? { sourceSettingsVersion: captured.source.version } : {}),
    content: sealProviderConnectionsContentV1({ mode: captured.source.mode, material: captured.source.material, catalog: nextProviderCatalog }),
    referencedSavedSecretIds: [...new Set(providerReferences)], savedSecretRevisions: revisionsFor(providerReferences) };
  const result = await replaceAccountSettingsV2RawForOwnerCutover({ credentials: input.credentials,
    expectedVersion: captured.source.version, envelopeKind: captured.source.envelopeKind, raw: nextSettings,
    deps: { ...input.deps, resolveAccountEncryptionMode: async () => captured.source.mode,
      updateSettings: async ({ expectedVersion, content }) => {
        captured.store.assertCurrent();
        captured.providerStore.assertCurrent();
        let response;
        try { response = await captured.store.providerConversion({ operation: 'provider-conversion',
          expectedAccountMode: captured.source.mode, expectedSettingsVersion: expectedVersion,
          expectedProfileTransferRevision: captured.catalog.controlRevision,
          expectedReferenceGuardRevision: captured.catalog.referenceGuardRevision,
          profileCensus: [...captured.catalog.records.map(({ record, revision }) => ({ id: record.id, revision })),
            ...(captured.catalog.tombstones ?? [])],
          mutations: mutations.map(mutation => ({ ...mutation, savedSecretRevisions: revisionsFor(mutation.referencedSavedSecretIds) })),
          providerMutation, nextSettings: content }); }
        catch { throw new ProviderSettingsMigrationError('migration_outcome_unknown'); }
        if (response.status === 'updated') {
          const acknowledged = new Map(response.rows.map((row) => [row.id, row]));
          if (response.providerRevision !== (captured.providerCatalog.revision === 'absent' ? 0 : captured.providerCatalog.revision + 1)
            || acknowledged.size !== response.rows.length || mutations.some((mutation) => {
            const row = acknowledged.get(mutation.id);
            return !row || row.revision !== Number(mutation.expectedRevision) + 1 || !isDeepStrictEqual(row.content, mutation.content);
          })) throw new ProviderSettingsMigrationError('migration_outcome_unknown');
          return { success: true, version: response.settingsVersion };
        }
        if (response.status === 'conflict' || response.status === 'settings-conflict' || response.status === 'reference-conflict'
          || response.status === 'provider-conflict') {
          throw new ProviderSettingsMigrationError('legacy_profile_source_changed');
        }
        throw new ProviderSettingsMigrationError('profile_catalog_unavailable');
      } },
  });
  if (!result.success) throw new ProviderSettingsMigrationError('legacy_profile_source_changed');
  return { version: result.version, settings: accountSettingsParse(nextSettings) };
}

export async function previewLegacyProfileMigration(params: Readonly<{
  credentials: StoredCredentials;
  sourceProfileId: string;
  reviewedMapping: LegacyProfileReviewedMappingV1;
  deps?: AccountSettingsUpdateV2Deps;
}>): Promise<Readonly<{ version: number; sourceFingerprint: string }>> {
  const authoringMemory = { lastUsedProfile: await readAuthoringMemoryLastUsedProfile(params.credentials) };
  const captured = await readActiveMigrationSource(params.credentials, true);
  if (!captured) throw new ProviderSettingsMigrationError('profile_catalog_unavailable');
  return { version: captured.source.version, sourceFingerprint: createLegacyProfileMigrationSourceFingerprintV1({
    rawSettings: captured.raw, authoringMemory, sourceProfileId: params.sourceProfileId,
    reviewedMapping: params.reviewedMapping, recordContext: captured.recordContext,
  }) };
}

export class ProviderSettingsMigrationError extends Error {
  readonly reason: Exclude<
    ReturnType<typeof migrateLegacyAiLaunchProfilesV1>,
    { ok: true }
  >['reason'] | 'legacy_profile_source_changed' | 'migration_conflict_changed' | 'migration_conflict_resolution_invalid'
    | 'profile_catalog_unavailable' | 'provider_catalog_unavailable' | 'migration_outcome_unknown';

  constructor(reason: ProviderSettingsMigrationError['reason']) {
    super(`Provider settings migration refused: ${reason}`);
    this.name = 'ProviderSettingsMigrationError';
    this.reason = reason;
  }
}

export async function confirmLegacyProfileMigration(params: Readonly<{
  credentials: StoredCredentials;
  sourceProfileId: string;
  expectedSourceFingerprint: string;
  reviewedMapping: LegacyProfileReviewedMappingV1;
  migratedAt: number;
  deps?: AccountSettingsUpdateV2Deps;
}>): Promise<Readonly<{ version: number; settings: AccountSettings }>> {
  const authoringMemory = { lastUsedProfile: await readAuthoringMemoryLastUsedProfile(params.credentials) };
  const captured = await readActiveMigrationSource(params.credentials, true);
  if (!captured) throw new ProviderSettingsMigrationError('profile_catalog_unavailable');
    const migrated = confirmLegacyAiLaunchProfileMigrationV1({ ...params, rawSettings: captured.raw,
      providerSettings: captured.providerSettings, authoringMemory, recordContext: captured.recordContext });
    if (!migrated.ok) throw new ProviderSettingsMigrationError(migrated.reason);
    const result = await commitActiveMigrationSource({ ...params, captured, settings: migrated.settings, providerSettings: migrated.providerSettings });
    if (migrated.lastUsedProfileClear) await clearAuthoringMemoryLastUsedProfileIfEqual(params.credentials, migrated.lastUsedProfileClear.base);
    return result;
}

/**
 * One semantic migration: the callback is evaluated once against the latest
 * fetched version and exactly one CAS is submitted. A conflict is a terminal
 * outcome, never a hidden re-run of the migration against the winner.
 */
export async function migrateProviderSettings(params: Readonly<{
  credentials: StoredCredentials;
  acquireRegistryLease: () => Promise<Readonly<{
    registry: unknown;
    release: () => Promise<void>;
  }>>;
  deriveContext: (
    latestRawSettings: Readonly<Record<string, unknown>>,
    acceptedRegistry: unknown,
    providerSettings: ProviderSettingsV1,
  ) => ProviderAccountSettingsMigrationContextV1 | Promise<ProviderAccountSettingsMigrationContextV1>;
  deps?: AccountSettingsUpdateV2Deps;
}>): Promise<Readonly<{
  version: number;
  settings?: AccountSettings;
  outcomes: readonly ProviderSettingsMigrationSourceOutcomeV1[];
}>> {
  const lease = await params.acquireRegistryLease();
  try {
    const authoringMemory = { lastUsedProfile: await readAuthoringMemoryLastUsedProfile(params.credentials) };
    let captured = await readActiveMigrationSource(params.credentials);
    if (!captured) {
      const prepared = await prepareCapturedLegacyProfileMigrationSource({ credentials: params.credentials, registry: lease.registry });
      if (prepared.result.status !== 'ready') throw new ProviderSettingsMigrationError('profile_catalog_unavailable');
      captured = await readActiveMigrationSource(params.credentials, true);
    }
    if (!captured) throw new ProviderSettingsMigrationError('profile_catalog_unavailable');
      const context = await params.deriveContext(captured.raw, lease.registry, captured.providerSettings);
      const migrated = migrateLegacyAiLaunchProfilesV1(captured.raw, captured.providerSettings, context, authoringMemory, captured.recordContext);
      if (!migrated.ok) throw new ProviderSettingsMigrationError(migrated.reason);
      const result = await commitActiveMigrationSource({ ...params, captured, settings: migrated.settings, providerSettings: migrated.providerSettings });
      if (migrated.lastUsedProfileClear) await clearAuthoringMemoryLastUsedProfileIfEqual(params.credentials, migrated.lastUsedProfileClear.base);
      return { ...result, outcomes: migrated.outcomes };
  } finally {
    await lease.release();
  }
}
