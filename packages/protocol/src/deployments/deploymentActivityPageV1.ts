import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema, DeploymentTimestampV1Schema } from './deploymentIdentifiersV1.js';

/** Client read projection only: no new server endpoint or persisted record. */
export const DeploymentActivityCursorV1Schema = lazyZodSchema(() => z.strictObject({
    requestedAtMs: DeploymentTimestampV1Schema,
    id: z.string().check(z.minLength(1)),
}));
export const DeploymentActivityQueryV1Schema = lazyZodSchema(() => z.strictObject({
    projectSourceId: z.optional(DeploymentIdentifierV1Schema),
    environmentId: z.optional(DeploymentIdentifierV1Schema),
    machineId: z.optional(DeploymentIdentifierV1Schema),
    actorAccountId: z.optional(DeploymentIdentifierV1Schema),
    kind: z.optional(z.enum(['receipt', 'operation'])),
    /** Inclusive start and exclusive end, applied by each history owner before paging. */
    requestedAtFromMs: z.optional(DeploymentTimestampV1Schema),
    requestedAtToMs: z.optional(DeploymentTimestampV1Schema),
    // Page size is chosen by the consuming collection; this read invents no ceiling.
    limit: z.number().check(z.int(), z.positive()),
    cursor: z.optional(DeploymentActivityCursorV1Schema),
}));
export type DeploymentActivityQueryV1 = z.infer<typeof DeploymentActivityQueryV1Schema>;
export type DeploymentActivityCursorV1 = z.infer<typeof DeploymentActivityCursorV1Schema>;
