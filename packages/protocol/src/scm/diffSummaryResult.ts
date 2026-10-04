import { z } from 'zod';
import { BackendTargetRefV2Schema } from '../backends/targets/backendTargetRefV2.js';
import { ProviderBoundModelRefSchema } from '../providers/selection/v1.js';
import { ScmCommitPlanApplicationSchema } from './diffSummaryCommitPlan.js';
import {
  ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryOutputKindSchema,
  ScmDiffSummaryWalkthroughSchema, ScmDiffSummaryCommitPlanSchema, ScmDiffSummarySummarySchema,
  ScmDiffSummarySourceSchema,
  ScmReviewExplanationTargetsSchema,
} from './diffSummary.js';

export const ScmDiffSummaryGeneratorSelectionSchema = z.object({ backendTarget: BackendTargetRefV2Schema,
  modelId: z.string().min(1).optional(), profileId: z.string().min(1).optional(),
  modelSelection: ProviderBoundModelRefSchema.optional(),
}).strict();
export type ScmDiffSummaryGeneratorSelection = z.infer<typeof ScmDiffSummaryGeneratorSelectionSchema>;
/** Presentation facts stamped by the revisioned result owner, never by the model. */
export const ScmWalkthroughProvenanceSchema = z.object({
  titleEdited: z.boolean(),
  stops: z.array(z.object({ stopId: z.string().min(1), titleEdited: z.boolean(),
    changedAtRevision: z.number().int().nonnegative().optional(), movedAtRevision: z.number().int().nonnegative().optional(),
  }).strict()),
}).strict();
export const ScmResultUpdateNoticeSchema = z.object({
  kind: z.enum(['edit', 'generation', 'undo']), revision: z.number().int().nonnegative(),
  affectedStopIds: z.array(z.string().min(1)), mergedStopIds: z.array(z.string().min(1)).optional(),
}).strict();
export const ScmDiffSummaryResultSchema = z.object({
  resultId: z.string().min(1), revision: z.number().int().nonnegative(),
  output: ScmDiffSummaryGenerateOutputSchema, canUndo: z.boolean(),
  generator: ScmDiffSummaryGeneratorSelectionSchema.optional(),
  application: ScmCommitPlanApplicationSchema.optional(),
  walkthroughProvenance: ScmWalkthroughProvenanceSchema.optional(),
  updateNotice: ScmResultUpdateNoticeSchema.optional(),
}).strict().refine((result) => result.output.resultId === result.resultId && result.output.revision === result.revision,
  'Result projection must identify its current revision');
export type ScmDiffSummaryResult = z.infer<typeof ScmDiffSummaryResultSchema>;

export const ScmDiffSummaryResultReadInputSchema = z.object({ cwd: z.string().min(1), resultId: z.string().min(1) }).strict();
export type ScmDiffSummaryResultReadInput = z.infer<typeof ScmDiffSummaryResultReadInputSchema>;
export const ScmDiffSummaryResultRevisionInputSchema = ScmDiffSummaryResultReadInputSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
}).strict();
export type ScmDiffSummaryResultRevisionInput = z.infer<typeof ScmDiffSummaryResultRevisionInputSchema>;

const ids = z.array(z.string().min(1)).min(1).refine((values) => new Set(values).size === values.length, 'Ids must be unique');
const commitGroupTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('group'), groupId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('newGroup'), group: z.object({ id: z.string().min(1),
    message: z.string().trim().min(1), rationale: z.string() }).strict() }).strict(),
  z.object({ kind: z.literal('leftOut') }).strict(),
]);
export const ScmDiffSummaryResultEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('renameWalkthrough'), title: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('renameStop'), stopId: z.string().min(1), title: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('editStop'), stopId: z.string().min(1), explanationMarkdown: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('reorderStops'), stopIds: ids }).strict(),
  z.object({ kind: z.literal('mergeStops'), stopIds: ids, targetStopId: z.string().min(1),
    title: z.string().trim().min(1).optional(), explanationMarkdown: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('replaceSummary'), value: ScmDiffSummarySummarySchema }).strict(),
  z.object({ kind: z.literal('replaceWalkthrough'), value: ScmDiffSummaryWalkthroughSchema }).strict(),
  z.object({ kind: z.literal('replaceCommitPlan'), value: ScmDiffSummaryCommitPlanSchema }).strict(),
  z.object({ kind: z.literal('editCommitGroup'), groupId: z.string().min(1),
    message: z.string().trim().min(1).optional(), rationale: z.string().optional() }).strict(),
  z.object({ kind: z.literal('reorderCommitGroups'), groupIds: ids }).strict(),
  z.object({ kind: z.literal('mergeCommitGroups'), groupIds: ids, targetGroupId: z.string().min(1),
    message: z.string().trim().min(1).optional(), rationale: z.string().optional() }).strict(),
  z.object({ kind: z.literal('moveCommitChanges'), changeRefs: ids, target: commitGroupTarget }).strict(),
  /** Discards one output (for example a commit proposal) while the result keeps its others; Undo restores it. */
  z.object({ kind: z.literal('removeOutput'), output: ScmDiffSummaryOutputKindSchema }).strict(),
]).refine((edit) => edit.kind !== 'editCommitGroup' || edit.message !== undefined || edit.rationale !== undefined,
  'A commit group edit must change its message or rationale');
export type ScmDiffSummaryResultEdit = z.infer<typeof ScmDiffSummaryResultEditSchema>;
export const ScmDiffSummaryResultEditInputSchema = ScmDiffSummaryResultRevisionInputSchema.extend({ edit: ScmDiffSummaryResultEditSchema }).strict();
export type ScmDiffSummaryResultEditInput = z.infer<typeof ScmDiffSummaryResultEditInputSchema>;
export const ScmDiffSummaryRefineInputSchema = ScmDiffSummaryResultRevisionInputSchema.extend({
  output: ScmDiffSummaryOutputKindSchema, instructions: z.string().trim().min(1), stopIds: ids.optional(),
  reviewExplanation: z.object({ targets: ScmReviewExplanationTargetsSchema }).strict().optional(),
}).strict().refine((value) => !value.stopIds || value.output === 'walkthrough', 'Stop targeting requires walkthrough output')
  .refine(value => !value.reviewExplanation || (value.output === 'walkthrough' && value.stopIds
    && value.stopIds.length === value.reviewExplanation.targets.length
    && value.reviewExplanation.targets.every(target => value.stopIds!.includes(target.stopId))),
  'Finding explanations require exactly their selected walkthrough stops');
export type ScmDiffSummaryRefineInput = z.infer<typeof ScmDiffSummaryRefineInputSchema>;
export const ScmDiffSummaryAddOutputsInputSchema = ScmDiffSummaryResultRevisionInputSchema.extend({
  outputs: z.array(ScmDiffSummaryOutputKindSchema).min(1)
    .refine((values) => new Set(values).size === values.length, 'Outputs must be unique'),
}).strict();
export type ScmDiffSummaryAddOutputsInput = z.infer<typeof ScmDiffSummaryAddOutputsInputSchema>;
export const ScmDiffSummaryDiscussInputSchema = ScmDiffSummaryResultRevisionInputSchema.extend({
  message: z.string().trim().min(1), stopIds: ids.optional(), startNew: z.boolean().optional(),
}).strict();
export type ScmDiffSummaryDiscussInput = z.infer<typeof ScmDiffSummaryDiscussInputSchema>;

export const ScmDiffSummaryResultErrorCodeSchema = z.enum([
  'result_not_found', 'revision_conflict', 'invalid_edit', 'invalid_output', 'nothing_to_undo',
  'discussion_unavailable', 'admission_failed', 'admission_unknown', 'result_unavailable',
  'application_locked', 'application_unavailable', 'source_not_pending', 'plan_unavailable',
  'acceptance_mismatch', 'backend_unsupported', 'source_changed', 'head_moved', 'selection_conflict',
]);
export const ScmDiffSummaryResultFailureSchema = z.object({
  success: z.literal(false), errorCode: ScmDiffSummaryResultErrorCodeSchema,
  error: z.string().min(1), latestRevision: z.number().int().nonnegative().optional(),
}).strict();
export type ScmDiffSummaryResultFailure = z.infer<typeof ScmDiffSummaryResultFailureSchema>;
export const ScmDiffSummaryResultResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), result: ScmDiffSummaryResultSchema,
    runId: z.string().min(1).optional(), seededFromRunId: z.string().min(1).optional(),
    inputId: z.string().min(1).optional(),
  }).strict(), ScmDiffSummaryResultFailureSchema,
]);
export type ScmDiffSummaryResultResponse = z.infer<typeof ScmDiffSummaryResultResponseSchema>;
export const ScmDiffSummaryResultDeleteResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), resultId: z.string().min(1), comparisonId: z.string().min(1),
    marksCleanup: z.object({ success: z.boolean(), errorCode: z.string().min(1).optional(), error: z.string().min(1).optional() }).strict().optional(),
  }).strict(),
  ScmDiffSummaryResultFailureSchema,
]);
export type ScmDiffSummaryResultDeleteResponse = z.infer<typeof ScmDiffSummaryResultDeleteResponseSchema>;

/** Machine-owned inventory references; source evidence remains in the saved result. */
export const ScmDiffSummarySavedResultReferenceSchema = ScmDiffSummaryResultRevisionInputSchema.extend({
  comparisonId: z.string().min(1), sessionId: z.string().min(1).optional(),
}).strict();
export type ScmDiffSummarySavedResultReference = z.infer<typeof ScmDiffSummarySavedResultReferenceSchema>;
export const ScmDiffSummarySavedResultItemSchema = z.object({
  cwd: z.string().min(1), sessionId: z.string().min(1).optional(), resultId: z.string().min(1),
  revision: z.number().int().nonnegative(), comparisonId: z.string().min(1),
  title: z.string().optional(), source: ScmDiffSummarySourceSchema, bytes: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
}).strict();
export type ScmDiffSummarySavedResultItem = z.infer<typeof ScmDiffSummarySavedResultItemSchema>;
export const ScmDiffSummarySevenDayCostSchema = z.object({
  status: z.enum(['partial', 'unavailable']), estimatedUsd: z.number().finite().nonnegative().optional(),
  pricedRunCount: z.number().int().nonnegative(), unpricedRunCount: z.number().int().nonnegative(),
  sinceMs: z.number().int().nonnegative(), untilMs: z.number().int().nonnegative(),
}).strict();
export type ScmDiffSummarySevenDayCost = z.infer<typeof ScmDiffSummarySevenDayCostSchema>;
export const ScmDiffSummaryResultListInputSchema = z.object({}).strict();
export const ScmDiffSummaryResultListResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), results: z.array(ScmDiffSummarySavedResultItemSchema),
    count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(),
    sevenDayCost: ScmDiffSummarySevenDayCostSchema,
  }).strict(), ScmDiffSummaryResultFailureSchema,
]);
export type ScmDiffSummaryResultListResponse = z.infer<typeof ScmDiffSummaryResultListResponseSchema>;
export const ScmDiffSummaryResultClearInputSchema = z.object({
  results: z.array(ScmDiffSummarySavedResultReferenceSchema)
    .refine((values) => new Set(values.map(value => value.resultId)).size === values.length, 'Saved result identities must be unique'),
}).strict();
export type ScmDiffSummaryResultClearInput = z.infer<typeof ScmDiffSummaryResultClearInputSchema>;
export const ScmDiffSummaryResultClearResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true),
    deleted: z.array(ScmDiffSummaryResultDeleteResponseSchema.options[0]),
    failures: z.array(z.object({ resultId: z.string().min(1), ...ScmDiffSummaryResultFailureSchema.shape }).strict()),
  }).strict(), ScmDiffSummaryResultFailureSchema,
]);
export type ScmDiffSummaryResultClearResponse = z.infer<typeof ScmDiffSummaryResultClearResponseSchema>;
