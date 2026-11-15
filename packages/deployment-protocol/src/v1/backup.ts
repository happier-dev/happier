import { z } from 'zod/mini';
import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import type { BackupDestinationContributionV1 } from '@happier-dev/protocol/plugins/contributions/backupDestinations';
import { DeploymentEnvironmentUpdateInputV1BaseSchema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/jsonSchemaValidation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocolComposableSchema';
import { DeploymentRestoreStepV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
export { DeploymentRestoreStepV1Schema, deploymentRestoreStepProgressV1, readDeploymentRestoreStepProgressV1,
    type DeploymentRestoreStepV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

import { DeploymentBackupManifestV1Schema, DeploymentBackupConfigurationV1Schema,
    DeploymentPreMigrationBackupV1Schema, DeploymentSqliteBackupV1Schema, DeploymentBackupRestoreCaptureV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
export { DeploymentBackupSourceV1Schema, DeploymentBackupRetentionV1Schema, DeploymentBackupSnapshotV1Schema,
    DeploymentBackupNativeFailureV1Schema, type DeploymentBackupNativeFailureV1,
    readDeploymentBackupMaintenanceFailureEvidenceV1, type DeploymentBackupMaintenanceFailureEvidenceV1,
    DeploymentBackupFailureResultV1Schema, type DeploymentBackupFailureResultV1,
    DeploymentBackupConfigurationV1Schema, type DeploymentBackupConfigurationV1,
    DeploymentPreMigrationBackupV1Schema, type DeploymentPreMigrationBackupV1,
    DeploymentSqliteBackupV1Schema, type DeploymentSqliteBackupV1,
    DeploymentBackupRestoreCaptureV1Schema, type DeploymentBackupRestoreCaptureV1,
    DeploymentBackupManifestV1Schema, type DeploymentBackupTestResultV1, type DeploymentBackupSourceV1, type DeploymentBackupRetentionV1,
    type DeploymentBackupSnapshotV1, type DeploymentBackupManifestV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';

export const DeploymentEnvironmentBackupV1Schema = lazyZodSchema(() => z.union([
    DeploymentBackupConfigurationV1Schema, z.strictObject({ notNeeded: z.literal(true) }),
]));
export type DeploymentEnvironmentBackupV1 = z.infer<typeof DeploymentEnvironmentBackupV1Schema>;

/** Configure's private metadata write retains the existing Artifact CAS, without a generic patch. */
export const DeploymentEnvironmentBackupSetInputV1Schema = lazyZodSchema(() => z.omit(DeploymentEnvironmentUpdateInputV1BaseSchema, {
    patch: true, mode: true, defaultsFor: true, creationDefaults: true,
}));
export type DeploymentEnvironmentBackupSetInputV1 = z.infer<typeof DeploymentEnvironmentBackupSetInputV1Schema>;

/** Nonsecret evidence a restore prepare retains in its Action operation: the exact backup it checked, the
 * destination it will replace and, when that destination held data, the verified safety backup. The native
 * host writes it; the confirm and the person's sheet read the same shape. */
const restoreDestination = lazyZodSchema(() => z.union([z.strictObject({ ...DeploymentPreMigrationBackupV1Schema.shape.target.shape,
    environmentId: DeploymentBackupManifestV1Schema.shape.environmentId,
    revision: DeploymentBackupManifestV1Schema.shape.configRevision,
    stagingDatabase: z.string(), recoveryDatabase: z.string(),
    databaseExists: z.boolean(), hasMeaningfulData: z.boolean(), writerServices: z.array(z.string()),
}), z.strictObject({ adapter: z.literal('volume-v1'), service: z.string(), volume: z.string(),
    environmentId: DeploymentBackupManifestV1Schema.shape.environmentId, revision: DeploymentBackupManifestV1Schema.shape.configRevision,
    currentVolume: z.string(), stagingVolume: z.string(), hasMeaningfulData: z.boolean(),
    writerServices: z.array(z.string()), runningServices: z.array(z.string()),
}), z.strictObject({ ...DeploymentSqliteBackupV1Schema.shape.target.shape,
    environmentId: DeploymentBackupManifestV1Schema.shape.environmentId, revision: DeploymentBackupManifestV1Schema.shape.configRevision,
    stagingVolume: z.string(), hasMeaningfulData: z.boolean(), writerServices: z.array(z.string()),
})]));
export const DeploymentRestoreUploadFormatV1Schema = lazyZodSchema(() => z.enum(['postgresCustom', 'postgresSql', 'sqlite', 'volumeTar']));
export type DeploymentRestoreUploadFormatV1 = z.infer<typeof DeploymentRestoreUploadFormatV1Schema>;
export const DeploymentRestoreUploadSourceV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('upload'), transferId: z.string(), sizeBytes: z.number(), sha256: z.string(),
}));
export type DeploymentRestoreUploadSourceV1 = z.infer<typeof DeploymentRestoreUploadSourceV1Schema>;
const restorePreparedFields = {
    kind: z.literal('prepared'), operationId: z.string(), steps: z.optional(z.array(DeploymentRestoreStepV1Schema)),
    destination: restoreDestination,
    safetyBackup: z.optional(z.strictObject({ kind: z.literal('verified'),
        manifests: z.array(DeploymentBackupManifestV1Schema), restoreCaptures: z.optional(z.array(DeploymentBackupRestoreCaptureV1Schema)) })),
};
export const DeploymentRestorePreparationV1Schema = lazyZodSchema(() => z.union([
    z.strictObject({ prepared: z.strictObject({ ...restorePreparedFields,
        source: DeploymentBackupManifestV1Schema, sourceFormat: z.enum(['postgresCustom', 'volume', 'sqlite']),
        repository: DeploymentPreMigrationBackupV1Schema.shape.repository,
    }), configuration: DeploymentBackupConfigurationV1Schema }),
    z.strictObject({ prepared: z.strictObject({ ...restorePreparedFields,
        source: DeploymentRestoreUploadSourceV1Schema, sourceFormat: DeploymentRestoreUploadFormatV1Schema,
    }) }),
]));
export type DeploymentRestorePreparationV1 = z.infer<typeof DeploymentRestorePreparationV1Schema>;

/** The catalog has admitted the descriptor; its schema alone decides the nonsecret user fields. */
export function validateDeploymentBackupDestinationConfigurationV1(input: Readonly<{
    descriptor: BackupDestinationContributionV1; config: unknown;
}>): boolean {
    return isValidPluginJsonSchemaValue(compilePluginJsonSchema(input.descriptor.configSchema), input.config);
}
