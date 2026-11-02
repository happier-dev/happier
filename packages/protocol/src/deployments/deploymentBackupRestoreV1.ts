import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';

const restoreTarget = () => ({ serverId: id, environmentId: id, machineId: id, installationId: id,
  targetLinkId: id, deploymentId: id, restoreBackupId: id, expectedRevision: revision });
export const DeploymentBackupRestorePrepareInputV1Schema = z.strictObject({
  ...restoreTarget(), mode: z.literal('prepare'),
});
export const DeploymentBackupRestoreConfirmInputV1Schema = z.strictObject({
  ...restoreTarget(), mode: z.literal('confirm'), prepareOperationId: id,
});
/** The capture receipt and current target are separate operands; native admission resolves their relationship. */
export const DeploymentBackupRestoreInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  DeploymentBackupRestorePrepareInputV1Schema,
  DeploymentBackupRestoreConfirmInputV1Schema,
]));
export type DeploymentBackupRestoreInputV1 = z.infer<typeof DeploymentBackupRestoreInputV1Schema>;
/** Evidence is a nonsecret native receipt retained by the existing Action operation owner. */
export const DeploymentBackupRestoreResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepared'), operationId: id, evidence: StrictJsonValueSchema }),
  z.strictObject({ kind: z.literal('restored'), verified: z.literal(true), nextAction: z.string(), evidence: StrictJsonValueSchema }),
  z.strictObject({ kind: z.literal('rolledBack'), verified: z.literal(false), nextAction: z.string(), evidence: StrictJsonValueSchema }),
  z.strictObject({ kind: z.literal('outcome_unknown'), verified: z.literal(false), nextAction: z.string(), evidence: StrictJsonValueSchema }),
  z.strictObject({ kind: z.literal('recoveryRequired'), verified: z.literal(false), nextAction: z.string(), evidence: StrictJsonValueSchema }),
]));
export type DeploymentBackupRestoreResultV1 = z.infer<typeof DeploymentBackupRestoreResultV1Schema>;
