import { z } from 'zod/mini';
import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { BackupDestinationContributionV1Schema, type BackupDestinationContributionV1 } from '@happier-dev/protocol/plugins/contributions/backupDestinations';
import { DeploymentBackupDestinationBindingIdentityV1Schema, environmentSecretBindingIdentityV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DeploymentEnvironmentUpdateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/jsonSchemaValidation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocolComposableSchema';

import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision, DeploymentTextV1Schema as text } from './ids.js';

import { DeploymentBackupSourceV1Schema, DeploymentBackupRetentionV1Schema, DeploymentBackupSnapshotV1Schema,
    DeploymentBackupManifestV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
export { DeploymentBackupSourceV1Schema, DeploymentBackupRetentionV1Schema, DeploymentBackupSnapshotV1Schema,
    DeploymentBackupManifestV1Schema, type DeploymentBackupSourceV1, type DeploymentBackupRetentionV1,
    type DeploymentBackupSnapshotV1, type DeploymentBackupManifestV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';

/** Opaque configuration is preserved JSON; the selected descriptor admits its closed fields before use. */
export const DeploymentBackupConfigurationV1Schema = lazyZodSchema(() => z.strictObject({
    configRevision: revision,
    destinationRef: BackupDestinationContributionV1Schema.shape.actions.shape.open,
    occurrenceId: text,
    config: z.pipe(
        // Preserve root normalization; widen only the static handoff to the record parser.
        z.pipe(StrictJsonValueSchema, z.transform((value: z.output<typeof StrictJsonValueSchema>): unknown => value)),
        z.record(z.string(), StrictJsonValueSchema),
    ),
    credentialBindings: z.array(DeploymentBackupDestinationBindingIdentityV1Schema).check(z.refine(bindings =>
        new Set(bindings.map(environmentSecretBindingIdentityV1)).size === bindings.length,
    { message: 'Backup binding identities must be unique.' })),
    sources: z.array(DeploymentBackupSourceV1Schema).check(z.minLength(1), z.refine(sources =>
        new Set(sources.map(source => source.sourceId)).size === sources.length,
    { message: 'Backup source identities must be unique.' })),
    ownership: z.strictObject({ environmentId: id, prefix: z.string() }),
    retention: DeploymentBackupRetentionV1Schema,
}));
export type DeploymentBackupConfigurationV1 = z.infer<typeof DeploymentBackupConfigurationV1Schema>;
export const DeploymentEnvironmentBackupV1Schema = lazyZodSchema(() => z.union([
    DeploymentBackupConfigurationV1Schema, z.strictObject({ notNeeded: z.literal(true) }),
]));
export type DeploymentEnvironmentBackupV1 = z.infer<typeof DeploymentEnvironmentBackupV1Schema>;

/** Configure's private metadata write retains the existing Artifact CAS, without a generic patch. */
export const DeploymentEnvironmentBackupSetInputV1Schema = lazyZodSchema(() => z.omit(DeploymentEnvironmentUpdateInputV1Schema, { patch: true }));
export type DeploymentEnvironmentBackupSetInputV1 = z.infer<typeof DeploymentEnvironmentBackupSetInputV1Schema>;

/** Nonsecret recovery operands retained in the existing pre-migration receipt.
 * Credentials are acquired afresh through P42; restore names belong to admission. */
export const DeploymentPreMigrationBackupV1Schema = lazyZodSchema(() => z.strictObject({
    source: DeploymentBackupManifestV1Schema,
    sourceFormat: z.literal('postgresCustom'),
    target: z.strictObject({ service: text, adapter: z.literal('postgres-v1'), database: text }),
    configuration: DeploymentBackupConfigurationV1Schema,
    repository: z.strictObject({ repository: text, s3: z.optional(z.strictObject({
        region: z.optional(text), addressing: z.optional(z.enum(['auto', 'dns', 'path'])),
    })) }),
}));
export type DeploymentPreMigrationBackupV1 = z.infer<typeof DeploymentPreMigrationBackupV1Schema>;

/** Nonsecret evidence a restore prepare retains in its Action operation: the exact backup it checked, the
 * destination it will replace and, when that destination held data, the verified safety backup. The native
 * host writes it; the confirm and the person's sheet read the same shape. */
const restoreDestination = lazyZodSchema(() => z.strictObject({ ...DeploymentPreMigrationBackupV1Schema.shape.target.shape,
    environmentId: DeploymentBackupManifestV1Schema.shape.environmentId,
    revision: DeploymentBackupManifestV1Schema.shape.configRevision,
    stagingDatabase: z.string(), recoveryDatabase: z.string(),
    databaseExists: z.boolean(), hasMeaningfulData: z.boolean(), writerServices: z.array(z.string()),
}));
export const DeploymentRestorePreparationV1Schema = lazyZodSchema(() => z.strictObject({
    prepared: z.strictObject({ kind: z.literal('prepared'), operationId: z.string(),
        source: DeploymentPreMigrationBackupV1Schema.shape.source, sourceFormat: DeploymentPreMigrationBackupV1Schema.shape.sourceFormat,
        destination: restoreDestination, repository: DeploymentPreMigrationBackupV1Schema.shape.repository,
        safetyBackup: z.optional(z.strictObject({ kind: z.literal('verified'),
            manifests: z.array(DeploymentPreMigrationBackupV1Schema.shape.source) })),
    }),
    configuration: DeploymentBackupConfigurationV1Schema,
}));
export type DeploymentRestorePreparationV1 = z.infer<typeof DeploymentRestorePreparationV1Schema>;

/** The catalog has admitted the descriptor; its schema alone decides the nonsecret user fields. */
export function validateDeploymentBackupDestinationConfigurationV1(input: Readonly<{
    descriptor: BackupDestinationContributionV1; config: unknown;
}>): boolean {
    return isValidPluginJsonSchemaValue(compilePluginJsonSchema(input.descriptor.configSchema), input.config);
}
