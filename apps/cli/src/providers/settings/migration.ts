import type { Credentials } from '@/persistence';
import { migrateLegacyAiLaunchProfilesV1, confirmLegacyAiLaunchProfileMigrationV1, createLegacyProfileMigrationSourceFingerprintV1 } from '@happier-dev/protocol/providers/migrations/legacyProfilesV1';
import type { AccountSettings, ProviderAccountSettingsMigrationContextV1, ProviderSettingsMigrationSourceOutcomeV1, LegacyProfileReviewedMappingV1, LegacyProfileMigrationConflictResolutionV1, LegacyProfileAuthoringMemoryClearV1 } from '@happier-dev/protocol';

import {
  requireAccountSettingsMutationSuccess,
  updateAccountSettingsV2OnceAgainstLatest,
  type AccountSettingsUpdateV2Deps,
} from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import {
  readAuthoringMemoryLastUsedProfile,
  clearAuthoringMemoryLastUsedProfileIfEqual,
} from '@/settings/profiles/readAuthoringMemoryLastUsedProfile';

export async function previewLegacyProfileMigration(params: Readonly<{
  credentials: Credentials;
  sourceProfileId: string;
  reviewedMapping: LegacyProfileReviewedMappingV1;
  deps?: AccountSettingsUpdateV2Deps;
}>): Promise<Readonly<{ version: number; sourceFingerprint: string }>> {
  const authoringMemory = { lastUsedProfile: await readAuthoringMemoryLastUsedProfile(params.credentials) };
  let sourceFingerprint: string | null = null;
  const result = requireAccountSettingsMutationSuccess(await updateAccountSettingsV2OnceAgainstLatest({
    credentials: params.credentials,
    deps: params.deps,
    mutate: (settings) => {
      sourceFingerprint = createLegacyProfileMigrationSourceFingerprintV1({
        rawSettings: settings,
        authoringMemory,
        sourceProfileId: params.sourceProfileId,
        reviewedMapping: params.reviewedMapping,
      });
      return settings;
    },
  }));
  if (sourceFingerprint === null) {
    throw new ProviderSettingsMigrationError('legacy_profile_source_changed');
  }
  return { version: result.version, sourceFingerprint };
}

export class ProviderSettingsMigrationError extends Error {
  readonly reason: Exclude<
    ReturnType<typeof migrateLegacyAiLaunchProfilesV1>,
    { ok: true }
  >['reason'] | 'legacy_profile_source_changed' | 'migration_conflict_changed' | 'migration_conflict_resolution_invalid';

  constructor(reason: ProviderSettingsMigrationError['reason']) {
    super(`Provider settings migration refused: ${reason}`);
    this.name = 'ProviderSettingsMigrationError';
    this.reason = reason;
  }
}

export async function confirmLegacyProfileMigration(params: Readonly<{
  credentials: Credentials;
  sourceProfileId: string;
  expectedSourceFingerprint: string;
  reviewedMapping: LegacyProfileReviewedMappingV1;
  migratedAt: number;
  deps?: AccountSettingsUpdateV2Deps;
}>): Promise<Readonly<{ version: number; settings: AccountSettings }>> {
  const authoringMemory = { lastUsedProfile: await readAuthoringMemoryLastUsedProfile(params.credentials) };
  const clear: { value?: LegacyProfileAuthoringMemoryClearV1 } = {};
  const result = requireAccountSettingsMutationSuccess(await updateAccountSettingsV2OnceAgainstLatest({
    credentials: params.credentials,
    deps: params.deps,
    mutate: (settings) => {
      const migrated = confirmLegacyAiLaunchProfileMigrationV1({
        rawSettings: settings,
        authoringMemory,
        sourceProfileId: params.sourceProfileId,
        expectedSourceFingerprint: params.expectedSourceFingerprint,
        reviewedMapping: params.reviewedMapping,
        migratedAt: params.migratedAt,
      });
      if (!migrated.ok) throw new ProviderSettingsMigrationError(migrated.reason);
      clear.value = migrated.lastUsedProfileClear;
      return migrated.settings;
    },
  }));
  if (clear.value) await clearAuthoringMemoryLastUsedProfileIfEqual(params.credentials, clear.value.base);
  return { version: result.version, settings: result.settings };
}

/**
 * One semantic migration: the callback is evaluated once against the latest
 * fetched version and exactly one CAS is submitted. A conflict is a terminal
 * outcome, never a hidden re-run of the migration against the winner.
 */
export async function migrateProviderSettings(params: Readonly<{
  credentials: Credentials;
  acquireRegistryLease: () => Promise<Readonly<{
    registry: unknown;
    release: () => Promise<void>;
  }>>;
  deriveContext: (
    latestRawSettings: Readonly<Record<string, unknown>>,
    acceptedRegistry: unknown,
  ) => ProviderAccountSettingsMigrationContextV1 | Promise<ProviderAccountSettingsMigrationContextV1>;
  deps?: AccountSettingsUpdateV2Deps;
}>): Promise<Readonly<{
  version: number;
  settings?: AccountSettings;
  outcomes: readonly ProviderSettingsMigrationSourceOutcomeV1[];
}>> {
  let outcomes: readonly ProviderSettingsMigrationSourceOutcomeV1[] = [];
  const clear: { value?: LegacyProfileAuthoringMemoryClearV1 } = {};
  const lease = await params.acquireRegistryLease();
  try {
    const authoringMemory = { lastUsedProfile: await readAuthoringMemoryLastUsedProfile(params.credentials) };
    const result = requireAccountSettingsMutationSuccess(await updateAccountSettingsV2OnceAgainstLatest({
      credentials: params.credentials,
      deps: params.deps,
      mutate: async (settings) => {
        const context = await params.deriveContext(settings, lease.registry);
        const migrated = migrateLegacyAiLaunchProfilesV1(settings, context, authoringMemory);
        if (!migrated.ok) throw new ProviderSettingsMigrationError(migrated.reason);
        outcomes = migrated.outcomes;
        clear.value = migrated.lastUsedProfileClear;
        return migrated.settings;
      },
    }));
    if (clear.value) await clearAuthoringMemoryLastUsedProfileIfEqual(params.credentials, clear.value.base);
    return { version: result.version, settings: result.settings, outcomes };
  } finally {
    await lease.release();
  }
}
