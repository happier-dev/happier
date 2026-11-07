import { normalizePluginAccountCollectionMigrationRuntimeProjection as normalizeAccountMigrations, normalizePluginDaemonDatabaseRuntimeProjection as normalizeDaemonDatabases } from '@happier-dev/cli-common/plugins/registration';
import type { PluginAccountCollectionMigration } from '@happier-dev/plugin-sdk/collections';
import type { DaemonDatabaseMigration, DaemonDatabaseIncumbentQueryFixture } from '@happier-dev/plugin-sdk/storage';

// Restore author callback signatures after the private owner has admitted the callback map.
export const normalizePluginAccountCollectionMigrationRuntimeProjection = normalizeAccountMigrations<PluginAccountCollectionMigration['migrate']>;
export const normalizePluginDaemonDatabaseRuntimeProjection = normalizeDaemonDatabases<DaemonDatabaseMigration['up'], DaemonDatabaseIncumbentQueryFixture['run']>;
