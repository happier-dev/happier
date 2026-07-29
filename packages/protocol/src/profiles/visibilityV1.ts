import type { ProviderSettingsMigrationStateV1 } from '../providers/settings/v1.js';
import { isCanonicalProviderSavedSecretIdV1 } from '../providers/settings/v1.js';
import type { AIBackendProfile } from './backendProfileSchema.js';
import {
  DEFAULT_BUILT_IN_BACKEND_PROFILES,
  PROVIDER_MIGRATION_SOURCE_PROFILE_IDS,
} from './builtInBackendProfiles.js';
import { projectHistoricalBuiltInAiLaunchProfileV1 } from './historicalCompatibilityV1.js';

export { projectHistoricalBuiltInAiLaunchProfileV1 } from './historicalCompatibilityV1.js';

export type BuiltInAiLaunchProfileEvidenceV1 = Readonly<{
  lastUsedProfile: string | null;
  favoriteProfileIds: readonly string[];
  profileEnabledById: Readonly<Record<string, boolean>>;
  secretBindingsByProfileId: Readonly<Record<string, Readonly<Record<string, string>>>>;
  persistedProfileIds?: readonly string[];
}>;

/** Canonical post-demotion visibility policy shared by CLI and UI adapters. */
export function resolveVisibleBuiltInAiLaunchProfilesV1(input: Readonly<{
  evidence: BuiltInAiLaunchProfileEvidenceV1;
  migration?: ProviderSettingsMigrationStateV1;
}>): AIBackendProfile[] {
  const exactSecretBindingProfileIds = Object.entries(input.evidence.secretBindingsByProfileId)
    .filter(([, bindings]) => bindings && typeof bindings === 'object' && !Array.isArray(bindings)
      && Object.entries(bindings).some(([, savedSecretId]) => isCanonicalProviderSavedSecretIdV1(savedSecretId)))
    .map(([profileId]) => profileId);
  const evidenceIds = new Set<string>([
    ...(input.evidence.lastUsedProfile ? [input.evidence.lastUsedProfile] : []),
    ...input.evidence.favoriteProfileIds,
    ...Object.entries(input.evidence.profileEnabledById)
      .filter(([, enabled]) => enabled === true)
      .map(([id]) => id),
    ...exactSecretBindingProfileIds,
    ...(input.evidence.persistedProfileIds ?? []),
  ]);
  const completedSourceIds = new Set(
    input.migration?.completedSources.map((outcome) => outcome.sourceProfileId) ?? [],
  );
  const migratableIds = new Set<string>(PROVIDER_MIGRATION_SOURCE_PROFILE_IDS);
  return DEFAULT_BUILT_IN_BACKEND_PROFILES
    .filter((profile) => {
      if (profile.authMode === 'machineLogin') return false;
      if (!evidenceIds.has(profile.id)) return false;
      if (migratableIds.has(profile.id) && completedSourceIds.has(profile.id)) return false;
      return true;
    })
    .map(projectHistoricalBuiltInAiLaunchProfileV1);
}
