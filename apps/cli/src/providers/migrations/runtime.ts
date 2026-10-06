import { randomUUID } from 'node:crypto';

import type { Credentials } from '@/persistence';
import { applyReviewedLegacyProfileMigrationConflictV1 } from '@happier-dev/protocol/providers/migrations/conflictsV1';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import type { AccountSettings, LegacyProfileMigrationConflictResolutionV1, LegacyProfileReviewedMappingV1 } from '@happier-dev/protocol';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readAuthoringMemoryLastUsedProfile } from '@/settings/profiles/readAuthoringMemoryLastUsedProfile';
import {
  awaitWithinProviderOperation,
  createProviderOperationLifetime,
} from '@/providers/operationLifetime';

import {
  allocateLegacyProfileMigrationConnectionIds,
  createLegacyProfileMigrationCoordinator,
  readLegacyProfileMigrationContributionMap,
} from './coordinator';
import { buildLegacyProfileMigrationContext } from './buildContext';
import { authorizeLegacyProfileMigrationContext } from './authorizeContext';
import {
  confirmLegacyProfileMigration as confirmLegacyProfileMigrationOnce,
  migrateProviderSettings,
  previewLegacyProfileMigration as previewLegacyProfileMigrationOnce,
  ProviderSettingsMigrationError,
} from '../settings/migration';

const coordinator = createLegacyProfileMigrationCoordinator({
  acquireRegistryLease: acquireAuthoritativePluginRuntimeRegistryLease,
  migrate: migrateProviderSettings,
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
    readAuthoringMemory: async () => ({ lastUsedProfile: await readAuthoringMemoryLastUsedProfile(input.credentials) }),
  });
}

export function confirmLegacyProfileMigration(input: Readonly<{
  credentials: Credentials;
  sourceProfileId: string;
  expectedSourceFingerprint: string;
  reviewedMapping: LegacyProfileReviewedMappingV1;
  migratedAt: number;
}>): Promise<Readonly<{ version: number; settings: AccountSettings }>> {
  return confirmLegacyProfileMigrationOnce({
    ...input,
  });
}

export function previewLegacyProfileMigration(input: Readonly<{
  credentials: Credentials;
  sourceProfileId: string;
  reviewedMapping: LegacyProfileReviewedMappingV1;
}>) {
  return previewLegacyProfileMigrationOnce({
    ...input,
  });
}

export async function confirmLegacyProfileMigrationConflict(input: Readonly<{
  credentials: Credentials;
  machineId: string;
  resolution: LegacyProfileMigrationConflictResolutionV1;
  migratedAt: number;
}>) {
  const lifetime = createProviderOperationLifetime({
    wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
  });
  const pendingLease = acquireAuthoritativePluginRuntimeRegistryLease();
  let lease: Awaited<typeof pendingLease>;
  try {
    lease = await awaitWithinProviderOperation(pendingLease, lifetime);
  } catch (error) {
    void pendingLease.then((lateLease) => lateLease.release(), () => {});
    throw error;
  }
  try {
    const contributionMap = readLegacyProfileMigrationContributionMap(lease.registry);
    const allocatedConnectionIdsBySourceProfileId = allocateLegacyProfileMigrationConnectionIds(
      contributionMap,
      () => `pc_migration_${randomUUID()}`,
    );
    return await migrateProviderSettings({
      credentials: input.credentials,
      acquireRegistryLease: async () => ({ registry: lease.registry, release: async () => undefined }),
      deriveContext: async (latestRawSettings, registry) => {
        const providersByContributionKey = readLegacyProfileMigrationContributionMap(registry) as ReadonlyMap<
          string,
          ResolvedProviderContribution
        >;
        const baseContext = buildLegacyProfileMigrationContext({
          rawSettings: latestRawSettings,
          authoringMemory: { lastUsedProfile: await awaitWithinProviderOperation(
            readAuthoringMemoryLastUsedProfile(input.credentials, lifetime.signal), lifetime,
          ) },
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
          lifetime,
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
          lifetime,
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
