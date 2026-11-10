import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';

/** Safe projection of retained, scoped operation receipts, never native output. */
export const DeploymentBackupHistoryV1Schema = lazyZodSchema(() => z.strictObject({
  entries: z.array(z.strictObject({
    operationId: id, action: z.enum(['backup', 'verify', 'prune']),
    startedAt: z.number().check(z.int(), z.nonnegative()),
    completedAt: z.number().check(z.int(), z.nonnegative()),
    state: z.enum(['succeeded', 'failed', 'cancelled']),
    configRevision: revision, snapshotIds: z.array(id), code: z.optional(id), step: z.optional(id),
  })),
}));
export type DeploymentBackupHistoryV1 = z.infer<typeof DeploymentBackupHistoryV1Schema>;

export const DeploymentBackupRecordedFactsV1Schema = lazyZodSchema(() => z.strictObject({
  history: z.optional(DeploymentBackupHistoryV1Schema),
  lastSuccessfulBackup: z.optional(z.strictObject({
    operationId: id, completedAt: z.number().check(z.int(), z.nonnegative()), configRevision: revision,
    snapshotIds: z.array(id),
  })),
  lastVerification: z.optional(z.strictObject({
    operationId: id, completedAt: z.number().check(z.int(), z.nonnegative()), configRevision: revision,
    backupOperationId: id, snapshotId: id, level: z.enum(['manifestReadBack', 'repositoryCheck']),
    result: z.enum(['verified', 'failed', 'cancelled']), code: z.optional(id), step: z.optional(id),
  })),
}));
export type DeploymentBackupRecordedFactsV1 = z.infer<typeof DeploymentBackupRecordedFactsV1Schema>;

export const DeploymentBackupHistoryResultV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('history'), environmentId: id, configRevision: revision,
  ...DeploymentBackupRecordedFactsV1Schema.shape, history: DeploymentBackupHistoryV1Schema,
}));
export type DeploymentBackupHistoryResultV1 = z.infer<typeof DeploymentBackupHistoryResultV1Schema>;
