import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentTimestampV1Schema as timestamp } from './deploymentIdentifiersV1.js';

/** Shared receipt and target-result leaves; importing them never reaches Action registration. */
export const DeploymentStateV1Schema = lazyZodSchema(() => z.enum([
    'queued', 'running', 'running_unverified', 'succeeded', 'failed', 'cancelled', 'outcome_unknown',
]));
export type DeploymentStateV1 = z.infer<typeof DeploymentStateV1Schema>;

export const DeploymentStepV1Schema = lazyZodSchema(() => z.strictObject({
    id, label: z.string().check(z.trim(), z.minLength(1)),
    state: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'outcome_unknown']),
    startedAtMs: z.optional(timestamp), settledAtMs: z.optional(timestamp),
    durationMs: z.optional(timestamp), streamRef: z.optional(id),
}));
export type DeploymentStepV1 = z.infer<typeof DeploymentStepV1Schema>;
