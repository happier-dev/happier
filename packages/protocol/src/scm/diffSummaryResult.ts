import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { BackendTargetRefV2Schema } from '../backends/targets/backendTargetRefV2.js';
import { ProviderBoundModelRefSchema } from '../providers/selection/v1.js';
import { ConnectedServiceBindingsV2Schema } from '../connect/connectedServiceBindings.js';
import { SESSION_INPUT_ADMISSION_REJECTION_CODES_V1 } from '../sessions/messages/sessionInputAdmissionRejectionV1.js';
import { ScmCommitPlanApplicationSchema } from './diffSummaryCommitPlan.js';
import { ScmReviewedMarksResetInputSchema } from './reviewedMarks.js';
import {
  ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryOutputKindSchema,
  ScmDiffSummaryWalkthroughSchema, ScmDiffSummaryCommitPlanSchema, ScmDiffSummarySummarySchema,
  ScmDiffSummarySourceSchema,
  ScmReviewExplanationTargetsSchema,
  ScmDiffSummaryOutputLanguageSchema,
} from './diffSummary.js';

export const ScmDiffSummaryGeneratorSelectionSchema = lazyZodSchema(() => z.strictObject({ backendTarget: BackendTargetRefV2Schema,
  investigateSurroundingFiles: z.optional(z.boolean()),
  outputLanguage: z.optional(ScmDiffSummaryOutputLanguageSchema),
  modelId: z.optional(z.string().check(z.minLength(1))), profileId: z.optional(z.string().check(z.minLength(1))),
  modelSelection: z.optional(ProviderBoundModelRefSchema),
  connectedServices: z.optional(z.nullable(ConnectedServiceBindingsV2Schema)),
}));
export type ScmDiffSummaryGeneratorSelection = z.infer<typeof ScmDiffSummaryGeneratorSelectionSchema>;
/** Presentation facts stamped by the revisioned result owner, never by the model. */
export const ScmWalkthroughProvenanceSchema = lazyZodSchema(() => z.strictObject({
  titleEdited: z.boolean(),
  stops: z.array(z.strictObject({ stopId: z.string().check(z.minLength(1)), titleEdited: z.boolean(),
    changedAtRevision: z.optional(z.number().check(z.int(), z.nonnegative())), movedAtRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
  })),
}));
export const ScmResultUpdateNoticeSchema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['edit', 'generation', 'undo']), revision: z.number().check(z.int(), z.nonnegative()),
  affectedStopIds: z.array(z.string().check(z.minLength(1))), mergedStopIds: z.optional(z.array(z.string().check(z.minLength(1)))),
}));
/** Transcript presentation beside the exact saved output in meta.happier; never mutation authority. */
export const ScmDiffSummaryPublicationReceiptSchema = lazyZodSchema(() => z.strictObject({
  status: z.literal('published'), canUndo: z.boolean(),
  updateNotice: z.optional(ScmResultUpdateNoticeSchema),
  titleEditKept: z.optional(z.boolean()),
  outputs: z.array(z.strictObject({ kind: ScmDiffSummaryOutputKindSchema, change: z.enum(['created', 'updated']) }))
    .check(z.minLength(1), z.refine(outputs => new Set(outputs.map(output => output.kind)).size === outputs.length, 'Published output kinds must be unique')),
}));
export type ScmDiffSummaryPublicationReceipt = z.infer<typeof ScmDiffSummaryPublicationReceiptSchema>;
export const ScmDiffSummaryResultSchema = lazyZodSchema(() => z.strictObject({
  resultId: z.string().check(z.minLength(1)), revision: z.number().check(z.int(), z.nonnegative()),
  output: ScmDiffSummaryGenerateOutputSchema, canUndo: z.boolean(),
  generator: z.optional(ScmDiffSummaryGeneratorSelectionSchema),
  application: z.optional(ScmCommitPlanApplicationSchema),
  walkthroughProvenance: z.optional(ScmWalkthroughProvenanceSchema),
  updateNotice: z.optional(ScmResultUpdateNoticeSchema),
}).check(z.refine((result) => result.output.resultId === result.resultId && result.output.revision === result.revision, 'Result projection must identify its current revision')));
export type ScmDiffSummaryResult = z.infer<typeof ScmDiffSummaryResultSchema>;

/** A content-free persisted revision hint. The authorized result reader owns the actual state. */
export const SCM_DIFF_SUMMARY_RESULT_UPDATED_EVENT = 'scm-diff-summary-result-updated';
export const ScmDiffSummaryResultRevisionHintSchema = lazyZodSchema(() => z.strictObject({
  resultId: z.string().check(z.minLength(1)), revision: z.number().check(z.int(), z.nonnegative()),
}));
export type ScmDiffSummaryResultRevisionHint = z.infer<typeof ScmDiffSummaryResultRevisionHintSchema>;
export const ScmDiffSummaryMachineResultUpdateSchema = lazyZodSchema(() => z.strictObject({
  ...ScmDiffSummaryResultRevisionHintSchema.shape,
  machineId: z.string().check(z.minLength(1)), installationId: z.string().check(z.minLength(1)),
}));
export const ScmDiffSummaryResultUpdateEphemeralSchema = lazyZodSchema(() => z.strictObject({
  type: z.literal(SCM_DIFF_SUMMARY_RESULT_UPDATED_EVENT), machineId: z.string().check(z.minLength(1)),
  ...ScmDiffSummaryResultRevisionHintSchema.shape,
}));
export type ScmDiffSummaryResultUpdateEphemeral = z.infer<typeof ScmDiffSummaryResultUpdateEphemeralSchema>;

export const ScmDiffSummaryResultReadInputSchema = lazyZodSchema(() => z.strictObject({ cwd: z.string().check(z.minLength(1)), resultId: z.string().check(z.minLength(1)) }));
export type ScmDiffSummaryResultReadInput = z.infer<typeof ScmDiffSummaryResultReadInputSchema>;
export const ScmDiffSummaryResultRevisionInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmDiffSummaryResultReadInputSchema, {
  expectedRevision: z.number().check(z.int(), z.nonnegative()),
})));
export type ScmDiffSummaryResultRevisionInput = z.infer<typeof ScmDiffSummaryResultRevisionInputSchema>;

const ids = z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Ids must be unique'));
const commitGroupTarget = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('group'), groupId: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('newGroup'), group: z.strictObject({ id: z.string().check(z.minLength(1)),
    message: z.string().check(z.trim(), z.minLength(1)), rationale: z.string() }) }),
  z.strictObject({ kind: z.literal('leftOut') }),
]));
export const ScmDiffSummaryResultEditSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('renameWalkthrough'), title: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ kind: z.literal('renameStop'), stopId: z.string().check(z.minLength(1)), title: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ kind: z.literal('editStop'), stopId: z.string().check(z.minLength(1)), explanationMarkdown: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ kind: z.literal('reorderStops'), stopIds: ids }),
  z.strictObject({ kind: z.literal('mergeStops'), stopIds: ids, targetStopId: z.string().check(z.minLength(1)),
    title: z.optional(z.string().check(z.trim(), z.minLength(1))), explanationMarkdown: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ kind: z.literal('replaceSummary'), value: ScmDiffSummarySummarySchema }),
  z.strictObject({ kind: z.literal('replaceWalkthrough'), value: ScmDiffSummaryWalkthroughSchema }),
  z.strictObject({ kind: z.literal('replaceCommitPlan'), value: ScmDiffSummaryCommitPlanSchema }),
  z.strictObject({ kind: z.literal('editCommitGroup'), groupId: z.string().check(z.minLength(1)),
    message: z.optional(z.string().check(z.trim(), z.minLength(1))), rationale: z.optional(z.string()) }),
  z.strictObject({ kind: z.literal('reorderCommitGroups'), groupIds: ids }),
  z.strictObject({ kind: z.literal('mergeCommitGroups'), groupIds: ids, targetGroupId: z.string().check(z.minLength(1)),
    message: z.optional(z.string().check(z.trim(), z.minLength(1))), rationale: z.optional(z.string()) }),
  z.strictObject({ kind: z.literal('moveCommitChanges'), changeRefs: ids, target: commitGroupTarget }),
  /** Discards one output (for example a commit proposal) while the result keeps its others; Undo restores it. */
  z.strictObject({ kind: z.literal('removeOutput'), output: ScmDiffSummaryOutputKindSchema }),
]).check(z.refine((edit) => edit.kind !== 'editCommitGroup' || edit.message !== undefined || edit.rationale !== undefined, 'A commit group edit must change its message or rationale')));
export type ScmDiffSummaryResultEdit = z.infer<typeof ScmDiffSummaryResultEditSchema>;
export const ScmDiffSummaryResultEditInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmDiffSummaryResultRevisionInputSchema, { edit: ScmDiffSummaryResultEditSchema })));
export type ScmDiffSummaryResultEditInput = z.infer<typeof ScmDiffSummaryResultEditInputSchema>;
export const ScmDiffSummaryRefineInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmDiffSummaryResultRevisionInputSchema, {
  outputLanguage: z.optional(ScmDiffSummaryOutputLanguageSchema),
  output: ScmDiffSummaryOutputKindSchema, instructions: z.string().check(z.trim(), z.minLength(1)), stopIds: z.optional(ids),
  reviewExplanation: z.optional(z.strictObject({ targets: ScmReviewExplanationTargetsSchema })),
})).check(z.refine((value) => !value.stopIds || value.output === 'walkthrough', 'Stop targeting requires walkthrough output'), z.refine(value => !value.reviewExplanation || (value.output === 'walkthrough' && value.stopIds
    && value.stopIds.length === value.reviewExplanation.targets.length
    && value.reviewExplanation.targets.every(target => value.stopIds!.includes(target.stopId))), 'Finding explanations require exactly their selected walkthrough stops')));
export type ScmDiffSummaryRefineInput = z.infer<typeof ScmDiffSummaryRefineInputSchema>;
export const ScmDiffSummaryAddOutputsInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmDiffSummaryResultRevisionInputSchema, {
  outputLanguage: z.optional(ScmDiffSummaryOutputLanguageSchema),
  outputs: z.array(ScmDiffSummaryOutputKindSchema).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Outputs must be unique')),
})));
export type ScmDiffSummaryAddOutputsInput = z.infer<typeof ScmDiffSummaryAddOutputsInputSchema>;
export const ScmDiffSummaryDiscussInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmDiffSummaryResultRevisionInputSchema, {
  outputLanguage: z.optional(ScmDiffSummaryOutputLanguageSchema),
  message: z.string().check(z.trim(), z.minLength(1)), stopIds: z.optional(ids), startNew: z.optional(z.boolean()),
})));
export type ScmDiffSummaryDiscussInput = z.infer<typeof ScmDiffSummaryDiscussInputSchema>;

export const ScmDiffSummaryResultErrorCodeSchema = lazyZodSchema(() => z.enum([
  'result_not_found', 'revision_conflict', 'invalid_edit', 'invalid_output', 'nothing_to_undo',
  'discussion_unavailable', 'admission_failed', 'admission_unknown', 'result_unavailable',
  'application_locked', 'application_unavailable', 'source_not_pending', 'plan_unavailable',
  'acceptance_mismatch', 'backend_unsupported', 'source_changed', 'head_moved', 'selection_conflict',
  'invalid_parameters', ...SESSION_INPUT_ADMISSION_REJECTION_CODES_V1,
]));
export const ScmDiffSummaryResultFailureSchema = lazyZodSchema(() => z.strictObject({
  success: z.literal(false), errorCode: ScmDiffSummaryResultErrorCodeSchema,
  error: z.string().check(z.minLength(1)), latestRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type ScmDiffSummaryResultFailure = z.infer<typeof ScmDiffSummaryResultFailureSchema>;
export const ScmDiffSummaryResultResponseSchema = lazyZodSchema(() => z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), result: ScmDiffSummaryResultSchema,
    runId: z.optional(z.string().check(z.minLength(1))), seededFromRunId: z.optional(z.string().check(z.minLength(1))),
    inputId: z.optional(z.string().check(z.minLength(1))),
  }), ScmDiffSummaryResultFailureSchema,
]));
export type ScmDiffSummaryResultResponse = z.infer<typeof ScmDiffSummaryResultResponseSchema>;
export const ScmDiffSummaryResultDeleteResponseSchema = lazyZodSchema(() => z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), resultId: z.string().check(z.minLength(1)), comparisonId: z.string().check(z.minLength(1)),
  }),
  ScmDiffSummaryResultFailureSchema,
]));
export type ScmDiffSummaryResultDeleteResponse = z.infer<typeof ScmDiffSummaryResultDeleteResponseSchema>;

/** Machine-owned inventory references; source evidence remains in the saved result. */
export const ScmDiffSummarySavedResultReferenceSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmDiffSummaryResultRevisionInputSchema, {
  comparisonId: z.string().check(z.minLength(1)), sessionId: z.optional(z.string().check(z.minLength(1))),
})));
export type ScmDiffSummarySavedResultReference = z.infer<typeof ScmDiffSummarySavedResultReferenceSchema>;
export const ScmDiffSummarySavedResultItemSchema = lazyZodSchema(() => z.strictObject({
  cwd: z.string().check(z.minLength(1)), sessionId: z.optional(z.string().check(z.minLength(1))), resultId: z.string().check(z.minLength(1)),
  revision: z.number().check(z.int(), z.nonnegative()), comparisonId: z.string().check(z.minLength(1)),
  title: z.optional(z.string()), source: ScmDiffSummarySourceSchema, bytes: z.number().check(z.int(), z.nonnegative()),
  updatedAtMs: z.number().check(z.int(), z.nonnegative()),
}));
export type ScmDiffSummarySavedResultItem = z.infer<typeof ScmDiffSummarySavedResultItemSchema>;
export const ScmDiffSummarySevenDayCostSchema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['partial', 'unavailable']), estimatedUsd: z.optional(z.number().check(z.nonnegative())),
  pricedRunCount: z.number().check(z.int(), z.nonnegative()), unpricedRunCount: z.number().check(z.int(), z.nonnegative()),
  sinceMs: z.number().check(z.int(), z.nonnegative()), untilMs: z.number().check(z.int(), z.nonnegative()),
}));
export type ScmDiffSummarySevenDayCost = z.infer<typeof ScmDiffSummarySevenDayCostSchema>;
export const ScmDiffSummaryResultListInputSchema = lazyZodSchema(() => z.strictObject({
  query: z.optional(z.strictObject({ cwd: z.string().check(z.minLength(1)),
    // Null explicitly requests repository-owned results; omission leaves Session selection to ACLs.
    sessionId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
    comparisons: z.optional(z.array(z.strictObject({ source: ScmDiffSummarySourceSchema,
      comparisonId: z.optional(z.string().check(z.minLength(1))), outputs: z.array(ScmDiffSummaryOutputKindSchema).check(z.minLength(1)),
    }))),
  })),
  includeUsage: z.optional(z.boolean()),
}));
export type ScmDiffSummaryResultListInput = z.infer<typeof ScmDiffSummaryResultListInputSchema>;
export const ScmDiffSummaryResultListResponseSchema = lazyZodSchema(() => z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), results: z.array(ScmDiffSummarySavedResultItemSchema),
    count: z.number().check(z.int(), z.nonnegative()), bytes: z.number().check(z.int(), z.nonnegative()),
    sevenDayCost: z.optional(ScmDiffSummarySevenDayCostSchema),
  }), ScmDiffSummaryResultFailureSchema,
]));
export type ScmDiffSummaryResultListResponse = z.infer<typeof ScmDiffSummaryResultListResponseSchema>;
export const ScmDiffSummaryResultClearInputSchema = lazyZodSchema(() => z.strictObject({
  results: z.array(ScmDiffSummarySavedResultReferenceSchema).check(z.refine((values) => new Set(values.map(value => value.resultId)).size === values.length, 'Saved result identities must be unique')),
}));
export type ScmDiffSummaryResultClearInput = z.infer<typeof ScmDiffSummaryResultClearInputSchema>;
export const ScmDiffSummaryMarksCleanupFailureSchema = lazyZodSchema(() => z.strictObject({
  success: z.literal(false), errorCode: z.literal('reviewed_marks_cleanup_failed'), error: z.string().check(z.minLength(1)),
  resultId: z.string().check(z.minLength(1)), comparisonId: z.string().check(z.minLength(1)), resultDeleted: z.literal(true),
  retry: z.strictObject({ actionId: z.literal('scm.diffSummary.reviewed.unmark'), input: ScmReviewedMarksResetInputSchema }),
}));
export type ScmDiffSummaryMarksCleanupFailure = z.infer<typeof ScmDiffSummaryMarksCleanupFailureSchema>;
export const ScmDiffSummaryResultClearResponseSchema = lazyZodSchema(() => z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true),
    deleted: z.array(ScmDiffSummaryResultDeleteResponseSchema._zod.def.options[0]),
    failures: z.array(z.union([
      z.strictObject({ resultId: z.string().check(z.minLength(1)), ...ScmDiffSummaryResultFailureSchema.shape }),
      ScmDiffSummaryMarksCleanupFailureSchema,
    ])),
  }), ScmDiffSummaryResultFailureSchema,
]));
export type ScmDiffSummaryResultClearResponse = z.infer<typeof ScmDiffSummaryResultClearResponseSchema>;
