import { describe, expect, it } from 'vitest';

import {
  PluginDaemonDatabaseContributionV1Schema,
  PluginDaemonDatabaseMigrationDeclarationV1Schema,
} from './daemonDatabases.js';
import {
  PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1,
  PLUGIN_DAEMON_DATABASE_PROTOCOL_MAXIMUM_BYTES_V1,
} from '../data/daemonDatabaseLimitsV1.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from './catalog.js';
import { PluginContributesV2Schema } from './v2.js';
import { ingestPluginManifestV2 } from '../manifest/ingest.js';

const declaredDatabase = {
  id: 'main',
  migrations: [
    { version: 1, id: 'create-records' },
    { version: 3, id: 'drop-legacy-columns' },
  ],
  incumbentQueryFixtureId: 'records-v2',
} as const;

describe('daemon database manifest declarations', () => {
  it('keeps the evidence-backed Preview host default bounded below the protocol hard ceiling', () => {
    expect(PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumDatabaseBytes)
      .toBeLessThanOrEqual(PLUGIN_DAEMON_DATABASE_PROTOCOL_MAXIMUM_BYTES_V1);
    expect(PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumDatabaseBytes).toBeGreaterThan(0);
    expect(PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumInputBytes).toBeGreaterThan(0);
    expect(PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumResultBytes).toBeGreaterThan(0);
    expect(PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumResultRows).toBeGreaterThan(0);
    expect(PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumAffectedRows).toBeGreaterThan(0);
    expect(PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumElapsedMs).toBeGreaterThan(0);
  });

  it('admits only ordered serializable identities through the canonical manifest family', () => {
    expect(PluginDaemonDatabaseContributionV1Schema.parse(declaredDatabase)).toEqual(declaredDatabase);
    expect(PluginDaemonDatabaseContributionV1Schema.parse({
      id: 'empty',
      migrations: [],
      incumbentQueryFixtureId: 'empty-v1',
    })).toEqual({
      id: 'empty',
      migrations: [],
      incumbentQueryFixtureId: 'empty-v1',
    });
    expect(PluginContributesV2Schema.parse({ daemonDatabases: [declaredDatabase] }).daemonDatabases)
      .toEqual([declaredDatabase]);
    expect(ingestPluginManifestV2({
      schemaVersion: 2,
      id: 'com.acme.database',
      version: '1.0.0',
      displayName: 'Database fixture',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      hostAccess: { required: [], optional: [] },
      contributes: { daemonDatabases: [declaredDatabase] },
    })).toMatchObject({
      ok: true,
      manifest: { contributes: { daemonDatabases: [declaredDatabase] } },
    });
    expect(PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'daemonDatabases'))
      .toMatchObject({
        identityField: 'id',
        activationDemand: 'none',
        allowedRuntimeRegistration: null,
        consumer: 'daemon-database-service',
      });
  });

  it('rejects a runtime callback and any changed migration identity or order', () => {
    expect(() => PluginDaemonDatabaseContributionV1Schema.parse({
      ...declaredDatabase,
      migrations: [{ ...declaredDatabase.migrations[0], up: async () => undefined }],
    })).toThrow();
    expect(() => PluginDaemonDatabaseContributionV1Schema.parse({
      ...declaredDatabase,
      incumbentQueryFixture: { id: 'records-v2', run: async () => undefined },
    })).toThrow();
    expect(() => PluginDaemonDatabaseContributionV1Schema.parse({
      ...declaredDatabase,
      migrations: [{ version: 3, id: 'drop-legacy-columns' }, { version: 1, id: 'create-records' }],
    })).toThrow('strictly ascending');
    expect(() => PluginDaemonDatabaseContributionV1Schema.parse({
      ...declaredDatabase,
      migrations: [{ version: 1, id: 'create-records' }, { version: 2, id: 'create-records' }],
    })).toThrow('unique');
    expect(() => PluginDaemonDatabaseMigrationDeclarationV1Schema.parse({ version: 0, id: 'valid-id' }))
      .toThrow();
    expect(() => PluginDaemonDatabaseMigrationDeclarationV1Schema.parse({ version: 1, id: 'not valid' }))
      .toThrow();
  });

  it('does not admit duplicate database declarations under a plugin', () => {
    expect(() => PluginContributesV2Schema.parse({
      daemonDatabases: [declaredDatabase, { ...declaredDatabase, incumbentQueryFixtureId: 'records-v3' }],
    })).toThrow('Duplicate daemon database contribution id');
  });
});
