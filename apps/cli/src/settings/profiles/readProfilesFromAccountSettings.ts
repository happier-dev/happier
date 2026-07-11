import {
  readAiLaunchProfileCollection,
  readProviderSettingsFromAccountSettingsV1,
  resolveVisibleBuiltInAiLaunchProfilesV1,
  getBuiltInBackendProfile,
  isCanonicalProviderSavedSecretIdV1,
  type AIBackendProfile,
  type AiLaunchProfile,
  type AiLaunchProfileReadDiagnostic,
} from '@happier-dev/protocol';

export type CliAiLaunchProfile = AiLaunchProfile;

export type AccountSettingsProfilesSnapshot = Readonly<{
  customProfiles: AIBackendProfile[];
  profiles: CliAiLaunchProfile[];
  opaqueProfiles: unknown[];
  diagnostics: readonly AiLaunchProfileReadDiagnostic[];
  secretBindingsByProfileId: Record<string, Record<string, string>>;
  visibleProfiles: CliAiLaunchProfile[];
  terminalMigratedProfileIds: ReadonlySet<string>;
}>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function readProfilesFromAccountSettings(settings: unknown): AccountSettingsProfilesSnapshot {
  const record = isPlainRecord(settings) ? settings : {};
  const customProfiles: AIBackendProfile[] = [];
  const profiles: CliAiLaunchProfile[] = [];
  const opaqueProfiles: unknown[] = [];
  const rawProfiles = record.profiles;
  const collection = readAiLaunchProfileCollection(rawProfiles);
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
  const rawBindings = record.secretBindingsByProfileId;
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

  const favoriteProfiles = Array.isArray(record.favoriteProfiles)
    ? record.favoriteProfiles.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const enabledById = isPlainRecord(record.profileEnabledById) ? record.profileEnabledById : {};
  for (const profileId of ['gemini-api-key', 'gemini-vertex'] as const) {
    const hasHistoricalEvidence = record.lastUsedProfile === profileId
      || favoriteProfiles.includes(profileId)
      || enabledById[profileId] === true
      || Object.prototype.hasOwnProperty.call(secretBindingsByProfileId, profileId);
    if (!hasHistoricalEvidence || profiles.some((profile) => profile.id === profileId)) continue;
    const current = getBuiltInBackendProfile(profileId);
    if (!current) continue;
    const historical = {
      ...current,
      environmentVariables: current.environmentVariables.filter((entry) => entry.name !== 'GEMINI_MODEL'),
    };
    customProfiles.push(historical);
    profiles.push(historical);
  }

  const migration = readProviderSettingsFromAccountSettingsV1(record).settings.migration;
  const terminalMigratedProfileIds = new Set(
    migration?.completedSources
      .map((outcome) => outcome.sourceProfileId) ?? [],
  );
  const visibleById = new Map<string, CliAiLaunchProfile>();
  for (const builtIn of resolveVisibleBuiltInAiLaunchProfilesV1({
    evidence: {
      lastUsedProfile: typeof record.lastUsedProfile === 'string' ? record.lastUsedProfile : null,
      favoriteProfileIds: favoriteProfiles,
      profileEnabledById: Object.fromEntries(
        Object.entries(enabledById).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
      ),
      secretBindingsByProfileId,
      persistedProfileIds: profiles.map((profile) => profile.id),
    },
    ...(migration ? { migration } : {}),
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
    visibleProfiles: [...visibleById.values()],
    terminalMigratedProfileIds,
  };
}
