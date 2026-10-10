import { readAiLaunchProfileCollection, readAiLaunchProfileRecords, readAiLaunchProfileEnabledV1, loadAiLaunchProfileArtifacts } from '@happier-dev/protocol/profiles/read';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { isCanonicalProviderSavedSecretIdV1 } from '@happier-dev/protocol/providers/settings/v1';
import { resolveVisibleBuiltInAiLaunchProfilesV1 } from '@happier-dev/protocol/profiles/visibilityV1';
import { projectHistoricalBuiltInAiLaunchProfileV1 } from '@happier-dev/protocol/profiles/historicalCompatibilityV1';
import { getBuiltInBackendProfile } from '@happier-dev/protocol/profiles/builtInBackendProfiles';
import type { AIBackendProfile, AiLaunchProfile, AiLaunchProfileReadDiagnostic, ArtifactSharingResourceV1, ProviderSettingsV1 } from '@happier-dev/protocol';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

export type CliAiLaunchProfile = AiLaunchProfile;

export type AccountSettingsProfilesSnapshot = Readonly<{
  customProfiles: AIBackendProfile[];
  profiles: CliAiLaunchProfile[];
  opaqueProfiles: unknown[];
  diagnostics: readonly AiLaunchProfileReadDiagnostic[];
  secretBindingsByProfileId: Record<string, Record<string, string>>;
  enabledByProfileId: Readonly<Record<string, boolean>>;
  visibleProfiles: CliAiLaunchProfile[];
  terminalMigratedProfileIds: ReadonlySet<string> | undefined;
}>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export class ProfileCatalogUnavailableError extends Error {
  readonly code = 'profile_catalog_unavailable';
  constructor(readonly status: 'loading' | 'partial' | 'unavailable') {
    super(`Account Profile catalog is ${status}`);
    this.name = 'ProfileCatalogUnavailableError';
  }
}

/** Full predecessor bytes stay with the captured Settings source owner, never its bounded projection. */
export function readProfileSettingsFromAccountSnapshot(snapshot: Pick<ActiveAccountSettingsSnapshot, 'settings' | 'rawSettings' | 'profileCatalog'> | null | undefined) {
  if (snapshot?.profileCatalog?.status === 'ready' && snapshot.profileCatalog.source === 'legacy') {
    if (!snapshot.rawSettings) throw new ProfileCatalogUnavailableError('unavailable');
    return snapshot.rawSettings;
  }
  return snapshot?.settings;
}

export function readProfileSettingsForAccount(input: Readonly<{ settings: unknown; credentials: StoredCredentials; profileCatalog: ProfileCatalogSnapshotV1 }>) {
  const captured = getActiveAccountSettingsSnapshot();
  return captured?.scopeKey === resolveAccountSettingsScopeKey(input.credentials)
    ? readProfileSettingsFromAccountSnapshot({ ...captured, profileCatalog: input.profileCatalog }) : input.settings;
}

/** One input port for listing and admission; raw Settings is predecessor-only. */
export function readProfileCollectionFromAccountSnapshot(settings: unknown,
  artifactsById?: ReadonlyMap<string, ArtifactSharingResourceV1>, profileCatalog?: ProfileCatalogSnapshotV1) {
  if (profileCatalog) {
    if (profileCatalog.status !== 'ready') throw new ProfileCatalogUnavailableError(profileCatalog.status);
    if (profileCatalog.source === 'destination') {
      const collection = readAiLaunchProfileRecords(profileCatalog.records.map(({ record }) => record), {
        artifactsById: artifactsById ?? new Map(), includeShared: artifactsById !== undefined,
        recordRevisionsById: new Map(profileCatalog.records.map(({ record, revision }) => [record.id, revision])),
      });
      if (collection.diagnostics.length > 0) throw new ProfileCatalogUnavailableError('partial');
      const rawPreferences = isPlainRecord(settings) && isPlainRecord(settings.profileEnabledById) ? settings.profileEnabledById : {};
      const preferences = Object.fromEntries(Object.entries(rawPreferences)
        .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
      return { ...collection, entries: collection.entries.map((entry) => entry.kind === 'opaque' ? entry
        : { ...entry, profile: { ...entry.profile, enabled: readAiLaunchProfileEnabledV1(entry.profile, preferences) } }) };
    }
    if (profileCatalog.source !== 'legacy') throw new ProfileCatalogUnavailableError('unavailable');
  }
  const record = isPlainRecord(settings) ? settings : {};
  return readAiLaunchProfileCollection(record.profiles, artifactsById ? { artifactsById, includeShared: true } : undefined);
}

export function readProfilesFromAccountSettings(settings: unknown, artifactsById?: ReadonlyMap<string, ArtifactSharingResourceV1>, authoringMemory: Readonly<{ lastUsedProfile: string | null }> = { lastUsedProfile: null }, profileCatalog?: ProfileCatalogSnapshotV1, providerSettings?: ProviderSettingsV1): AccountSettingsProfilesSnapshot {
  const record = isPlainRecord(settings) ? settings : {};
  const customProfiles: AIBackendProfile[] = [];
  const profiles: CliAiLaunchProfile[] = [];
  const opaqueProfiles: unknown[] = [];
  const collection = readProfileCollectionFromAccountSnapshot(settings, artifactsById, profileCatalog);
  for (const entry of collection.entries) {
    if (entry.kind === 'legacy') {
      customProfiles.push(entry.profile);
      profiles.push(entry.profile);
    } else if (entry.kind === 'slim') {
      profiles.push(entry.profile);
    } else {
      opaqueProfiles.push(entry.raw);
    }
  }

  const secretBindingsByProfileId: Record<string, Record<string, string>> = {};
  const rawBindings = profileCatalog?.status === 'ready' && profileCatalog.source === 'destination' ? undefined : record.secretBindingsByProfileId;
  if (isPlainRecord(rawBindings)) {
    for (const [profileId, maybeBindings] of Object.entries(rawBindings)) {
      if (!isPlainRecord(maybeBindings)) continue;
      const out: Record<string, string> = {};
      for (const [envVarName, rawSecretId] of Object.entries(maybeBindings)) {
        if (!isCanonicalProviderSavedSecretIdV1(rawSecretId)) continue;
        out[envVarName] = rawSecretId;
      }
      if (Object.keys(out).length > 0) {
        secretBindingsByProfileId[profileId] = out;
      }
    }
  }
  for (const profile of profiles) {
    if (profile.secretBindings) secretBindingsByProfileId[profile.id] = {
      ...profile.secretBindings, ...secretBindingsByProfileId[profile.id],
    };
  }

  const favoriteProfiles = Array.isArray(record.favoriteProfiles)
    ? record.favoriteProfiles.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const enabledById = isPlainRecord(record.profileEnabledById) ? record.profileEnabledById : {};
  const enabledByProfileId = Object.fromEntries(Object.entries(enabledById)
    .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    const enabled = readAiLaunchProfileEnabledV1(profile, enabledByProfileId);
    enabledByProfileId[profile.id] = enabled;
    if (profile.enabled !== undefined) profiles[index] = { ...profile, enabled };
  }
  for (const profileId of ['gemini-api-key', 'gemini-vertex'] as const) {
    const hasHistoricalEvidence = authoringMemory.lastUsedProfile === profileId
      || favoriteProfiles.includes(profileId)
      || enabledById[profileId] === true
      || Object.prototype.hasOwnProperty.call(secretBindingsByProfileId, profileId);
    if (!hasHistoricalEvidence || profiles.some((profile) => profile.id === profileId)) continue;
    const current = getBuiltInBackendProfile(profileId);
    if (!current) continue;
    const historical = projectHistoricalBuiltInAiLaunchProfileV1(current);
    customProfiles.push(historical);
    profiles.push(historical);
  }

  const terminalMigratedProfileIds = providerSettings === undefined ? undefined : new Set(
    providerSettings.migration?.completedSources.map(outcome => outcome.sourceProfileId) ?? [],
  );
  const visibleById = new Map<string, CliAiLaunchProfile>();
  for (const builtIn of resolveVisibleBuiltInAiLaunchProfilesV1({
    evidence: {
      lastUsedProfile: authoringMemory.lastUsedProfile,
      favoriteProfileIds: favoriteProfiles,
      profileEnabledById: Object.fromEntries(
        Object.entries(enabledById).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
      ),
      secretBindingsByProfileId,
      persistedProfileIds: profiles.map((profile) => profile.id),
    },
  })) {
    visibleById.set(builtIn.id, builtIn);
  }
  for (const profile of profiles) visibleById.set(profile.id, profile);

  return {
    customProfiles,
    profiles,
    opaqueProfiles,
    diagnostics: collection.diagnostics,
    secretBindingsByProfileId,
    enabledByProfileId,
    visibleProfiles: [...visibleById.values()],
    terminalMigratedProfileIds,
  };
}

export async function loadAccountLaunchProfileArtifacts(settings: unknown, credentials: StoredCredentials, signal?: AbortSignal, profileCatalog?: ProfileCatalogSnapshotV1) {
  const { createCredentialedAccountArtifactStore } = await import('@/api/artifacts/accountArtifactStore');
  const record = isPlainRecord(settings) ? settings : {};
  if (profileCatalog && profileCatalog.status !== 'ready') throw new ProfileCatalogUnavailableError(profileCatalog.status);
  if (profileCatalog?.status === 'ready' && profileCatalog.source === undefined) throw new ProfileCatalogUnavailableError('unavailable');
  const references = profileCatalog?.status === 'ready' && profileCatalog.source === 'destination'
    ? profileCatalog.records.map(({ record }) => record)
    : record.profiles;
  return await loadAiLaunchProfileArtifacts(references, createCredentialedAccountArtifactStore(credentials), signal);
}

export async function readAccountLaunchProfiles(settings: unknown, credentials: StoredCredentials, signal?: AbortSignal, profileCatalog?: ProfileCatalogSnapshotV1) {
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey
      || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
      throw new ProfileCatalogUnavailableError('unavailable');
    }
  };
  assertCurrent();
  const { readAuthoringMemoryLastUsedProfile } = await import('./readAuthoringMemoryLastUsedProfile');
  const catalog = profileCatalog ?? await (await import('./hydrateProfileCatalog')).refreshActiveProfileCatalog({ credentials, signal });
  assertCurrent();
  const source = readProfileSettingsForAccount({ settings, credentials, profileCatalog: catalog });
  const [artifacts, lastUsedProfile] = await Promise.all([
    loadAccountLaunchProfileArtifacts(source, credentials, signal, catalog),
    readAuthoringMemoryLastUsedProfile(credentials, signal),
  ]);
  assertCurrent();
  const observed = getActiveAccountSettingsSnapshot();
  const providerSettings = observed?.providerConnectionsCatalog?.status === 'ready'
    ? readProviderSettingsForCli(observed).settings : undefined;
  return { ...readProfilesFromAccountSettings(source, artifacts, { lastUsedProfile }, catalog, providerSettings), artifactsById: artifacts };
}
