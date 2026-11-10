import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import type { UsageAnalyticsQueryResponse } from '../usageAnalyticsContracts.js';
import type { UsageModelPriceOverridesV1 } from '../usageModelPriceCatalog.js';
import { UsageRequestAttributionSchema } from '../usageAnalyticsContracts.js';
import type { UsageWorkPermissionFact } from '../usageWorkIntervals.js';
import { UsageSessionEvidenceCoverageSchema } from '../resolveUsageHowYouWork.js';
import { UsageCoachRemedySchema, type UsageCoachRemedy } from './coachRemedy.js';
import type { UsagePromptComposition } from './usagePromptComposition.js';
import type { UsageMcpBindingUsage } from './usageMcpBindingUsage.js';
import type { UsageCoachModelRequest } from './usagePromptComposition.js';
import { ProviderConnectionIdSchema, ProviderAgentTargetKeySchema } from '../../providers/ids.js';
import { UsageCoachDigestSuggestionSchema } from './coachDigestSuggestion.js';
import { USAGE_COACH_DETECTOR_IDS, UsageCoachDetectorIdSchema, type UsageCoachDetectorId } from './coachDetectorIds.js';
import type { UsageCoachPreferencesV1Schema } from '../../account/settings/usageCoachPreferencesV1.js';
export { USAGE_COACH_DETECTOR_IDS, UsageCoachDetectorIdSchema, type UsageCoachDetectorId } from './coachDetectorIds.js';
export { UsageCoachDigestSuggestionSchema, type UsageCoachDigestSuggestion } from './coachDigestSuggestion.js';

/** This V1 read projection is closed recursively. It grants no mutation authority. */
export const UsageCoachCapabilitySchema = lazyZodSchema(() => z.enum([
    'instruction_injections', 'model_outcome_comparison', 'native_cache_cause',
    'permission_request_decision_pairs', 'mcp_schema_and_tool_use', 'file_identity_version_reads',
    'compaction_events', 'loop_operation_outcomes', 'native_prefix_cache_cause',
    'accounting_origin', 'context_composition_capacity',
    'cache_accounting', 'recorded_effort', 'subagent_accounting',
]));
export type UsageCoachCapability = z.infer<typeof UsageCoachCapabilitySchema>;
export const USAGE_COACH_REQUIRED_EVIDENCE = {
    duplicated_instructions: ['instruction_injections'], model_misfit: ['model_outcome_comparison'],
    idle_recaching: ['native_cache_cause'], approval_friction: ['permission_request_decision_pairs'],
    mcp_overhead: ['mcp_schema_and_tool_use'], repeated_file_reads: ['file_identity_version_reads'],
    compaction_storms: ['compaction_events'], anomalous_looping_usage: ['loop_operation_outcomes'],
    cache_busting_prompt_changes: ['native_prefix_cache_cause'], outside_usage: ['accounting_origin'],
    context_bloat: ['context_composition_capacity'],
    cache_economics: ['cache_accounting'], effort_audit: ['recorded_effort'], subagent_fanout: ['subagent_accounting'],
} as const satisfies Record<UsageCoachDetectorId, readonly UsageCoachCapability[]>;
const Id = lazyZodSchema(() => z.string().check(z.minLength(1)));
const Time = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const Amount = lazyZodSchema(() => z.number().check(z.nonnegative()));
export const UsageCoachPeriodSchema = lazyZodSchema(() => z.strictObject({ startMs: Time, endMs: Time }).check(z.refine(value => value.endMs >= value.startMs)));
export const UsageCoachCurrentnessSchema = lazyZodSchema(() => z.enum(['current', 'stale', 'unknown']));
export const UsageCoachEvidenceReferenceSchema = lazyZodSchema(() => z.strictObject({
    kind: z.enum(['accounting', 'permission', 'composition', 'file_read', 'compaction', 'model_comparison', 'native_cache', 'tool', 'loop', 'mcp_usage', 'effort', 'subagent']),
    id: Id, observedAtMs: Time,
}));
export const UsageCoachMeasurementSchema = lazyZodSchema(() => z.strictObject({
    metric: z.enum(['duplicate_injections', 'duplicate_bytes', 'observed_cost_difference', 'cache_write_tokens',
        'permission_wait', 'permission_requests', 'unused_schema_bytes', 'unused_mcp_bindings', 'unchanged_reads', 'compactions',
        'failed_repetitions', 'outside_tokens', 'composed_tokens', 'context_window_tokens', 'cache_read_tokens', 'input_tokens',
        'cache_hit_ratio', 'cache_replacement_premium', 'cache_cost_share', 'cached_history_cost',
        'output_tokens', 'thinking_tokens', 'parent_tokens', 'subagent_tokens', 'fanout_multiplier', 'loaded_schema_tokens']),
    value: Amount, unit: z.enum(['count', 'bytes', 'tokens', 'milliseconds', 'currency']),
    currency: z.optional(Id),
    costKind: z.optional(z.enum(['reported', 'estimated', 'api_equivalent', 'invoice'])),
}));
/** Measured samples, not a filled calendar or an inferred trend. Each point identifies its finding evidence. */
export const UsageCoachEvidenceSeriesSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(UsageCoachMeasurementSchema, { value: true }), {
    points: z.array(z.strictObject({ evidenceId: Id, observedAtMs: Time, value: Amount })).check(z.minLength(1)),
})));
export const UsageCoachEstimateSchema = lazyZodSchema(() => z.strictObject({
    kind: z.enum(['observed_difference', 'potential_duplicate_bytes']), value: Amount,
    unit: z.enum(['bytes', 'currency']), currency: z.optional(Id),
    method: z.enum(['matched_outcome_cost_v1', 'duplicate_injection_bytes_v1']),
    assumptions: z.array(z.string()), period: UsageCoachPeriodSchema, evidenceIds: z.array(Id).check(z.minLength(1)),
}));
export const UsageCoachModelComparisonDetailSchema = lazyZodSchema(() => z.strictObject({
    basis: z.literal('matched_completed_host_request_v1'), sessionId: Id,
    agentTargetKey: ProviderAgentTargetKeySchema, providerConnectionId: z.nullable(ProviderConnectionIdSchema),
    modelId: Id, candidateModelId: Id, modelTurnId: Id, candidateTurnId: Id,
    requestKey: Id, requestScopeKey: Id, modelCost: Amount, candidateCost: Amount,
    currency: Id, costKind: z.enum(['reported', 'estimated', 'api_equivalent', 'invoice']),
    costCoverage: z.optional(z.enum(['complete', 'partial'])),
    providerAttribution: z.optional(z.enum(['known', 'unknown'])),
    modelResponseSource: z.optional(UsageRequestAttributionSchema.shape.source),
    candidateResponseSource: z.optional(UsageRequestAttributionSchema.shape.source),
}).check(z.refine(value => value.modelId !== value.candidateModelId && value.modelTurnId !== value.candidateTurnId
    && value.modelCost > value.candidateCost)));
export const UsageCoachFindingStateSchema = lazyZodSchema(() => z.strictObject({
    dismissed: z.boolean(), snoozedUntilMs: z.nullable(Time),
    applied: z.nullable(z.strictObject({ asOfMs: Time, remedy: UsageCoachRemedySchema })),
}));
/** Explainability is part of the finding, including observations that make no waste claim. */
export const UsageCoachEvidenceBasisSchema = lazyZodSchema(() => z.strictObject({
    method: Id, kind: z.enum(['observation', 'derived', 'guidance_derived', 'vendor_fact']),
    citations: z.array(z.strictObject({ url: z.string().check(z.url()), sourceKind: z.enum([
        'vendor_docs', 'vendor_changelog', 'research_paper', 'price_catalog',
    ]), asOf: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)) })).check(z.minLength(1)),
    limitations: z.array(z.string()), advice: z.array(z.string()),
}));
export const UsageCoachFindingSchema = lazyZodSchema(() => z.strictObject({
    detectorId: UsageCoachDetectorIdSchema, evidenceKey: Id, queryKey: Id,
    period: UsageCoachPeriodSchema, asOfMs: z.nullable(Time), currentness: UsageCoachCurrentnessSchema,
    coverage: z.enum(['complete', 'partial', 'unknown']), severity: z.enum(['info', 'warning']),
    classification: z.enum(['informational', 'cost_linked']), basis: UsageCoachEvidenceBasisSchema,
    summaryCode: z.enum(['duplicate_injection_observed', 'compatible_model_cost_difference', 'idle_cache_recreation_observed',
        'approval_wait_observed', 'unused_mcp_schema_observed', 'unused_mcp_binding_observed', 'redundant_unchanged_read_observed',
        'repeated_compaction_observed', 'failed_loop_observed', 'prefix_change_cache_miss_observed',
        'outside_happier_usage_observed', 'comparable_completed_request_cost_difference', 'compaction_thrash_observed',
        'context_growth_cost_observed', 'cache_economics_observed', 'effort_audit_observed', 'subagent_fanout_observed', 'mcp_definition_overhead_observed']),
    evidence: z.array(UsageCoachEvidenceReferenceSchema).check(z.minLength(1)), measurements: z.array(UsageCoachMeasurementSchema),
    evidenceSeries: z.optional(z.array(UsageCoachEvidenceSeriesSchema).check(z.minLength(1))),
    remedy: z.nullable(UsageCoachRemedySchema),
    /** The query comes from the admitted consumer scope, never from the remedy. */
    action: z.nullable(z.strictObject({ actionId: z.literal('usage.coach.apply'), detectorId: UsageCoachDetectorIdSchema, evidenceKey: Id })),
    estimate: z.optional(UsageCoachEstimateSchema),
    modelComparison: z.optional(UsageCoachModelComparisonDetailSchema),
    cacheCauses: z.optional(z.array(z.strictObject({ cause: z.enum(['ttl_expired', 'prefix_change']), cacheWriteTokens: Amount,
        premiumUsd: z.nullable(Amount) }))),
    state: UsageCoachFindingStateSchema,
}).check(z.superRefine((value, context) => {
    if (value.modelComparison && (value.detectorId !== 'model_misfit'
        || value.summaryCode !== 'comparable_completed_request_cost_difference')) {
        context.addIssue({ code: 'custom', message: 'Host response-completion comparison belongs only to its model finding', path: ['modelComparison'] });
    }
    if (value.currentness === 'current' && value.asOfMs === null) {
        context.addIssue({ code: 'custom', message: 'Current evidence requires a witnessed observation time', path: ['asOfMs'] });
    }
    if ((value.remedy === null) !== (value.action === null)
        || value.action && (value.currentness !== 'current' || value.action.detectorId !== value.detectorId
            || value.action.evidenceKey !== value.evidenceKey)) {
        context.addIssue({ code: 'custom', message: 'Apply must identify the current finding and its admitted remedy', path: ['action'] });
    }
    if (value.evidence.some(ref => ref.observedAtMs < value.period.startMs || ref.observedAtMs >= value.period.endMs
        || value.asOfMs !== null && ref.observedAtMs > value.asOfMs)) {
        context.addIssue({ code: 'custom', message: 'Evidence must belong to the witnessed finding period', path: ['evidence'] });
    }
    const evidenceSamples = new Set(value.evidence.map(ref => JSON.stringify([ref.id, ref.observedAtMs])));
    for (const [index, series] of (value.evidenceSeries ?? []).entries()) {
        if (new Set(series.points.map(point => point.evidenceId)).size !== series.points.length
            || series.points.some((point, pointIndex) => !evidenceSamples.has(JSON.stringify([point.evidenceId, point.observedAtMs]))
                || pointIndex > 0 && (series.points[pointIndex - 1]!.observedAtMs > point.observedAtMs
                    || series.points[pointIndex - 1]!.observedAtMs === point.observedAtMs
                        && series.points[pointIndex - 1]!.evidenceId.localeCompare(point.evidenceId) > 0))) {
            context.addIssue({ code: 'custom', message: 'Series samples must identify distinct finding evidence in observation order',
                path: ['evidenceSeries', index, 'points'] });
        }
    }
    if (value.estimate && (value.estimate.period.startMs !== value.period.startMs || value.estimate.period.endMs !== value.period.endMs
        || value.estimate.evidenceIds.some(id => !value.evidence.some(ref => ref.id === id)))) {
        context.addIssue({ code: 'custom', message: 'Estimate must use the finding period and evidence', path: ['estimate'] });
    }
})));
export type UsageCoachFinding = z.infer<typeof UsageCoachFindingSchema>;
export const UsageCoachConceptEvaluationSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
    z.strictObject({ detectorId: UsageCoachDetectorIdSchema, requiredEvidence: z.array(UsageCoachCapabilitySchema),
        status: z.literal('finding'), finding: UsageCoachFindingSchema }),
    z.strictObject({ detectorId: UsageCoachDetectorIdSchema, requiredEvidence: z.array(UsageCoachCapabilitySchema),
        status: z.literal('insufficient_evidence'), missingEvidence: z.array(UsageCoachCapabilitySchema).check(z.minLength(1)) }),
    z.strictObject({ detectorId: UsageCoachDetectorIdSchema, requiredEvidence: z.array(UsageCoachCapabilitySchema),
        status: z.literal('no_finding') }),
    z.strictObject({ detectorId: UsageCoachDetectorIdSchema, requiredEvidence: z.array(UsageCoachCapabilitySchema),
        status: z.literal('disabled') }),
]).check(z.superRefine((value, context) => {
    if (JSON.stringify(value.requiredEvidence) !== JSON.stringify(USAGE_COACH_REQUIRED_EVIDENCE[value.detectorId])) {
        context.addIssue({ code: 'custom', message: 'The concept must declare its required evidence', path: ['requiredEvidence'] });
    }
    if (value.status === 'finding' && value.finding.detectorId !== value.detectorId) {
        context.addIssue({ code: 'custom', message: 'The evaluated concept and finding must match', path: ['finding', 'detectorId'] });
    }
    if (value.status === 'insufficient_evidence' && (new Set(value.missingEvidence).size !== value.missingEvidence.length
        || value.missingEvidence.some(capability => !value.requiredEvidence.includes(capability)))) {
        context.addIssue({ code: 'custom', message: 'Missing evidence must identify unmet required capabilities', path: ['missingEvidence'] });
    }
})));
export type UsageCoachConceptEvaluation = z.infer<typeof UsageCoachConceptEvaluationSchema>;
export const UsageCoachEvaluationSchema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), queryKey: Id, period: UsageCoachPeriodSchema, asOfMs: z.nullable(Time),
    currentness: UsageCoachCurrentnessSchema, evaluations: z.array(UsageCoachConceptEvaluationSchema),
    sessionCoverage: z.optional(UsageSessionEvidenceCoverageSchema),
    findings: z.array(UsageCoachFindingSchema),
    digestSuggestion: z.optional(UsageCoachDigestSuggestionSchema),
    unavailableChecks: z.optional(z.array(z.strictObject({ check: z.enum(['fast_mode', 'scheduled_interval_vs_ttl']),
        reason: z.literal('not_available') }))),
}).check(z.superRefine((value, context) => {
    if (value.digestSuggestion && (value.digestSuggestion.queryKey !== value.queryKey
        || value.digestSuggestion.lookbackMs !== value.period.endMs - value.period.startMs)) {
        context.addIssue({ code: 'custom', message: 'The digest must belong to this query and witnessed period', path: ['digestSuggestion'] });
    }
    if (value.currentness === 'current' && value.asOfMs === null) {
        context.addIssue({ code: 'custom', message: 'Current evidence requires a witnessed observation time', path: ['asOfMs'] });
    }
    if (value.evaluations.length !== USAGE_COACH_DETECTOR_IDS.length
        || new Set(value.evaluations.map(row => row.detectorId)).size !== USAGE_COACH_DETECTOR_IDS.length) {
        context.addIssue({ code: 'custom', message: 'Every built-in concept must be represented exactly once', path: ['evaluations'] });
    }
    const findings = value.evaluations.flatMap(row => row.status === 'finding' ? [row.finding] : []);
    if (JSON.stringify(value.findings) !== JSON.stringify(findings)) {
        context.addIssue({ code: 'custom', message: 'Published findings must match the evaluated findings', path: ['findings'] });
    }
    if (findings.some(finding => finding.queryKey !== value.queryKey || finding.period.startMs !== value.period.startMs
        || finding.period.endMs !== value.period.endMs || finding.asOfMs !== value.asOfMs || finding.currentness !== value.currentness)) {
        context.addIssue({ code: 'custom', message: 'Findings must belong to this query and observation', path: ['findings'] });
    }
})));
export type UsageCoachEvaluation = z.infer<typeof UsageCoachEvaluationSchema>;

export interface UsageCoachFileReadFact {
    evidenceId: string; observedAtMs: number; turnId: string; fileKey: string;
    versionDigest: string | null; selectionKey: string; reason: 'required' | 'redundant' | 'unknown';
}
export interface UsageCoachCompactionFact { evidenceId: string; observedAtMs: number; sessionId: string; turnId: string | null;
    /** Native refill witness, never inferred from timestamps or compaction count. */
    immediateRefillToLimit?: boolean | null }
export interface UsageCoachToolFact { evidenceId: string; observedAtMs: number; serverKey: string; toolId: string }
export interface UsageCoachLoopFact {
    evidenceId: string; observedAtMs: number; turnId: string; operationKey: string;
    errorDigest?: string | null;
    outcome: 'failed' | 'succeeded' | 'unknown'; progress: 'none' | 'observed' | 'unknown';
}
export interface UsageCoachNativeCacheFact {
    evidenceId: string; observedAtMs: number; inputId: string; boundary: 'agent_native_request';
    cacheOutcome: 'hit' | 'miss' | 'unknown'; missCause: 'prefix_change' | 'ttl_expired' | 'other' | 'unknown';
    cacheWriteTokens: number | null; idleMs: number | null; prefixDigest: string | null; previousPrefixDigest: string | null;
    ttlMs?: number | null; sessionId?: string; turnId?: string; modelId?: string;
    rebuildCause?: 'compaction' | 'tool_result_clearing' | 'model_switch' | 'effort_switch' | 'unexpected' | 'unknown';
}
/** Facts have already passed the captured Home/Account/Session read admission. */
export interface UsageCoachDetailFacts {
    coverage: 'complete' | 'partial' | 'unknown';
    permissions?: readonly (UsageWorkPermissionFact & { cacheTtlMs?: number | null })[];
    fileReads?: readonly UsageCoachFileReadFact[];
    compactions?: readonly UsageCoachCompactionFact[];
    toolUses?: readonly UsageCoachToolFact[];
    mcpUsage?: readonly UsageMcpBindingUsage[];
    loops?: readonly UsageCoachLoopFact[];
    nativeCache?: readonly UsageCoachNativeCacheFact[];
    modelRequests?: readonly UsageCoachModelRequest[];
    /** Only a request-bound effort observation can produce the audit; current Session defaults cannot. */
    effortAudits?: readonly { evidenceId: string; observedAtMs: number; effort: string;
        outputTokens: number; thinkingTokens: number }[];
    /** Exact accounting tree totals, not parentWorkId-based ownership guesses. */
    subagentUsage?: readonly { evidenceId: string; observedAtMs: number; parentTokens: number; subagentTokens: number }[];
}
export interface UsageCoachEvaluationInput {
    queryKey: string; period: Readonly<{ startMs: number; endMs: number }>; asOfMs: number | null;
    currentness: z.infer<typeof UsageCoachCurrentnessSchema>;
    preferences?: z.input<typeof UsageCoachPreferencesV1Schema> | null;
    accounting?: UsageAnalyticsQueryResponse; detail?: UsageCoachDetailFacts;
    pricingOverrides?: UsageModelPriceOverridesV1;
    composition?: readonly UsagePromptComposition[];
    compositionCoverage?: 'complete' | 'partial' | 'unknown';
    admittedRemedies?: readonly UsageCoachAdmittedRemedy[];
    findingStates?: readonly { detectorId: UsageCoachDetectorId; evidenceKey: string;
        state: z.infer<typeof UsageCoachFindingStateSchema> }[];
}
export interface UsageCoachAdmittedRemedy {
    detectorId: UsageCoachDetectorId; evidenceIds: readonly string[]; remedy: UsageCoachRemedy;
}
export type UsageCoachReadEvidence = Pick<UsageCoachEvaluationInput,
    'detail' | 'composition' | 'compositionCoverage' | 'admittedRemedies' | 'findingStates'>;
