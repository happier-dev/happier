import { normalizePluginAccountCollectionMigrationRuntimeProjection as normalizeAccountMigrations } from '@happier-dev/cli-common/plugins/registration';
import type { PluginAccountCollectionMigration } from '@happier-dev/plugin-sdk/collections';

// Restore author callback signatures after the private owner has admitted the callback map.
export const normalizePluginAccountCollectionMigrationRuntimeProjection = normalizeAccountMigrations<PluginAccountCollectionMigration['migrate']>;
