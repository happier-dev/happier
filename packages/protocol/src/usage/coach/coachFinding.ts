import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import type { UsageAnalyticsQueryResponse } from '../usageAnalyticsContracts.js';
import type { UsageWorkPermissionFact } from '../usageWorkIntervals.js';
import { UsageCoachRemedySchema, type UsageCoachRemedy } from './coachRemedy.js';
import type { UsagePromptComposition } from './usagePromptComposition.js';
import type { UsageMcpBindingUsage } from './usageMcpBindingUsage.js';
import type { UsageCoachModelRequest } from './usagePromptComposition.js';
import { ProviderConnectionIdSchema, ProviderAgentTargetKeySchema } from '../../providers/ids.js';
import { UsageCoachDigestSuggestionSchema } from './coachDigestSuggestion.js';
export { UsageCoachDigestSuggestionSchema, type UsageCoachDigestSuggestion } from './coachDigestSuggestion.js';

/** This V1 read projection is closed recursively. It grants no mutation authority. */
export const USAGE_COACH_DETECTOR_IDS = [
    'duplicated_instructions', 'model_misfit', 'idle_recaching', 'approval_friction',
    'mcp_overhead', 'repeated_file_reads', 'compaction_storms', 'anomalous_looping_usage',
    'cache_busting_prompt_changes', 'outside_usage', 'context_bloat',
] as const;
export const UsageCoachDetectorIdSchema = lazyZodSchema(() => z.enum(USAGE_COACH_DETECTOR_IDS));
export type UsageCoachDetectorId = z.infer<typeof UsageCoachDetectorIdSchema>;
export const UsageCoachCapabilitySchema = lazyZodSchema(() => z.enum([
    'instruction_injections', 'model_outcome_comparison', 'native_cache_cause',
    'permission_request_decision_pairs', 'mcp_schema_and_tool_use', 'file_identity_version_reads',
    'compaction_events', 'loop_operation_outcomes', 'native_prefix_cache_cause',
    'accounting_origin', 'context_composition_capacity',
]));
export type UsageCoachCapability = z.infer<typeof UsageCoachCapabilitySchema>;
export const USAGE_COACH_REQUIRED_EVIDENCE = {
    duplicated_instructions: ['instruction_injections'], model_misfit: ['model_outcome_comparison'],
    idle_recaching: ['native_cache_cause'], approval_friction: ['permission_request_decision_pairs'],
    mcp_overhead: ['mcp_schema_and_tool_use'], repeated_file_reads: ['file_identity_version_reads'],
    compaction_storms: ['compaction_events'], anomalous_looping_usage: ['loop_operation_outcomes'],
    cache_busting_prompt_changes: ['native_prefix_cache_cause'], outside_usage: ['accounting_origin'],
    context_bloat: ['context_composition_capacity'],
} as const satisfies Record<UsageCoachDetectorId, readonly UsageCoachCapability[]>;
const Id = lazyZodSchema(() => z.string().min(1));
const Time = lazyZodSchema(() => z.number().int().nonnegative());
const Amount = lazyZodSchema(() => z.number().finite().nonnegative());
export const UsageCoachPeriodSchema = lazyZodSchema(() => z.object({ startMs: Time, endMs: Time }).strict()
    .refine(value => value.endMs >= value.startMs));
export const UsageCoachCurrentnessSchema = lazyZodSchema(() => z.enum(['current', 'stale', 'unknown']));
export const UsageCoachEvidenceReferenceSchema = lazyZodSchema(() => z.object({
    kind: z.enum(['accounting', 'permission', 'composition', 'file_read', 'compaction', 'model_comparison', 'native_cache', 'tool', 'loop', 'mcp_usage']),
    id: Id, observedAtMs: Time,
}).strict());
export const UsageCoachMeasurementSchema = lazyZodSchema(() => z.object({
    metric: z.enum(['duplicate_injections', 'duplicate_bytes', 'observed_cost_difference', 'cache_write_tokens',
        'permission_wait', 'permission_requests', 'unused_schema_bytes', 'unused_mcp_bindings', 'unchanged_reads', 'compactions',
        'failed_repetitions', 'outside_tokens', 'composed_tokens', 'context_window_tokens']),
    value: Amount, unit: z.enum(['count', 'bytes', 'tokens', 'milliseconds', 'currency']),
    currency: Id.optional(),
    costKind: z.enum(['reported', 'estimated', 'api_equivalent', 'invoice']).optional(),
}).strict());
export const UsageCoachEstimateSchema = lazyZodSchema(() => z.object({
    kind: z.enum(['observed_difference', 'potential_duplicate_bytes']), value: Amount,
    unit: z.enum(['bytes', 'currency']), currency: Id.optional(),
    method: z.enum(['matched_outcome_cost_v1', 'duplicate_injection_bytes_v1']),
    assumptions: z.array(z.string()), period: UsageCoachPeriodSchema, evidenceIds: z.array(Id).min(1),
}).strict());
export const UsageCoachModelComparisonDetailSchema = lazyZodSchema(() => z.object({
    basis: z.literal('matched_completed_host_request_v1'), sessionId: Id,
    agentTargetKey: ProviderAgentTargetKeySchema, providerConnectionId: ProviderConnectionIdSchema.nullable(),
    modelId: Id, candidateModelId: Id, modelTurnId: Id, candidateTurnId: Id,
    requestKey: Id, requestScopeKey: Id, modelCost: Amount, candidateCost: Amount,
    currency: Id, costKind: z.enum(['reported', 'estimated', 'api_equivalent', 'invoice']),
}).strict().refine(value => value.modelId !== value.candidateModelId && value.modelTurnId !== value.candidateTurnId
    && value.modelCost > value.candidateCost));
export const UsageCoachFindingStateSchema = lazyZodSchema(() => z.object({
    dismissed: z.boolean(), snoozedUntilMs: Time.nullable(),
    applied: z.object({ asOfMs: Time, remedy: UsageCoachRemedySchema }).strict().nullable(),
}).strict());
export const UsageCoachFindingSchema = lazyZodSchema(() => z.object({
    detectorId: UsageCoachDetectorIdSchema, evidenceKey: Id, queryKey: Id,
    period: UsageCoachPeriodSchema, asOfMs: Time.nullable(), currentness: UsageCoachCurrentnessSchema,
    coverage: z.enum(['complete', 'partial', 'unknown']), severity: z.enum(['info', 'warning']),
    summaryCode: z.enum(['duplicate_injection_observed', 'compatible_model_cost_difference', 'idle_cache_recreation_observed',
        'approval_wait_observed', 'unused_mcp_schema_observed', 'unused_mcp_binding_observed', 'redundant_unchanged_read_observed',
        'repeated_compaction_observed', 'failed_loop_observed', 'prefix_change_cache_miss_observed',
        'outside_happier_usage_observed', 'context_capacity_reached', 'comparable_completed_request_cost_difference']),
    evidence: z.array(UsageCoachEvidenceReferenceSchema).min(1), measurements: z.array(UsageCoachMeasurementSchema),
    remedy: UsageCoachRemedySchema.nullable(),
    /** The query comes from the admitted consumer scope, never from the remedy. */
    action: z.object({ actionId: z.literal('usage.coach.apply'), detectorId: UsageCoachDetectorIdSchema, evidenceKey: Id }).strict().nullable(),
    estimate: UsageCoachEstimateSchema.optional(),
    modelComparison: UsageCoachModelComparisonDetailSchema.optional(),
    state: UsageCoachFindingStateSchema,
}).strict().superRefine((value, context) => {
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
    if (value.estimate && (value.estimate.period.startMs !== value.period.startMs || value.estimate.period.endMs !== value.period.endMs
        || value.estimate.evidenceIds.some(id => !value.evidence.some(ref => ref.id === id)))) {
        context.addIssue({ code: 'custom', message: 'Estimate must use the finding period and evidence', path: ['estimate'] });
    }
}));
export type UsageCoachFinding = z.infer<typeof UsageCoachFindingSchema>;
export const UsageCoachConceptEvaluationSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
    z.object({ detectorId: UsageCoachDetectorIdSchema, requiredEvidence: z.array(UsageCoachCapabilitySchema),
        status: z.literal('finding'), finding: UsageCoachFindingSchema }).strict(),
    z.object({ detectorId: UsageCoachDetectorIdSchema, requiredEvidence: z.array(UsageCoachCapabilitySchema),
        status: z.literal('insufficient_evidence'), missingEvidence: z.array(UsageCoachCapabilitySchema).min(1) }).strict(),
    z.object({ detectorId: UsageCoachDetectorIdSchema, requiredEvidence: z.array(UsageCoachCapabilitySchema),
        status: z.literal('no_finding') }).strict(),
]).superRefine((value, context) => {
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
}));
export type UsageCoachConceptEvaluation = z.infer<typeof UsageCoachConceptEvaluationSchema>;
export const UsageCoachEvaluationSchema = lazyZodSchema(() => z.object({
    v: z.literal(1), queryKey: Id, period: UsageCoachPeriodSchema, asOfMs: Time.nullable(),
    currentness: UsageCoachCurrentnessSchema, evaluations: z.array(UsageCoachConceptEvaluationSchema),
    findings: z.array(UsageCoachFindingSchema),
    digestSuggestion: UsageCoachDigestSuggestionSchema.optional(),
}).strict().superRefine((value, context) => {
    if (value.digestSuggestion && (value.digestSuggestion.queryKey !== value.queryKey
        || value.digestSuggestion.lookbackMs !== value.period.endMs - value.period.startMs)) {
        context.addIssue({ code: 'custom', message: 'The digest must belong to this query and witnessed period', path: ['digestSuggestion'] });
    }
    if (value.currentness === 'current' && value.asOfMs === null) {
        context.addIssue({ code: 'custom', message: 'Current evidence requires a witnessed observation time', path: ['asOfMs'] });
    }
    if (value.evaluations.length !== USAGE_COACH_DETECTOR_IDS.length
        || new Set(value.evaluations.map(row => row.detectorId)).size !== USAGE_COACH_DETECTOR_IDS.length) {
        context.addIssue({ code: 'custom', message: 'Every built-in concept must be evaluated exactly once', path: ['evaluations'] });
    }
    const findings = value.evaluations.flatMap(row => row.status === 'finding' ? [row.finding] : []);
    if (JSON.stringify(value.findings) !== JSON.stringify(findings)) {
        context.addIssue({ code: 'custom', message: 'Published findings must match the evaluated findings', path: ['findings'] });
    }
    if (findings.some(finding => finding.queryKey !== value.queryKey || finding.period.startMs !== value.period.startMs
        || finding.period.endMs !== value.period.endMs || finding.asOfMs !== value.asOfMs || finding.currentness !== value.currentness)) {
        context.addIssue({ code: 'custom', message: 'Findings must belong to this query and observation', path: ['findings'] });
    }
}));
export type UsageCoachEvaluation = z.infer<typeof UsageCoachEvaluationSchema>;

export interface UsageCoachFileReadFact {
    evidenceId: string; observedAtMs: number; turnId: string; fileKey: string;
    versionDigest: string | null; selectionKey: string; reason: 'required' | 'redundant' | 'unknown';
}
export interface UsageCoachCompactionFact { evidenceId: string; observedAtMs: number; sessionId: string; turnId: string | null }
export interface UsageCoachToolFact { evidenceId: string; observedAtMs: number; serverKey: string; toolId: string }
export interface UsageCoachLoopFact {
    evidenceId: string; observedAtMs: number; turnId: string; operationKey: string;
    outcome: 'failed' | 'succeeded' | 'unknown'; progress: 'none' | 'observed' | 'unknown';
}
export interface UsageCoachNativeCacheFact {
    evidenceId: string; observedAtMs: number; inputId: string; boundary: 'agent_native_request';
    cacheOutcome: 'hit' | 'miss' | 'unknown'; missCause: 'prefix_change' | 'ttl_expired' | 'other' | 'unknown';
    cacheWriteTokens: number | null; idleMs: number | null; prefixDigest: string | null; previousPrefixDigest: string | null;
}
export interface UsageCoachModelComparisonFact {
    evidenceId: string; observedAtMs: number; workloadKey: string; modelId: string; candidateModelId: string;
    requiredOutcomeKey: string; modelOutcome: 'met' | 'not_met' | 'unknown'; candidateOutcome: 'met' | 'not_met' | 'unknown';
    costKind: 'reported' | 'estimated' | 'api_equivalent' | 'invoice'; currency: string;
    modelCost: number; candidateCost: number;
}
/** Facts have already passed the captured Home/Account/Session read admission. */
export interface UsageCoachDetailFacts {
    coverage: 'complete' | 'partial' | 'unknown';
    permissions?: readonly UsageWorkPermissionFact[];
    fileReads?: readonly UsageCoachFileReadFact[];
    compactions?: readonly UsageCoachCompactionFact[];
    toolUses?: readonly UsageCoachToolFact[];
    mcpUsage?: readonly UsageMcpBindingUsage[];
    loops?: readonly UsageCoachLoopFact[];
    nativeCache?: readonly UsageCoachNativeCacheFact[];
    modelComparisons?: readonly UsageCoachModelComparisonFact[];
    modelRequests?: readonly UsageCoachModelRequest[];
}
export interface UsageCoachEvaluationInput {
    queryKey: string; period: Readonly<{ startMs: number; endMs: number }>; asOfMs: number | null;
    currentness: z.infer<typeof UsageCoachCurrentnessSchema>;
    accounting?: UsageAnalyticsQueryResponse; detail?: UsageCoachDetailFacts;
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
