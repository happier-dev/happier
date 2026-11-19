import { z } from 'zod/mini';
import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import { UsageObservationTokensSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { DatabaseCaptureSourceV1Schema, DatabaseCaptureCoverageV1Schema } from './databaseCaptureSource.js';
import { DatabaseFailureV1Schema } from './schemas/databaseOperations.js';


/** Delegate disjoint-token semantics to Usage; the collector never owns pricing arithmetic. */

const time = z.number().check(z.int(), z.nonnegative());
const count = z.number().check(z.int(), z.nonnegative());
const text = z.string().check(z.minLength(1));
export const DATABASE_CAPTURE_COST_TOKEN_FIELDS_V1 = Object.keys(UsageObservationTokensSchema.shape) as Array<keyof z.infer<typeof UsageObservationTokensSchema>>;
export const DatabaseCaptureCostsReadInputV1Schema = z.strictObject({
    source: DatabaseCaptureSourceV1Schema, since: time, until: time,
    serviceName: z.optional(text), serviceVersion: z.optional(text),
    granularity: z.optional(z.enum(['hour', 'day'])),
}).check(z.refine(input => input.since < input.until, 'Expected a nonempty selected window'));

/** One observation belongs to one operand: currency/null and known-token masks are grouping dimensions. */
export const DatabaseCaptureCostOperandV1Schema = z.strictObject({
    bucketStartMs: time,
    provider: z.nullable(text), modelId: z.nullable(text), requestedModel: z.nullable(text), operation: z.nullable(text),
    callCount: count, tokens: UsageObservationTokensSchema, tokenCategories: z.nullable(UsageObservationTokensSchema),
    reportedCost: z.nullable(z.strictObject({ amount: z.number().check(z.nonnegative()), currency: text })),
    firstSeenMs: time, lastSeenMs: time,
});
export const DatabaseCaptureCostsReadResultV1Schema = z.union([DatabaseFailureV1Schema, z.strictObject({
    ok: z.literal(true), source: DatabaseCaptureSourceV1Schema, since: time, until: time,
    items: z.array(DatabaseCaptureCostOperandV1Schema),
    coverage: z.extend(DatabaseCaptureCoverageV1Schema, {
        callCount: count, tokenCategoryCallCount: count, reportedCostCallCount: count,
    }),
})]);
export type DatabaseCaptureCostsReadInputV1 = z.infer<typeof DatabaseCaptureCostsReadInputV1Schema>;
export type DatabaseCaptureCostOperandV1 = z.infer<typeof DatabaseCaptureCostOperandV1Schema>;
export type DatabaseCaptureCostMetadataV1 = Pick<DatabaseCaptureCostOperandV1,
    'provider' | 'modelId' | 'requestedModel' | 'operation' | 'tokens' | 'tokenCategories' | 'reportedCost'>;
export type DatabaseCaptureCostsReadResultV1 = z.infer<typeof DatabaseCaptureCostsReadResultV1Schema>;
export const DatabaseCaptureCostsReadInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureCostsReadInputV1Schema);
export const DatabaseCaptureCostsReadResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureCostsReadResultV1Schema);

export const DatabaseCaptureCostOperandV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureCostOperandV1Schema);
