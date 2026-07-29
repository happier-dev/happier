import type { Credentials } from '@/persistence';
import {
  createProviderErrorV1,
  LegacyProfileMigrationSourceNotFoundError,
  type ProviderErrorV1,
} from '@happier-dev/protocol';
import type {
  DaemonProviderProfileMigrationConfirmRequestV1,
  DaemonProviderProfileMigrationConfirmResponseV1,
  DaemonProviderProfileMigrationPreviewRequestV1,
  DaemonProviderProfileMigrationPreviewResponseV1,
  DaemonProviderProfileMigrationConflictConfirmRequestV1,
  DaemonProviderProfileMigrationConflictConfirmResponseV1,
} from '@happier-dev/protocol/rpc';

import { ProviderSettingsMigrationError } from '../settings/migrateWithRetry';
import { confirmLegacyProfileMigration, confirmLegacyProfileMigrationConflict, previewLegacyProfileMigration } from './runtime';

export function mapLegacyProfileMigrationFailure(error: unknown, sourceProfileId: string): ProviderErrorV1 {
  if (error instanceof LegacyProfileMigrationSourceNotFoundError) {
    return createProviderErrorV1('provider_profile_migration_source_not_found', { sourceProfileId });
  }
  if (error instanceof ProviderSettingsMigrationError) {
    if (error.reason === 'legacy_profile_source_changed') {
      return createProviderErrorV1('provider_profile_migration_source_changed', { sourceProfileId });
    }
    if (error.reason === 'migration_conflict_changed') {
      return createProviderErrorV1('provider_profile_migration_source_changed', { sourceProfileId });
    }
    if (error.reason === 'migration_conflict_resolution_invalid') {
      return createProviderErrorV1('provider_profile_migration_conflict', { sourceProfileId });
    }
    if (error.reason === 'migration_conflict') {
      return createProviderErrorV1('provider_profile_migration_conflict', { sourceProfileId });
    }
    if (error.reason === 'provider_settings_limit_exceeded') {
      return createProviderErrorV1('provider_settings_limit_exceeded', { sourceProfileId });
    }
  }
  return createProviderErrorV1('provider_settings_invalid', { sourceProfileId });
}

export function createLegacyProfileMigrationRpcServices(input: Readonly<{
  credentials: Credentials;
  now?: () => number;
}>): Readonly<{
  previewProfileMigration(
    request: DaemonProviderProfileMigrationPreviewRequestV1,
  ): Promise<DaemonProviderProfileMigrationPreviewResponseV1>;
  confirmProfileMigration(
    request: DaemonProviderProfileMigrationConfirmRequestV1,
  ): Promise<DaemonProviderProfileMigrationConfirmResponseV1>;
  confirmProfileMigrationConflict(
    request: DaemonProviderProfileMigrationConflictConfirmRequestV1,
  ): Promise<DaemonProviderProfileMigrationConflictConfirmResponseV1>;
}> {
  return Object.freeze({
    previewProfileMigration: async (request) => {
      try {
        const result = await previewLegacyProfileMigration({
          credentials: input.credentials,
          sourceProfileId: request.sourceProfileId,
          reviewedMapping: request.reviewedMapping,
        });
        return {
          status: 'success',
          sourceProfileId: request.sourceProfileId,
          sourceFingerprint: result.sourceFingerprint,
        };
      } catch (error) {
        return { status: 'error', error: mapLegacyProfileMigrationFailure(error, request.sourceProfileId) };
      }
    },
    confirmProfileMigration: async (request) => {
      try {
        const result = await confirmLegacyProfileMigration({
          credentials: input.credentials,
          sourceProfileId: request.sourceProfileId,
          expectedSourceFingerprint: request.expectedSourceFingerprint,
          reviewedMapping: request.reviewedMapping,
          migratedAt: (input.now ?? Date.now)(),
        });
        return {
          status: 'success',
          sourceProfileId: request.sourceProfileId,
          connectionId: request.reviewedMapping.connection.id,
          settingsVersion: result.version,
        };
      } catch (error) {
        return { status: 'error', error: mapLegacyProfileMigrationFailure(error, request.sourceProfileId) };
      }
    },
    confirmProfileMigrationConflict: async (request) => {
      try {
        const result = await confirmLegacyProfileMigrationConflict({
          credentials: input.credentials,
          machineId: request.machineId,
          resolution: {
            sourceProfileId: request.sourceProfileId,
            expectedCandidateFingerprint: request.expectedCandidateFingerprint,
            decision: request.decision,
          },
          migratedAt: (input.now ?? Date.now)(),
        });
        const connectionId = request.decision.kind === 'keep_existing'
          ? request.decision.existingConnectionId
          : request.decision.connectionId;
        return {
          status: 'success', sourceProfileId: request.sourceProfileId,
          connectionId, settingsVersion: result.version,
        };
      } catch (error) {
        return { status: 'error', error: mapLegacyProfileMigrationFailure(error, request.sourceProfileId) };
      }
    },
  });
}
