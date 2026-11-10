import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentBackupNativeFailureV1Schema } from './deploymentBackupActionsV1.js';
import { ManagedMachineV1Schema, ManagedControllerV1Schema } from '../machines/managed/managedMachineV1.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { MachineProvisionerSnapshotFactsV1Schema, MachineProvisionerSnapshotConsistencyV1Schema } from '../plugins/contributions/machineProvisioners.js';

/** Exact provider facts retained by restore preparation; the full resource stays private. */
export const DeploymentNativeSnapshotOfferV1Schema = lazyZodSchema(() => z.strictObject({
  managedId: id, intentRevision: revision, controller: ManagedControllerV1Schema,
  resource: z.nonoptional(ManagedMachineV1Schema.shape.resource), contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  ...MachineProvisionerSnapshotFactsV1Schema.shape,
  consistency: MachineProvisionerSnapshotConsistencyV1Schema,
}));
export type DeploymentNativeSnapshotOfferV1 = z.infer<typeof DeploymentNativeSnapshotOfferV1Schema>;

/** Source handles cross the public boundary; native paths stay in finite-transfer custody. */
export const DeploymentBackupRestoreRepositorySourceV1Schema = z.strictObject({
  kind: z.literal('repository'), snapshotId: id, backupOperationId: z.optional(id),
  origin: z.optional(z.strictObject({ environmentId: id, targetLinkId: id })),
});
export const DeploymentBackupRestoreSourceV1Schema = z.discriminatedUnion('kind', [
  DeploymentBackupRestoreRepositorySourceV1Schema,
  z.strictObject({ kind: z.literal('upload'), transferId: id }),
]);
export const DeploymentBackupRestoreDestinationV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('database'), service: id, database: id }),
  z.strictObject({ kind: z.literal('volume'), service: id, volume: id }),
]);
/** Uses the incumbent encrypted finite-transfer RPC, without a caller-selected path. */
export const DeploymentBackupRestoreUploadInitV1Schema = z.strictObject({
  t: z.literal('deployment_restore_upload_v1'), environmentId: id,
  sizeBytes: z.number().check(z.int(), z.nonnegative()),
});
export type DeploymentBackupRestoreUploadInitV1 = z.infer<typeof DeploymentBackupRestoreUploadInitV1Schema>;
const restoreTarget = () => ({ serverId: id, environmentId: id, machineId: id, installationId: id,
  targetLinkId: id, deploymentId: id, expectedRevision: revision,
  source: DeploymentBackupRestoreSourceV1Schema, destination: z.optional(DeploymentBackupRestoreDestinationV1Schema) });
export const DeploymentBackupRestorePrepareInputV1Schema = z.strictObject({
  ...restoreTarget(), mode: z.literal('prepare'),
});
export const DeploymentBackupRestoreConfirmInputV1Schema = z.strictObject({
  ...restoreTarget(), mode: z.literal('confirm'), prepareOperationId: id,
  snapshot: z.optional(z.boolean()), snapshotReview: z.optional(DeploymentNativeSnapshotOfferV1Schema),
});
/** The capture receipt and current target are separate operands; native admission resolves their relationship. */
export const DeploymentBackupRestoreInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  DeploymentBackupRestorePrepareInputV1Schema,
  DeploymentBackupRestoreConfirmInputV1Schema,
]));
export type DeploymentBackupRestoreInputV1 = z.infer<typeof DeploymentBackupRestoreInputV1Schema>;
/** Native-owner presentation facts, never authority to repeat a restore effect. */
export const DeploymentRestoreStepV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.enum(['safety', 'stop', 'restore', 'start', 'health']),
  status: z.enum(['running', 'completed', 'failed', 'skipped']),
}));
export type DeploymentRestoreStepV1 = z.infer<typeof DeploymentRestoreStepV1Schema>;
const stepLabels = { safety: 'Safety backup', stop: 'Stop writers', restore: 'Restore database',
  start: 'Start writers', health: 'Check health' } satisfies Record<DeploymentRestoreStepV1['id'], string>;

/** Reuses the Action owner's phase push; no extra observation or progress store. */
export function deploymentRestoreStepProgressV1(step: DeploymentRestoreStepV1): Readonly<{ phase: string; label: string }> {
  return { phase: `restore.${step.id}.${step.status}`, label: stepLabels[step.id] };
}
export function readDeploymentRestoreStepProgressV1(phase: unknown): DeploymentRestoreStepV1 | null {
  if (typeof phase !== 'string') return null;
  const [prefix, id, status, extra] = phase.split('.');
  if (prefix !== 'restore' || extra !== undefined) return null;
  const step = DeploymentRestoreStepV1Schema.safeParse({ id, status });
  return step.success ? step.data : null;
}
/** Restore failure evidence uses the same native step facts as successful results. */
export const DeploymentRestoreFailureResultV1Schema = lazyZodSchema(() => z.strictObject({
  steps: z.array(DeploymentRestoreStepV1Schema),
  nativeFailure: z.optional(DeploymentBackupNativeFailureV1Schema),
}));
export type DeploymentRestoreFailureResultV1 = z.infer<typeof DeploymentRestoreFailureResultV1Schema>;
const restoreSteps = () => ({ steps: z.optional(z.array(DeploymentRestoreStepV1Schema)) });
/** Evidence is a nonsecret native receipt retained by the existing Action operation owner. */
export const DeploymentBackupRestoreResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepared'), operationId: id, evidence: StrictJsonValueSchema, ...restoreSteps() }),
  z.strictObject({ kind: z.literal('restored'), verified: z.literal(true), nextAction: z.string(), evidence: StrictJsonValueSchema, ...restoreSteps() }),
  z.strictObject({ kind: z.literal('rolledBack'), verified: z.literal(false), nextAction: z.string(), evidence: StrictJsonValueSchema, ...restoreSteps() }),
  z.strictObject({ kind: z.literal('outcome_unknown'), verified: z.literal(false), nextAction: z.string(), evidence: StrictJsonValueSchema, ...restoreSteps() }),
  z.strictObject({ kind: z.literal('recoveryRequired'), verified: z.literal(false), nextAction: z.string(), evidence: StrictJsonValueSchema, ...restoreSteps() }),
]));
export type DeploymentBackupRestoreResultV1 = z.infer<typeof DeploymentBackupRestoreResultV1Schema>;
