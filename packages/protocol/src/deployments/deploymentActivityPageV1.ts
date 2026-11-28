import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionActorV1Schema } from '../actions/actionRequestAttributionV1.js';
import { ActionOperationSnapshotV1Schema } from '../actions/operations/v1.js';
import { DeploymentEnvironmentHeaderV1Schema, DeploymentReceiptHeaderV1Schema, DeploymentReceiptFailureV1Schema } from './deploymentActionsV1.js';
import { DeploymentReviewRevisionV1Schema } from './deploymentReviewV1.js';
import { DeploymentStepV1Schema } from './deploymentStateV1.js';
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
/** Visible history facts from opened receipt content; older records may omit them. */
export const DeploymentReceiptHistoryItemV1Schema = lazyZodSchema(() => z.extend(DeploymentReceiptHeaderV1Schema, {
    title: z.optional(z.string()),
    actor: z.optional(z.nullable(ActionActorV1Schema)),
    machineIds: z.optional(z.array(DeploymentIdentifierV1Schema)),
    steps: z.optional(z.array(z.extend(DeploymentStepV1Schema, { machineId: z.optional(DeploymentIdentifierV1Schema) }))),
    source: z.optional(z.nullable(DeploymentReviewRevisionV1Schema)),
    failure: z.optional(z.nullable(DeploymentReceiptFailureV1Schema)),
}));
export const DeploymentActivityItemV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ ...DeploymentActivityCursorV1Schema.shape, kind: z.literal('receipt'),
        environment: DeploymentEnvironmentHeaderV1Schema, receipt: DeploymentReceiptHistoryItemV1Schema }),
    z.strictObject({ ...DeploymentActivityCursorV1Schema.shape, kind: z.literal('operation'),
        operation: ActionOperationSnapshotV1Schema }),
]));
export const DeploymentActivityPageV1Schema = lazyZodSchema(() => z.strictObject({
    items: z.readonly(z.array(DeploymentActivityItemV1Schema)),
    nextCursor: z.nullable(DeploymentActivityCursorV1Schema),
    coverage: z.enum(['complete', 'partial']),
    unavailableSources: z.readonly(z.array(z.strictObject({
        kind: z.enum(['environment', 'machine']), id: DeploymentIdentifierV1Schema, code: z.string(),
    }))),
}));
export type DeploymentActivityItemV1 = z.infer<typeof DeploymentActivityItemV1Schema>;
export type DeploymentActivityPageV1 = z.infer<typeof DeploymentActivityPageV1Schema>;
export type DeploymentActivityQueryV1 = z.infer<typeof DeploymentActivityQueryV1Schema>;
export type DeploymentActivityCursorV1 = z.infer<typeof DeploymentActivityCursorV1Schema>;
