import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentBackupNativeFailureV1Schema } from './deploymentBackupActionsV1.js';

const restoreTarget = () => ({ serverId: id, environmentId: id, machineId: id, installationId: id,
  targetLinkId: id, deploymentId: id, restoreBackupId: id, expectedRevision: revision,
  backupOperationId: z.optional(id) });
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
