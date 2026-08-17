import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

/** Serializable migration identity. Executable migration callbacks remain candidate code. */
export const PluginDaemonDatabaseMigrationDeclarationV1Schema = z.object({
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  id: asProtocolZod(PluginContributionLocalIdSchema),
}).strict();
export type PluginDaemonDatabaseMigrationDeclarationV1 =
  z.infer<typeof PluginDaemonDatabaseMigrationDeclarationV1Schema>;

/**
 * Static manifest declaration for one plugin-local daemon database.
 *
 * Runtime migrations and the incumbent fixture are deliberately not part of this
 * serialized contract. Candidate activation binds their exact identities later.
 */
export const PluginDaemonDatabaseContributionV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  migrations: z.array(PluginDaemonDatabaseMigrationDeclarationV1Schema),
  incumbentQueryFixtureId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict().superRefine((value, context) => {
  const migrationIds = new Set<string>();
  let previousVersion = 0;

  value.migrations.forEach((migration, index) => {
    if (migration.version <= previousVersion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['migrations', index, 'version'],
        message: 'Daemon database migration versions must be strictly ascending.',
      });
    }
    previousVersion = migration.version;

    if (migrationIds.has(migration.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['migrations', index, 'id'],
        message: 'Daemon database migration ids must be unique.',
      });
    }
    migrationIds.add(migration.id);
  });
});
export type PluginDaemonDatabaseContributionV1 = z.infer<typeof PluginDaemonDatabaseContributionV1Schema>;
