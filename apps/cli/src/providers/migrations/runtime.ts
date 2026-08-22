import { randomUUID } from 'node:crypto';

import type { Credentials } from '@/persistence';
import {
  applyReviewedLegacyProfileMigrationConflictV1,
  type AccountSettings,
  type LegacyProfileMigrationConflictResolutionV1,
  type LegacyProfileReviewedMappingV1,
} from '@happier-dev/protocol';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

import {
  allocateLegacyProfileMigrationConnectionIds,
  createLegacyProfileMigrationCoordinator,
  readLegacyProfileMigrationContributionMap,
} from './coordinator';
import { buildLegacyProfileMigrationContext } from './buildContext';
import { authorizeLegacyProfileMigrationContext } from './authorizeContext';
import {
  confirmLegacyProfileMigrationWithRetry,
  migrateProviderSettingsWithRetry,
  previewLegacyProfileMigrationWithRetry,
  ProviderSettingsMigrationError,
} from '../settings/migrateWithRetry';

const coordinator = createLegacyProfileMigrationCoordinator({
  acquireRegistryLease: acquireAuthoritativePluginRuntimeRegistryLease,
  migrate: migrateProviderSettingsWithRetry,
  processEnv: process.env,
});

export function triggerLegacyProfileMigration(input: Readonly<{
  credentials: Credentials;
  providersEnabled: boolean;
  machineId: string;
}>) {
  return coordinator.ensureMigrated({
    accountKey: resolveAccountSettingsScopeKey(input.credentials),
    credentials: input.credentials,
    providersEnabled: input.providersEnabled,
    machineId: input.machineId,
  });
}

export function confirmLegacyProfileMigration(input: Readonly<{
  credentials: Credentials;
  sourceProfileId: string;
  expectedSourceFingerprint: string;
  reviewedMapping: LegacyProfileReviewedMappingV1;
  migratedAt: number;
}>): Promise<Readonly<{ version: number; settings: AccountSettings }>> {
  return confirmLegacyProfileMigrationWithRetry({
    ...input,
  });
}

export function previewLegacyProfileMigration(input: Readonly<{
  credentials: Credentials;
  sourceProfileId: string;
  reviewedMapping: LegacyProfileReviewedMappingV1;
}>) {
  return previewLegacyProfileMigrationWithRetry({
    ...input,
  });
}

export async function confirmLegacyProfileMigrationConflict(input: Readonly<{
  credentials: Credentials;
  machineId: string;
  resolution: LegacyProfileMigrationConflictResolutionV1;
  migratedAt: number;
}>) {
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  try {
    const contributionMap = readLegacyProfileMigrationContributionMap(lease.registry);
    const allocatedConnectionIdsBySourceProfileId = allocateLegacyProfileMigrationConnectionIds(
      contributionMap,
      () => `pc_migration_${randomUUID()}`,
    );
    return await migrateProviderSettingsWithRetry({
      credentials: input.credentials,
      acquireRegistryLease: async () => ({ registry: lease.registry, release: async () => undefined }),
      deriveContext: async (latestRawSettings, registry) => {
        const providersByContributionKey = readLegacyProfileMigrationContributionMap(registry) as ReadonlyMap<
          string,
          ResolvedProviderContribution
        >;
        const baseContext = buildLegacyProfileMigrationContext({
          rawSettings: latestRawSettings,
          providersByContributionKey,
          allocatedConnectionIdsBySourceProfileId,
          migratedAt: input.migratedAt,
          processEnv: process.env,
        });
        const authoritativeContext = await authorizeLegacyProfileMigrationContext({
          rawSettings: latestRawSettings,
          context: baseContext,
          providersByContributionKey,
          machineId: input.machineId,
        });
        const resolved = applyReviewedLegacyProfileMigrationConflictV1(
          latestRawSettings,
          baseContext,
          authoritativeContext,
          input.resolution,
        );
        if (!resolved.ok) throw new ProviderSettingsMigrationError(resolved.reason);
        const reauthorized = await authorizeLegacyProfileMigrationContext({
          rawSettings: latestRawSettings,
          context: resolved.context,
          providersByContributionKey,
          machineId: input.machineId,
        });
        return {
          ...reauthorized,
          pendingConflicts: resolved.context.pendingConflicts,
        };
      },
    });
  } finally {
    await lease.release();
  }
}
