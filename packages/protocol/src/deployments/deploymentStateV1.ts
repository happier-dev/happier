import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentTimestampV1Schema as timestamp } from './deploymentIdentifiersV1.js';

/** Shared receipt and target-result leaves; importing them never reaches Action registration. */
const effectStates = [
    'queued', 'running', 'running_unverified', 'succeeded', 'failed', 'cancelled', 'outcome_unknown',
] as const;
export const DEPLOYMENT_SKIPPED_STATE_V1 = 'skipped';
export const DeploymentEffectStateV1Schema = lazyZodSchema(() => z.enum(effectStates));
export const DeploymentStateV1Schema = lazyZodSchema(() => z.enum([...effectStates, DEPLOYMENT_SKIPPED_STATE_V1]));
export type DeploymentStateV1 = z.infer<typeof DeploymentStateV1Schema>;

/** Receipt operation vocabulary also consumed by provider observation inputs. */
export const DeploymentReceiptOperationV1Schema = lazyZodSchema(() => z.enum(['deploy', 'rollback', 'promote', 'teardown']));

/** Presentation of the executor's observed phase; cancellation itself never restores a workload. */
export const DeploymentCancellationConsequenceV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.enum(['service-down-until-rollback', 'may-leave-service-down-until-rollback']),
}));
export type DeploymentCancellationConsequenceV1 = z.infer<typeof DeploymentCancellationConsequenceV1Schema>;

/** P40-R13: only effecting receipts occupy the slot; unknown outcomes remain readable history. */
export function deploymentInProgressStates(): string[] {
    return ['queued', 'running'];
}

export const DeploymentStepV1Schema = lazyZodSchema(() => z.strictObject({
    id, label: z.string().check(z.trim(), z.minLength(1)),
    state: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'outcome_unknown']),
    startedAtMs: z.optional(timestamp), settledAtMs: z.optional(timestamp),
    durationMs: z.optional(timestamp), streamRef: z.optional(id),
}));
export type DeploymentStepV1 = z.infer<typeof DeploymentStepV1Schema>;
