import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { UsageObservationCostSchema, UsageObservationScopeSchema, UsageObservationTokensSchema } from '../../usage/usageAnalyticsContracts.js';
import { ExternalAgentObservationResourceKeyV1Schema, isCanonicalAbsoluteObservationFilePath, isCanonicalAbsoluteObservationTopologyDirectoryPath } from './externalAgentObservationV1.js';

/** Optional source-local invalidation evidence; absent means a coarse read. */
export const AgentExternalSessionAccountingChangedNativeSessionIdsSchema = lazyZodSchema(() => z.array(z.string().min(1)));

/** Accounting observes a whole source; Session-specific watcher cardinality limits do not apply. */
export const AgentExternalSessionAccountingSourceSchema = lazyZodSchema(() => z.object({
    rootPath: z.string().refine(isCanonicalAbsoluteObservationTopologyDirectoryPath).optional(),
    rootField: z.string().min(1).optional(),
    resourceKey: ExternalAgentObservationResourceKeyV1Schema,
    changeObservation: z.enum(['observe_resource', 'watch_file_changes', 'reconcile_only']),
    watchFileChanges: z.object({
        files: z.array(z.string().refine(isCanonicalAbsoluteObservationFilePath)),
        topologyDirectories: z.array(z.string().refine(isCanonicalAbsoluteObservationTopologyDirectoryPath)).optional(),
    }).strict().optional(),
}).strict().superRefine((value, ctx) => {
    if (value.changeObservation === 'watch_file_changes') {
        if (!value.watchFileChanges || (value.watchFileChanges.files.length === 0 && !value.watchFileChanges.topologyDirectories?.length)) {
            ctx.addIssue({ code: 'custom', path: ['watchFileChanges'], message: 'File accounting observation requires a file or topology directory.' });
        }
    } else if (value.watchFileChanges !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['watchFileChanges'], message: 'Only file observation declares file changes.' });
    }
}));

/** Closed accounting projection; optional project evidence remains machine-local, never an ingest field. */
export const AgentExternalSessionAccountingObservationSchema = lazyZodSchema(() => z.object({
    nativeSessionId: z.string().min(1),
    observedAt: z.number().int().nonnegative(),
    inferenceId: z.string().min(1).optional(),
    parentNativeSessionId: z.string().min(1).optional(),
    project: z.object({
        rootPath: z.string().refine(isCanonicalAbsoluteObservationFilePath),
        label: z.string().trim().min(1).optional(),
    }).strict().optional(),
    accounting: z.object({
        inputIncludesCache: z.boolean().optional(),
        outputIncludesReasoning: z.boolean().optional(),
    }).strict().optional(),
    observation: z.object({
        provider: z.string().min(1),
        source: z.string().min(1),
        scope: UsageObservationScopeSchema,
        key: z.string().min(1).nullable(),
        modelId: z.string().min(1).nullable(),
        tokens: UsageObservationTokensSchema.nullable(),
        cost: UsageObservationCostSchema.nullable(),
        contextUsedTokens: z.number().finite().nonnegative().nullable(),
        contextWindowTokens: z.number().finite().nonnegative().nullable(),
    }).strict(),
}).strict());
export type AgentExternalSessionAccountingObservation = z.infer<typeof AgentExternalSessionAccountingObservationSchema>;

export const AgentExternalSessionAccountingCoverageSchema = lazyZodSchema(() => z.object({
    complete: z.boolean(),
    reason: z.string().min(1).optional(),
}).strict());
export type AgentExternalSessionAccountingCoverage = z.infer<typeof AgentExternalSessionAccountingCoverageSchema>;

/** A source-owned frontier advances only with a successfully admitted accounting batch. */
export const AgentExternalSessionsReadAccountingResultSchema = lazyZodSchema(() => z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('unchanged') }).strict(),
    z.object({
        outcome: z.literal('advanced'),
        observations: z.array(AgentExternalSessionAccountingObservationSchema),
        nextCursor: z.string().min(1),
        coverage: AgentExternalSessionAccountingCoverageSchema,
    }).strict(),
    z.object({ outcome: z.literal('source_replaced') }).strict(),
    z.object({ outcome: z.literal('gap_or_cursor_expired') }).strict(),
    z.object({ outcome: z.literal('source_unavailable') }).strict(),
    z.object({ outcome: z.literal('read_failed') }).strict(),
]));
export type AgentExternalSessionsReadAccountingResult = z.infer<typeof AgentExternalSessionsReadAccountingResultSchema>;
