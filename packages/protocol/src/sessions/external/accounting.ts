import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { UsageObservationCostSchema, UsageObservationScopeSchema, UsageObservationTokensSchema } from '../../usage/usageAnalyticsContracts.js';
import { ExternalAgentObservationResourceKeyV1Schema, isCanonicalAbsoluteObservationFilePath, isCanonicalAbsoluteObservationTopologyDirectoryPath } from './externalAgentObservationV1.js';

/** Optional source-local invalidation evidence; absent means a coarse read. */
export const AgentExternalSessionAccountingChangedNativeSessionIdsSchema = lazyZodSchema(() => z.array(z.string().check(z.minLength(1))));

/** Accounting observes a whole source; Session-specific watcher cardinality limits do not apply. */
export const AgentExternalSessionAccountingSourceSchema = lazyZodSchema(() => z.strictObject({
    accountingSources: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
    /** Files witnessed by metadata discovery, not watcher targets or an inferred Session count. */
    discoveredFileCount: z.optional(z.number().check(z.int(), z.nonnegative())),
    rootPath: z.optional(z.string().check(z.refine(isCanonicalAbsoluteObservationTopologyDirectoryPath))),
    rootField: z.optional(z.string().check(z.minLength(1))),
    resourceKey: ExternalAgentObservationResourceKeyV1Schema,
    changeObservation: z.enum(['observe_resource', 'watch_file_changes', 'reconcile_only']),
    watchFileChanges: z.optional(z.strictObject({
        files: z.array(z.string().check(z.refine(isCanonicalAbsoluteObservationFilePath))),
        topologyDirectories: z.optional(z.array(z.string().check(z.refine(isCanonicalAbsoluteObservationTopologyDirectoryPath)))),
    })),
}).check(z.superRefine((value, ctx) => {
    if (value.changeObservation === 'watch_file_changes') {
        if (!value.watchFileChanges || (value.watchFileChanges.files.length === 0 && !value.watchFileChanges.topologyDirectories?.length)) {
            ctx.addIssue({ code: 'custom', path: ['watchFileChanges'], message: 'File accounting observation requires a file or topology directory.' });
        }
    } else if (value.watchFileChanges !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['watchFileChanges'], message: 'Only file observation declares file changes.' });
    }
})));

/** Closed accounting projection; optional project evidence remains machine-local, never an ingest field. */
export const AgentExternalSessionAccountingObservationSchema = lazyZodSchema(() => z.strictObject({
    nativeSessionId: z.string().check(z.minLength(1)),
    observedAt: z.number().check(z.int(), z.nonnegative()),
    inferenceId: z.optional(z.string().check(z.minLength(1))),
    parentNativeSessionId: z.optional(z.string().check(z.minLength(1))),
    project: z.optional(z.strictObject({
        rootPath: z.string().check(z.refine(isCanonicalAbsoluteObservationFilePath)),
        label: z.optional(z.string().check(z.trim(), z.minLength(1))),
    })),
    accounting: z.optional(z.strictObject({
        inputIncludesCache: z.optional(z.boolean()),
        outputIncludesReasoning: z.optional(z.boolean()),
    })),
    observation: z.strictObject({
        provider: z.string().check(z.minLength(1)),
        source: z.string().check(z.minLength(1)),
        scope: UsageObservationScopeSchema,
        key: z.nullable(z.string().check(z.minLength(1))),
        modelId: z.nullable(z.string().check(z.minLength(1))),
        tokens: z.nullable(UsageObservationTokensSchema),
        cost: z.nullable(UsageObservationCostSchema),
        contextUsedTokens: z.nullable(z.number().check(z.nonnegative())),
        contextWindowTokens: z.nullable(z.number().check(z.nonnegative())),
    }),
}));
export type AgentExternalSessionAccountingObservation = z.infer<typeof AgentExternalSessionAccountingObservationSchema>;

export const AgentExternalSessionAccountingCoverageSchema = lazyZodSchema(() => z.strictObject({
    complete: z.boolean(),
    reason: z.optional(z.string().check(z.minLength(1))),
}));
export type AgentExternalSessionAccountingCoverage = z.infer<typeof AgentExternalSessionAccountingCoverageSchema>;

/** A source-owned frontier advances only with a successfully admitted accounting batch. */
export const AgentExternalSessionsReadAccountingResultSchema = lazyZodSchema(() => z.discriminatedUnion('outcome', [
    z.strictObject({ outcome: z.literal('unchanged') }),
    z.strictObject({
        outcome: z.literal('advanced'),
        observations: z.array(AgentExternalSessionAccountingObservationSchema),
        nextCursor: z.string().check(z.minLength(1)),
        coverage: AgentExternalSessionAccountingCoverageSchema,
    }),
    z.strictObject({ outcome: z.literal('source_replaced') }),
    z.strictObject({ outcome: z.literal('gap_or_cursor_expired') }),
    z.strictObject({ outcome: z.literal('source_unavailable') }),
    z.strictObject({ outcome: z.literal('read_failed') }),
]));
export type AgentExternalSessionsReadAccountingResult = z.infer<typeof AgentExternalSessionsReadAccountingResultSchema>;
