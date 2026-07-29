import { describe, expect, it } from 'vitest';
import { LegacyProfileMigrationSourceNotFoundError } from '@happier-dev/protocol';

import { ProviderSettingsMigrationError } from '../settings/migrateWithRetry';
import { mapLegacyProfileMigrationFailure } from './rpc';

describe('legacy profile migration RPC error mapping', () => {
  it('maps source drift, conflicts, size limits, missing sources, and malformed settings to stable redacted errors', () => {
    const cases = [
      [new ProviderSettingsMigrationError('legacy_profile_source_changed'), 'provider_profile_migration_source_changed'],
      [new ProviderSettingsMigrationError('migration_conflict'), 'provider_profile_migration_conflict'],
      [new ProviderSettingsMigrationError('migration_conflict_changed'), 'provider_profile_migration_source_changed'],
      [new ProviderSettingsMigrationError('migration_conflict_resolution_invalid'), 'provider_profile_migration_conflict'],
      [new ProviderSettingsMigrationError('provider_settings_limit_exceeded'), 'provider_settings_limit_exceeded'],
      [new LegacyProfileMigrationSourceNotFoundError('company'), 'provider_profile_migration_source_not_found'],
      [new Error('unexpected internal detail'), 'provider_settings_invalid'],
    ] as const;
    for (const [error, code] of cases) {
      const mapped = mapLegacyProfileMigrationFailure(error, 'company');
      expect(mapped).toMatchObject({ code, sourceProfileId: 'company', retryable: false });
      expect(JSON.stringify(mapped)).not.toContain('unexpected internal detail');
    }
  });
});
