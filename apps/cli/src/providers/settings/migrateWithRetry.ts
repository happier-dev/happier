import type { Credentials } from '@/persistence';
import {
  migrateLegacyAiLaunchProfilesV1,
  confirmLegacyAiLaunchProfileMigrationV1,
  createLegacyProfileMigrationSourceFingerprintV1,
  type AccountSettings,
  type ProviderAccountSettingsMigrationContextV1,
  type ProviderSettingsMigrationSourceOutcomeV1,
  type LegacyProfileReviewedMappingV1,
  type LegacyProfileMigrationConflictResolutionV1,
} from '@happier-dev/protocol';

import {
  updateAccountSettingsV2WithRetry,
  type AccountSettingsUpdateV2Deps,
} from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

export async function previewLegacyProfileMigrationWithRetry(params: Readonly<{
  credentials: Credentials;
  sourceProfileId: string;
  reviewedMapping: LegacyProfileReviewedMappingV1;
  acquireRegistryLease: () => Promise<Readonly<{ registry: unknown; release: () => Promise<void> }>>;
  deps?: AccountSettingsUpdateV2Deps;
  maxAttempts?: number;
}>): Promise<Readonly<{ version: number; sourceFingerprint: string }>> {
  const lease = await params.acquireRegistryLease();
  let sourceFingerprint: string | null = null;
  try {
    const result = await updateAccountSettingsV2WithRetry({
      credentials: params.credentials,
      deps: params.deps,
      maxAttempts: params.maxAttempts,
      mutate: (settings) => {
        sourceFingerprint = createLegacyProfileMigrationSourceFingerprintV1({
          rawSettings: settings,
          sourceProfileId: params.sourceProfileId,
          reviewedMapping: params.reviewedMapping,
        });
        return settings;
      },
    });
    if (sourceFingerprint === null) {
      throw new ProviderSettingsMigrationError('legacy_profile_source_changed');
    }
    return { version: result.version, sourceFingerprint };
  } finally {
    await lease.release();
  }
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

export async function confirmLegacyProfileMigrationWithRetry(params: Readonly<{
  credentials: Credentials;
  sourceProfileId: string;
  expectedSourceFingerprint: string;
  reviewedMapping: LegacyProfileReviewedMappingV1;
  migratedAt: number;
  acquireRegistryLease: () => Promise<Readonly<{ registry: unknown; release: () => Promise<void> }>>;
  deps?: AccountSettingsUpdateV2Deps;
  maxAttempts?: number;
}>) {
  const lease = await params.acquireRegistryLease();
  try {
    return await updateAccountSettingsV2WithRetry({
      credentials: params.credentials,
      deps: params.deps,
      maxAttempts: params.maxAttempts,
      mutate: (settings) => {
        const migrated = confirmLegacyAiLaunchProfileMigrationV1({
          rawSettings: settings,
          sourceProfileId: params.sourceProfileId,
          expectedSourceFingerprint: params.expectedSourceFingerprint,
          reviewedMapping: params.reviewedMapping,
          migratedAt: params.migratedAt,
        });
        if (!migrated.ok) throw new ProviderSettingsMigrationError(migrated.reason);
        return migrated.settings;
      },
    });
  } finally {
    await lease.release();
  }
}

export async function migrateProviderSettingsWithRetry(params: Readonly<{
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
  maxAttempts?: number;
}>): Promise<Readonly<{
  version: number;
  settings?: AccountSettings;
  outcomes: readonly ProviderSettingsMigrationSourceOutcomeV1[];
}>> {
  let outcomes: readonly ProviderSettingsMigrationSourceOutcomeV1[] = [];
  const lease = await params.acquireRegistryLease();
  try {
    const result = await updateAccountSettingsV2WithRetry({
      credentials: params.credentials,
      deps: params.deps,
      maxAttempts: params.maxAttempts,
      mutate: async (settings) => {
        const context = await params.deriveContext(settings, lease.registry);
        const migrated = migrateLegacyAiLaunchProfilesV1(settings, context);
        if (!migrated.ok) throw new ProviderSettingsMigrationError(migrated.reason);
        outcomes = migrated.outcomes;
        return migrated.settings;
      },
    });
    return { ...result, outcomes };
  } finally {
    await lease.release();
  }
}
