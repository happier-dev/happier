import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

/** Serializable migration identity. Executable migration callbacks remain candidate code. */
export const PluginDaemonDatabaseMigrationDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)),
  id: asProtocolZod(PluginContributionLocalIdSchema),
}));
export type PluginDaemonDatabaseMigrationDeclarationV1 =
  z.infer<typeof PluginDaemonDatabaseMigrationDeclarationV1Schema>;

/** Epoch-millisecond rows governed by MachineStoragePolicyV1.logRetentionDays. */
export const PluginDaemonDatabaseRetentionDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  table: z.string().check(z.minLength(1)),
  timeColumn: z.string().check(z.minLength(1)),
}));

/**
 * Static manifest declaration for one plugin-local daemon database.
 *
 * Runtime migrations and the incumbent fixture are deliberately not part of this
 * serialized contract. Candidate activation binds their exact identities later.
 */
export const PluginDaemonDatabaseContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  migrations: z.array(PluginDaemonDatabaseMigrationDeclarationV1Schema),
  incumbentQueryFixtureId: asProtocolZod(PluginContributionLocalIdSchema),
  retention: z.optional(z.array(PluginDaemonDatabaseRetentionDeclarationV1Schema)),
}).check(z.superRefine((value, context) => {
  const migrationIds = new Set<string>();
  let previousVersion = 0;

  value.migrations.forEach((migration, index) => {
    if (migration.version <= previousVersion) {
      context.addIssue({
        code: "custom",
        path: ['migrations', index, 'version'],
        message: 'Daemon database migration versions must be strictly ascending.',
      });
    }
    previousVersion = migration.version;

    if (migrationIds.has(migration.id)) {
      context.addIssue({
        code: "custom",
        path: ['migrations', index, 'id'],
        message: 'Daemon database migration ids must be unique.',
      });
    }
    migrationIds.add(migration.id);
  });
})));
export type PluginDaemonDatabaseContributionV1 = z.infer<typeof PluginDaemonDatabaseContributionV1Schema>;
