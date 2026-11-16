import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentBackupNativeFailureV1Schema } from './deploymentBackupActionsV1.js';
import { createManagedMachineV1BaseShape, ManagedControllerV1Schema } from '../machines/managed/managedMachineV1.js';
import { PluginJsonValueV2Schema } from '../plugins/contributions/jsonSchema.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { MachineProvisionerSnapshotFactsV1Schema, MachineProvisionerSnapshotConsistencyV1Schema, MachineProvisionerSnapshotResultV1Schema } from '../plugins/contributions/machineProvisioners.js';
import { DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 } from './deploymentActionIdsV1.js';

/** Exact provider facts retained by restore preparation; the full resource stays private. */
export const DeploymentNativeSnapshotOfferV1Schema = lazyZodSchema(() => {
  const managedFields = createManagedMachineV1BaseShape(PluginJsonValueV2Schema, PluginJsonValueV2Schema);
  return z.strictObject({
    managedId: id, intentRevision: managedFields.intentRevision, controller: ManagedControllerV1Schema,
    resource: z.nonoptional(managedFields.resource), contribution: asProtocolZod(PluginContributionIdentityV1Schema),
    ...MachineProvisionerSnapshotFactsV1Schema.shape,
    consistency: MachineProvisionerSnapshotConsistencyV1Schema,
  });
});
export type DeploymentNativeSnapshotOfferV1 = z.infer<typeof DeploymentNativeSnapshotOfferV1Schema>;

/** A review reason only; remote Engine selection never becomes a physical-Machine guess. */
export const DeploymentNativeSnapshotUnavailableV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.literal('restore_snapshot_remote_engine'),
}));
export type DeploymentNativeSnapshotUnavailableV1 = z.infer<typeof DeploymentNativeSnapshotUnavailableV1Schema>;

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
export type DeploymentBackupRestorePrepareInputV1 = z.infer<typeof DeploymentBackupRestorePrepareInputV1Schema>;
export const DeploymentBackupRestoreConfirmInputV1Schema = z.strictObject({
  ...restoreTarget(), mode: z.literal('confirm'), prepareOperationId: id,
  snapshot: z.optional(z.boolean()), snapshotReview: z.optional(DeploymentNativeSnapshotOfferV1Schema),
});
/** Recovery selects only the scoped operation's recorded native recovery point. */
export const DeploymentBackupRestoreRecoverInputV1Schema = z.strictObject({
  ...restoreTarget(), mode: z.literal('recover'), operationId: id,
});
/** The capture receipt and current target are separate operands; native admission resolves their relationship. */
export const DeploymentBackupRestoreInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  DeploymentBackupRestorePrepareInputV1Schema,
  DeploymentBackupRestoreConfirmInputV1Schema,
  DeploymentBackupRestoreRecoverInputV1Schema,
]));
export type DeploymentBackupRestoreInputV1 = z.infer<typeof DeploymentBackupRestoreInputV1Schema>;
/** One domain summary for present-user and agent approval of the exact reviewed restore. */
export function summarizeDeploymentRestoreReviewV1(input: DeploymentBackupRestoreInputV1, unavailable?: DeploymentNativeSnapshotUnavailableV1 | null): string {
  if (input.mode === 'prepare') return 'Check the backup and take a safety backup first. Nothing is replaced yet.';
  if (input.mode === 'recover') return 'Reactivate the original volume preserved by this restore and check its services. The running code stays as it is.';
  const offer = input.snapshotReview;
  if (!offer) return ["Replace this Environment's data with the checked backup. The running code stays as it is.",
    ...(unavailable ? ["Machine snapshot is unavailable: this Environment's data runs on another Engine."] : [])].join('\n');
  return [input.snapshot === false ? 'Replace data without a Machine snapshot.' : 'Take a Machine snapshot before replacing data.',
    `Coverage: root disk ${offer.coverage.rootDisk ? 'included' : 'excluded'}; attached volumes ${offer.coverage.attachedVolumes ? 'included' : 'excluded'}.`,
    `Provider billing: ${offer.cost.price ? `${offer.cost.price.amount} ${offer.cost.price.currency}/${offer.cost.price.unit}` : 'price not supplied'}. Source: ${offer.cost.source}.`,
    `Machine consistency: ${offer.consistency}; no application quiescing is implied.`].join('\n');
}
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
  snapshot: z.optional(asProtocolZod(MachineProvisionerSnapshotResultV1Schema)),
}));
export type DeploymentRestoreFailureResultV1 = z.infer<typeof DeploymentRestoreFailureResultV1Schema>;
const restoreSteps = () => ({ steps: z.optional(z.array(DeploymentRestoreStepV1Schema)) });
const recoveryAction = z.strictObject({ actionId: z.literal(DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1),
  input: DeploymentBackupRestoreRecoverInputV1Schema });
const restoreRecovery = () => ({ recovery: z.optional(recoveryAction) });
/** The existing serving receipt owns activation currentness, including data restores. */
export const DeploymentRestoreActivationReferenceV1Schema = z.strictObject({ deploymentId: id, revision });
export type DeploymentRestoreActivationReferenceV1 = z.infer<typeof DeploymentRestoreActivationReferenceV1Schema>;
/** One mapping from a native next action to the public UI/agent invocation.
 * Inspection-only next actions do not promise an executable recovery. */
export function buildDeploymentRestoreRecoveryActionV1(input: DeploymentBackupRestoreInputV1, operationId: string,
  nextAction: string): z.infer<typeof recoveryAction> | undefined {
  if (nextAction !== 'restorePreviousVolume') return undefined;
  return { actionId: DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1,
    input: z.object(DeploymentBackupRestoreRecoverInputV1Schema.shape).parse({ ...input, mode: 'recover', operationId }) };
}
/** Evidence is a nonsecret native receipt retained by the existing Action operation owner. */
export const DeploymentBackupRestoreResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepared'), operationId: id, evidence: StrictJsonValueSchema, ...restoreSteps() }),
  z.strictObject({ kind: z.literal('restored'), verified: z.literal(true), nextAction: z.string(), evidence: StrictJsonValueSchema, ...restoreSteps() }),
  z.strictObject({ kind: z.literal('rolledBack'), verified: z.literal(false), nextAction: z.string(), evidence: StrictJsonValueSchema, ...restoreSteps() }),
  z.strictObject({ kind: z.literal('outcome_unknown'), verified: z.literal(false), nextAction: z.string(), evidence: StrictJsonValueSchema, ...restoreSteps() }),
  z.strictObject({ kind: z.literal('recoveryRequired'), verified: z.literal(false), nextAction: z.string(), evidence: StrictJsonValueSchema, ...restoreSteps(), ...restoreRecovery() }),
  z.strictObject({ kind: z.literal('superseded'), verified: z.literal(false), nextAction: z.literal('none'),
    newerActivation: DeploymentRestoreActivationReferenceV1Schema, evidence: StrictJsonValueSchema, ...restoreSteps() }),
]));
export type DeploymentBackupRestoreResultV1 = z.infer<typeof DeploymentBackupRestoreResultV1Schema>;
