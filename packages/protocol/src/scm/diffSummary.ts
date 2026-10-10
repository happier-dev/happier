import { z } from 'zod';

import { lazyZodSchema } from '../lazyZodSchema.js';

import { ScmBackendPreferenceSchema } from './backendIdentity.js';
import { ScmComparisonSchema, ScmComparisonSourceSchema, type ScmComparison } from './comparison.js';
import { ReviewLaunchFailureSchema } from '../reviews/reviewLaunchFailure.js';
import { ReviewPublicationEvidenceSchema } from '../reviews/reviewPublicationEvidence.js';
export * from './comparison.js';
export * from './reviewedMarks.js';

export const ScmDiffSummarySourceKindSchema = lazyZodSchema(() => z.enum([
  'turnCheckpoint',
  'workingTree',
  'session', 'branch', 'commit', 'pullRequest',
]));
export type ScmDiffSummarySourceKind =
  z.infer<typeof ScmDiffSummarySourceKindSchema>;

export const ScmDiffSummarySourceSchema = ScmComparisonSourceSchema;
export type ScmDiffSummarySource =
  z.infer<typeof ScmDiffSummarySourceSchema>;

export const ScmDiffSummaryTurnEvidenceModeSchema = lazyZodSchema(() => z.enum([
  'reconciled',
  'agent_reported',
  'checkpoint',
]));
export type ScmDiffSummaryTurnEvidenceMode =
  z.infer<typeof ScmDiffSummaryTurnEvidenceModeSchema>;

export const ScmDiffSummaryModelSelectorSchema = lazyZodSchema(() => z
  .object({
    profileId: z.string().trim().min(1).optional(),
    modelId: z.string().trim().min(1).optional(),
    backendTargetKey: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.profileId || value.modelId || value.backendTargetKey),
    { message: 'modelSelector requires profileId, modelId, or backendTargetKey' },
  ));
export type ScmDiffSummaryModelSelector =
  z.infer<typeof ScmDiffSummaryModelSelectorSchema>;

export const SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION = 1;

export const ScmDiffSummaryResolvedSelectorSchema = lazyZodSchema(() => z.object({
  catalogId: z.string().trim().min(1),
}).strict());
export type ScmDiffSummaryResolvedSelector =
  z.infer<typeof ScmDiffSummaryResolvedSelectorSchema>;

export const ScmDiffSummaryCachePolicySchema = lazyZodSchema(() => z.object({
  mode: z.enum(['read_write', 'bypass']),
  reason: z.string().min(1).optional(),
}).strict());
export type ScmDiffSummaryCachePolicy =
  z.infer<typeof ScmDiffSummaryCachePolicySchema>;

// Retain concrete identity for shared Control input JSON Schema references.
export const ScmDiffSummaryGenerateInputSchema = lazyZodSchema(() => z
  .object({
    cwd: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    comparisonId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    backendPreference: ScmBackendPreferenceSchema.optional(),
    source: ScmDiffSummarySourceSchema,
    turnId: z.string().min(1).optional(),
    checkpointReceiptId: z.string().min(1).optional(),
    turnEvidenceMode: ScmDiffSummaryTurnEvidenceModeSchema.optional(),
    modelSelector: ScmDiffSummaryModelSelectorSchema.optional(),
    cachePolicy: ScmDiffSummaryCachePolicySchema.optional(),
    outputs: z.array(z.enum(['summary', 'walkthrough', 'commitPlan'])).min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.source.kind === 'turnCheckpoint') {
      for (const [key, sourceValue, requestValue] of [
        ['turnId', value.source.turnId, value.turnId],
        ['checkpointReceiptId', value.source.checkpointReceiptId, value.checkpointReceiptId],
        ['turnEvidenceMode', value.source.evidenceMode, value.turnEvidenceMode],
        ['sessionId', value.source.sessionId, value.sessionId],
      ] as const) {
        if (sourceValue !== undefined && requestValue !== undefined && sourceValue !== requestValue) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Selectors must identify one captured source' });
        }
      }
    }
    if (value.source.kind === 'session' && value.sessionId && value.source.sessionId !== value.sessionId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sessionId'], message: 'Selectors must identify one session' });
    }
    if (
      value.source.kind === 'turnCheckpoint' &&
      !value.turnId && !value.source.turnId &&
      !value.checkpointReceiptId && !value.source.checkpointReceiptId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'turnCheckpoint comparisons require a turn or checkpoint receipt selector resolved by the host',
        path: ['checkpointReceiptId'],
      });
    }
    if (value.outputs?.includes('commitPlan') && value.source.kind !== 'workingTree') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputs'], message: 'Commit plans require a pending working-tree comparison' });
    }
    if (value.outputs && new Set(value.outputs).size !== value.outputs.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputs'], message: 'Requested outputs must be unique' });
    }
    if (value.source.kind === 'workingTree' && value.checkpointReceiptId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'workingTree summaries must not carry a checkpointReceiptId; use turnCheckpoint source for receipt-keyed cache lookup',
        path: ['checkpointReceiptId'],
      });
    }
  }));
export type ScmDiffSummaryGenerateInput =
  z.infer<typeof ScmDiffSummaryGenerateInputSchema>;

/** Capture current evidence, or read an exact retained comparison without model admission. */
// Retain concrete identity for shared Control input JSON Schema references.
export const ScmComparisonCaptureInputSchema = lazyZodSchema(() => z.object({
  cwd: z.string().min(1), sessionId: z.string().min(1).optional(),
  comparisonId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  backendPreference: ScmBackendPreferenceSchema.optional(), source: ScmDiffSummarySourceSchema,
  turnId: z.string().min(1).optional(), checkpointReceiptId: z.string().min(1).optional(),
  turnEvidenceMode: ScmDiffSummaryTurnEvidenceModeSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const { comparisonId: _comparisonId, ...selectors } = value;
  const parsed = ScmDiffSummaryGenerateInputSchema.safeParse(selectors);
  if (!parsed.success) for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: issue.path });
  }
}));
export type ScmComparisonCaptureInput = z.infer<typeof ScmComparisonCaptureInputSchema>;

export const ScmDiffSummaryTruncationReasonSchema = lazyZodSchema(() => z.enum([
  'fileBudget',
  'diffBytes',
  'fileCount',
]));
export type ScmDiffSummaryTruncationReason =
  z.infer<typeof ScmDiffSummaryTruncationReasonSchema>;

export const ScmDiffSummaryTruncationSchema = lazyZodSchema(() => z.object({
  reason: ScmDiffSummaryTruncationReasonSchema,
  droppedFiles: z.number().int().nonnegative().optional(),
}).passthrough());
export type ScmDiffSummaryTruncation =
  z.infer<typeof ScmDiffSummaryTruncationSchema>;

export const ScmDiffSummaryGenerationStateSchema = lazyZodSchema(() => z.enum([
  'complete',
  'partial',
]));
export type ScmDiffSummaryGenerationState =
  z.infer<typeof ScmDiffSummaryGenerationStateSchema>;

export const ScmDiffSummaryCostMetadataSchema = lazyZodSchema(() => z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  estimatedUsd: z.number().nonnegative().optional(),
}).passthrough());
export type ScmDiffSummaryCostMetadata =
  z.infer<typeof ScmDiffSummaryCostMetadataSchema>;

export const ScmDiffSummaryMetadataSchema = lazyZodSchema(() => z.object({
  source: ScmDiffSummarySourceSchema,
  sourceKey: z.string().min(1),
  turnId: z.string().min(1).optional(),
  checkpointReceiptId: z.string().min(1).optional(),
  turnEvidenceMode: ScmDiffSummaryTurnEvidenceModeSchema.optional(),
  contentConfidence: z.enum(['exact', 'unavailable']).optional(),
  attributionScope: z.enum([
    'no_happier_checkpoint_overlap_observed',
    'shared_worktree',
    'unknown',
  ]).optional(),
}).strict());
export type ScmDiffSummaryMetadata =
  z.infer<typeof ScmDiffSummaryMetadataSchema>;

export const ScmDiffSummaryErrorCodeSchema = lazyZodSchema(() => z.enum([
  'TURN_CHANGE_SET_REQUIRED',
  'CHECKPOINT_NOT_FOUND',
  'CHECKPOINT_UNAVAILABLE',
  'DIFF_UNAVAILABLE',
  'MODEL_UNAVAILABLE',
  'SUMMARY_FAILED',
]));
export type ScmDiffSummaryErrorCode =
  z.infer<typeof ScmDiffSummaryErrorCodeSchema>;

export const ScmDiffSummaryOutputKindSchema = lazyZodSchema(() => z.enum(['summary', 'walkthrough', 'commitPlan']));
export type ScmDiffSummaryOutputKind = z.infer<typeof ScmDiffSummaryOutputKindSchema>;
export const ScmDiffSummaryOutputStateSchema = lazyZodSchema(() => z.enum(['pending', 'writing', 'complete', 'partial', 'failed', 'cancelled']));
export type ScmDiffSummaryOutputState = z.infer<typeof ScmDiffSummaryOutputStateSchema>;

export const ScmDiffSummarySummarySchema = lazyZodSchema(() => z.object({
  summaryMarkdown: z.string().trim().min(1), risks: z.array(z.string().trim().min(1)).optional(),
  testImpact: z.string().trim().min(1).optional(), suggestedPrBody: z.string().trim().min(1).optional(),
}).strict());
export const ScmReviewFindingIdentitySchema = lazyZodSchema(() => z.object({ runId: z.string().min(1), findingId: z.string().min(1) }).strict());
export const ScmReviewExplanationRequesterSchema = lazyZodSchema(() => z.object({
  kind: z.enum(['user', 'agent', 'plugin', 'automation', 'workflow', 'unknown']), id: z.string().min(1).optional(),
}).strict());
export type ScmReviewExplanationRequester = z.infer<typeof ScmReviewExplanationRequesterSchema>;
// Retain concrete identity for shared Control target JSON Schema references.
export const ScmReviewExplanationTargetsSchema = lazyZodSchema(() => z.array(z.object({
  stopId: z.string().min(1), findingRefs: z.array(ScmReviewFindingIdentitySchema).min(1),
}).strict()).min(1).refine(targets => new Set(targets.map(target => target.stopId)).size === targets.length, 'Explanation stop ids must be unique'));
export const ScmReviewExplanationSchema = lazyZodSchema(() => z.object({
  markdown: z.string().trim().min(1), findingRefs: z.array(ScmReviewFindingIdentitySchema).min(1),
  provenance: z.object({ requestedBy: ScmReviewExplanationRequesterSchema,
    requestedAtMs: z.number().int().nonnegative(), generatedAtMs: z.number().int().nonnegative(),
    modelId: z.string().min(1).optional(), runId: z.string().min(1).optional(),
  }).strict(),
}).strict());
export const ScmDiffSummaryWalkthroughSchema = lazyZodSchema(() => z.object({
  title: z.string().trim().min(1), intro: z.string(),
  stops: z.array(z.object({
    id: z.string().min(1), title: z.string().trim().min(1), explanationMarkdown: z.string().trim().min(1),
    changeRefs: z.array(z.string().min(1)), importance: z.enum(['low', 'medium', 'high']).optional(),
    findingRefs: z.array(z.string().min(1)).optional(),
    reviewExplanations: z.array(ScmReviewExplanationSchema).min(1).optional(),
  }).strict()),
  readingHint: z.string().optional(), otherChangeRefs: z.array(z.string().min(1)),
}).strict());
export type ScmDiffSummaryWalkthrough = z.infer<typeof ScmDiffSummaryWalkthroughSchema>;
export const ScmDiffSummaryCommitPlanSchema = lazyZodSchema(() => z.object({
  groups: z.array(z.object({
    id: z.string().min(1), message: z.string().trim().min(1), rationale: z.string(),
    changeRefs: z.array(z.string().min(1)),
  }).strict()), leftOutChangeRefs: z.array(z.string().min(1)),
}).strict());
export type ScmDiffSummaryCommitPlan = z.infer<typeof ScmDiffSummaryCommitPlanSchema>;

export const ScmDiffSummaryModelOutputSchema = lazyZodSchema(() => ScmDiffSummarySummarySchema.partial().extend({
  walkthrough: ScmDiffSummaryWalkthroughSchema.optional(), commitPlan: ScmDiffSummaryCommitPlanSchema.optional(),
  reviewExplanations: z.array(z.object({ stopId: z.string().min(1), markdown: z.string().trim().min(1) }).strict()).min(1).optional(),
}).strict().refine((value) => Boolean(value.summaryMarkdown || value.walkthrough || value.commitPlan || value.reviewExplanations), 'A structured output is required'));
export type ScmDiffSummaryModelOutput = z.infer<typeof ScmDiffSummaryModelOutputSchema>;

function progress<T extends z.ZodType>(value: T) {
  return z.object({ state: ScmDiffSummaryOutputStateSchema, value: value.optional(), reason: z.string().min(1).optional() }).strict()
    .refine((output) => output.state !== 'complete' || output.value !== undefined, 'Complete output requires a value');
}
export const ScmDiffSummaryOutputsSchema = lazyZodSchema(() => z.object({
  summary: progress(ScmDiffSummarySummarySchema).optional(),
  walkthrough: progress(ScmDiffSummaryWalkthroughSchema).optional(),
  commitPlan: progress(ScmDiffSummaryCommitPlanSchema).optional(),
}).strict());
export type ScmDiffSummaryOutputs = z.infer<typeof ScmDiffSummaryOutputsSchema>;
export const ScmDiffSummaryAnalysisCoverageSchema = lazyZodSchema(() => z.object({
  suppliedChangeRefs: z.array(z.string().min(1)), analysedChangeRefs: z.array(z.string().min(1)),
  remainingChangeRefs: z.array(z.string().min(1)),
  parts: z.object({ admitted: z.number().int().nonnegative(), completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(), phase: z.enum(['evidence', 'merge', 'done']),
  }).strict().optional(),
}).strict());
export type ScmDiffSummaryAnalysisCoverage = z.infer<typeof ScmDiffSummaryAnalysisCoverageSchema>;

/** Provenance is host-authored. Finding identities always include their owning Run. */
export const ScmDiffSummaryReviewRunSchema = lazyZodSchema(() => z.object({
  ...ReviewPublicationEvidenceSchema.shape,
  runId: z.string().min(1), callId: z.string().min(1), backendId: z.string().min(1),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'timeout']),
  hasOutput: z.boolean(), comparisonId: z.string().min(1).optional(),
  reviewOutcome: z.enum(['complete', 'partial', 'failed', 'unavailable']).optional(),
}).strict());
export type ScmDiffSummaryReviewRun = z.infer<typeof ScmDiffSummaryReviewRunSchema>;
export const ScmDiffSummaryReviewProvenanceSchema = lazyZodSchema(() => z.object({
  reviewedRuns: z.array(ScmDiffSummaryReviewRunSchema).min(1),
  narrationMode: z.enum(['continued_review', 'seeded_narrator']),
  comparisonFreshness: z.enum(['unchanged', 'changed', 'unknown']),
  launchFailures: z.array(ReviewLaunchFailureSchema).optional(),
}).strict());
export type ScmDiffSummaryReviewProvenance = z.infer<typeof ScmDiffSummaryReviewProvenanceSchema>;

const envelope = {
  comparison: ScmComparisonSchema.optional(), requestedOutputs: z.array(ScmDiffSummaryOutputKindSchema).min(1).optional(),
  outputs: ScmDiffSummaryOutputsSchema.optional(), analysis: ScmDiffSummaryAnalysisCoverageSchema.optional(),
  runId: z.string().min(1).optional(), resultId: z.string().min(1).optional(), revision: z.number().int().nonnegative().optional(),
  producer: z.object({ kind: z.enum(['generation', 'review']), modelId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(), seededFromRunId: z.string().min(1).optional(),
    reviewedBy: z.array(z.string().min(1)).optional(),
    reviewedRuns: z.array(ScmDiffSummaryReviewRunSchema).optional(),
    narrationMode: z.enum(['continued_review', 'seeded_narrator']).optional(),
    comparisonFreshness: z.enum(['unchanged', 'changed', 'unknown']).optional(),
    narratedAtMs: z.number().int().nonnegative().optional(),
    launchFailures: z.array(ReviewLaunchFailureSchema).optional(),
  }).strict().optional(),
};

/** Resolve model aliases only against captured evidence; prose never supplies authority. */
export function normalizeScmDiffSummaryModelOutput(value: unknown, params: Readonly<{
  comparison: ScmComparison; requestedOutputs?: readonly ScmDiffSummaryOutputKind[]; requireCompleteCoverage?: boolean;
  allowHostReviewExplanations?: boolean;
  allowReviewExplanation?: boolean;
  referenceMode?: 'aliases' | 'canonical';
}>): ScmDiffSummaryModelOutput {
  const output = ScmDiffSummaryModelOutputSchema.parse(value);
  if (!params.allowHostReviewExplanations && output.walkthrough?.stops.some(stop => stop.reviewExplanations)) {
    throw new Error('Models cannot supply explanation provenance');
  }
  if (output.reviewExplanations) {
    if (!params.allowReviewExplanation || Object.keys(output).length !== 1) throw new Error('Finding explanations require an admitted explanation request and separate output');
    return output;
  }
  const comparison = ScmComparisonSchema.parse(params.comparison);
  const occurrences = comparison.inventory.files.flatMap((file) => file.occurrences);
  const refs = new Map(occurrences.map((occurrence) => [params.referenceMode === 'canonical' ? occurrence.id : occurrence.alias, occurrence.id]));
  const allowed = params.requestedOutputs ?? ['summary', 'walkthrough', 'commitPlan'];
  const carriesSummary = output.summaryMarkdown !== undefined || output.risks !== undefined
    || output.testImpact !== undefined || output.suggestedPrBody !== undefined;
  if ((carriesSummary && !allowed.includes('summary')) || (output.walkthrough && !allowed.includes('walkthrough')) || (output.commitPlan && !allowed.includes('commitPlan'))) {
    throw new Error('Unrequested output cannot be published');
  }
  function resolveGroup(groups: readonly (readonly string[])[]) {
    const used = new Set<string>();
    const resolved = groups.map((group) => group.map((ref) => {
      const id = refs.get(ref);
      if (!id) throw new Error(`Unknown comparison change reference: ${ref}`);
      if (used.has(id)) throw new Error(`Duplicate comparison change reference: ${ref}`);
      used.add(id);
      return id;
    }));
    if (params.requireCompleteCoverage && used.size !== occurrences.length) throw new Error('Unassigned comparison changes must remain explicitly reachable');
    return resolved;
  }
  function uniqueIds(ids: readonly string[]) {
    if (new Set(ids).size !== ids.length) throw new Error('Result-local ids must be unique');
  }
  if (output.walkthrough) {
    uniqueIds(output.walkthrough.stops.map((stop) => stop.id));
    const resolved = resolveGroup([...output.walkthrough.stops.map((stop) => stop.changeRefs), output.walkthrough.otherChangeRefs]);
    output.walkthrough = { ...output.walkthrough, stops: output.walkthrough.stops.map((stop, index) => ({ ...stop, changeRefs: resolved[index] })), otherChangeRefs: resolved[resolved.length - 1] };
  }
  if (output.commitPlan) {
    if (comparison.source.kind !== 'workingTree') throw new Error('Historical comparisons cannot authorize commit proposals');
    uniqueIds(output.commitPlan.groups.map((group) => group.id));
    const resolved = resolveGroup([...output.commitPlan.groups.map((group) => group.changeRefs), output.commitPlan.leftOutChangeRefs]);
    output.commitPlan = { ...output.commitPlan, groups: output.commitPlan.groups.map((group, index) => ({ ...group, changeRefs: resolved[index] })), leftOutChangeRefs: resolved[resolved.length - 1] };
  }
  return output;
}

export const ScmDiffSummaryGenerateSuccessSchema = lazyZodSchema(() => z.object({
  success: z.literal(true),
  /** Actual authored initial Run input, for exact lifecycle observation. */
  inputId: z.string().min(1).optional(),
  summaryMarkdown: z.string().min(1).optional(),
  sourceKey: z.string().min(1),
  checkpointReceiptId: z.string().min(1).optional(),
  metadata: ScmDiffSummaryMetadataSchema,
  truncation: ScmDiffSummaryTruncationSchema.optional(),
  generationState: ScmDiffSummaryGenerationStateSchema.optional(),
  cost: ScmDiffSummaryCostMetadataSchema.optional(),
  risks: z.array(z.string().min(1)).optional(),
  testImpact: z.string().min(1).optional(),
  suggestedPrBody: z.string().min(1).optional(),
  ...envelope,
}).strict().refine((value) => Boolean(value.summaryMarkdown || value.comparison), 'A comparison or summary is required'));
export type ScmDiffSummaryGenerateSuccess =
  z.infer<typeof ScmDiffSummaryGenerateSuccessSchema>;

export const ScmDiffSummaryGenerateFailureSchema = lazyZodSchema(() => z.object({
  success: z.literal(false),
  error: z.string().min(1),
  errorCode: ScmDiffSummaryErrorCodeSchema,
  sourceKey: z.string().min(1).optional(),
  checkpointReceiptId: z.string().min(1).optional(),
  metadata: ScmDiffSummaryMetadataSchema.optional(),
  cost: ScmDiffSummaryCostMetadataSchema.optional(),
  ...envelope,
}).strict());
export type ScmDiffSummaryGenerateFailure =
  z.infer<typeof ScmDiffSummaryGenerateFailureSchema>;

export const ScmDiffSummaryGenerateOutputSchema = lazyZodSchema(() => z.union([
  ScmDiffSummaryGenerateSuccessSchema,
  ScmDiffSummaryGenerateFailureSchema,
]).superRefine((value, ctx) => {
  if (!value.comparison) return;
  const issue = (path: string[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (value.sourceKey !== value.comparison.id) issue(['sourceKey'], 'Source key must identify the captured comparison');
  if (value.metadata && value.metadata.sourceKey !== value.comparison.id) issue(['metadata', 'sourceKey'], 'Metadata must identify the captured comparison');
  if (value.metadata && JSON.stringify(value.metadata.source) !== JSON.stringify(value.comparison.source)) issue(['metadata', 'source'], 'Metadata must describe the captured source');
  const requested = value.requestedOutputs ?? [];
  if (!requested.length || new Set(requested).size !== requested.length) issue(['requestedOutputs'], 'Captured results require unique requested outputs');
  for (const kind of ['summary', 'walkthrough', 'commitPlan'] as const) {
    if (Boolean(value.outputs?.[kind]) !== requested.includes(kind)) issue(['outputs', kind], 'Only requested outputs must carry progress');
  }
  const known = new Set(value.comparison.inventory.files.flatMap((file) => file.occurrences.map((occurrence) => occurrence.id)));
  if (!value.analysis) issue(['analysis'], 'Captured results require explicit analysis coverage');
  if (value.analysis) {
    for (const key of ['suppliedChangeRefs', 'analysedChangeRefs', 'remainingChangeRefs'] as const) {
      const refs = value.analysis[key];
      if (new Set(refs).size !== refs.length || refs.some((ref) => !known.has(ref))) issue(['analysis', key], 'Coverage must contain unique captured occurrence identities');
    }
    const supplied = new Set(value.analysis.suppliedChangeRefs);
    const analysed = new Set(value.analysis.analysedChangeRefs);
    const remaining = new Set(value.analysis.remainingChangeRefs);
    if ([...analysed].some((ref) => !supplied.has(ref))) issue(['analysis', 'analysedChangeRefs'], 'Analysis cannot cover unsupplied evidence');
    if ([...known].some((ref) => remaining.has(ref) === analysed.has(ref))) issue(['analysis', 'remainingChangeRefs'], 'Remaining coverage must identify every unanalysed occurrence');
  }
  for (const kind of ['walkthrough', 'commitPlan'] as const) {
    const progress = value.outputs?.[kind];
    if (!progress?.value) continue;
    const publishedRefs = kind === 'walkthrough'
      ? [value.outputs?.walkthrough?.value?.stops.flatMap((stop) => stop.changeRefs) ?? [], value.outputs?.walkthrough?.value?.otherChangeRefs ?? []].flat()
      : [value.outputs?.commitPlan?.value?.groups.flatMap((group) => group.changeRefs) ?? [], value.outputs?.commitPlan?.value?.leftOutChangeRefs ?? []].flat();
    if (publishedRefs.some((ref) => !known.has(ref))) issue(['outputs', kind, 'value'], 'Published outputs require canonical occurrence identities, not model aliases');
    try {
      normalizeScmDiffSummaryModelOutput({ [kind]: progress.value }, {
        referenceMode: 'canonical',
        allowHostReviewExplanations: true,
        comparison: value.comparison, requestedOutputs: [kind], requireCompleteCoverage: progress.state === 'complete',
      });
    } catch (error) {
      issue(['outputs', kind, 'value'], error instanceof Error ? error.message : 'Invalid captured occurrence references');
    }
  }
}));
export type ScmDiffSummaryGenerateOutput =
  z.infer<typeof ScmDiffSummaryGenerateOutputSchema>;

export const ScmComparisonCaptureOutputSchema = lazyZodSchema(() => z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), comparison: ScmComparisonSchema, metadata: ScmDiffSummaryMetadataSchema }).strict(),
  z.object({ success: z.literal(false), error: z.string().min(1), errorCode: ScmDiffSummaryErrorCodeSchema }).strict(),
]));
export type ScmComparisonCaptureOutput = z.infer<typeof ScmComparisonCaptureOutputSchema>;

export const ScmDiffSummaryCacheKeyDescriptorSchema = lazyZodSchema(() => z
  .object({
    source: ScmDiffSummarySourceSchema,
    checkpointReceiptId: z.string().trim().min(1).optional(),
    checkpointRef: z.string().trim().min(1).optional(),
    volatileSourceVersion: z.string().trim().min(1).optional(),
    comparisonId: z.string().trim().min(1).optional(),
    outputs: z.array(ScmDiffSummaryOutputKindSchema).min(1).optional(),
    turnEvidenceMode: ScmDiffSummaryTurnEvidenceModeSchema.optional(),
    summarySchemaVersion: z.number().int().positive(),
    resolvedSelector: ScmDiffSummaryResolvedSelectorSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.source.kind !== 'turnCheckpoint' && value.source.kind !== 'workingTree' && !value.comparisonId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparisonId'], message: 'Historical sources require a captured comparison identity' });
    }
    if (value.source.kind === 'turnCheckpoint') {
      if (!value.checkpointReceiptId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checkpointReceiptId'],
          message: 'turnCheckpoint cache descriptors require checkpointReceiptId',
        });
      }
      if (!value.checkpointRef) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checkpointRef'],
          message: 'turnCheckpoint cache descriptors require checkpointRef',
        });
      }
      if (value.volatileSourceVersion) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['volatileSourceVersion'],
          message: 'turnCheckpoint cache descriptors must not use volatileSourceVersion',
        });
      }
    }

    if (value.source.kind === 'workingTree') {
      if (!value.volatileSourceVersion) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['volatileSourceVersion'],
          message: 'workingTree cache descriptors require volatileSourceVersion',
        });
      }
      if (value.checkpointReceiptId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checkpointReceiptId'],
          message: 'workingTree cache descriptors must not use checkpointReceiptId',
        });
      }
    }
  }));
export type ScmDiffSummaryCacheKeyDescriptor =
  z.infer<typeof ScmDiffSummaryCacheKeyDescriptorSchema>;

export const ScmDiffSummaryCacheEntrySchema = lazyZodSchema(() => z.object({
  key: ScmDiffSummaryCacheKeyDescriptorSchema,
  checkpointRef: z.string().min(1).optional(),
  value: ScmDiffSummaryGenerateOutputSchema,
  createdAtMs: z.number().int().nonnegative().optional(),
  updatedAtMs: z.number().int().nonnegative().optional(),
}).passthrough());
export type ScmDiffSummaryCacheEntry =
  z.infer<typeof ScmDiffSummaryCacheEntrySchema>;

export type ScmDiffSummaryCacheSource =
  | Readonly<{ kind: 'turnCheckpoint'; checkpointReceiptId: string; checkpointRef: string; turnEvidenceMode?: string }>
  | Readonly<{ kind: 'workingTree'; volatileSourceVersion: string }>
  | Readonly<{ kind: 'comparison'; comparisonId: string }>;
export type ScmDiffSummaryResolvedSelectorInput = Readonly<{ catalogId?: string; label?: string }>;
export type ScmDiffSummaryCacheKeyInput = Readonly<{
  source: ScmDiffSummaryCacheSource; summarySchemaVersion: number;
  resolvedSelector: ScmDiffSummaryResolvedSelectorInput;
  outputs?: readonly ScmDiffSummaryOutputKind[];
  scopeKey?: string;
  volatileDiffDigest?: string;
}>;

export function buildScmDiffSummaryCacheKey(input: ScmDiffSummaryCacheKeyInput): string {
  function part(value: string | undefined, field: string) {
    const normalized = value?.trim();
    if (!normalized) throw new Error(`${field} is required`);
    return encodeURIComponent(normalized);
  }
  if (!Number.isInteger(input.summarySchemaVersion) || input.summarySchemaVersion <= 0) throw new Error('summarySchemaVersion must be a positive integer');
  const selector = part(input.resolvedSelector.catalogId, 'resolved catalog id');
  const suffix = `schema:${input.summarySchemaVersion}:selector:${selector}`;
  const outputs = [...new Set(input.outputs ?? ['summary'])].sort();
  if (!outputs.length || outputs.some((output) => !ScmDiffSummaryOutputKindSchema.safeParse(output).success)) throw new Error('Requested output kinds are invalid');
  const outputSuffix = outputs.length === 1 && outputs[0] === 'summary' ? '' : `:outputs:${outputs.join(',')}`;
  const scopeSuffix = input.scopeKey ? `:scope:${part(input.scopeKey, 'scopeKey')}` : '';
  switch (input.source.kind) {
    case 'turnCheckpoint': return `checkpoint:${part(input.source.checkpointRef, 'checkpointRef')}:receipt:${part(input.source.checkpointReceiptId, 'checkpointReceiptId')}:evidence:${part(input.source.turnEvidenceMode ?? 'reconciled', 'turnEvidenceMode')}:${suffix}${outputSuffix}${scopeSuffix}`;
    case 'workingTree': return `volatile-working-tree:${part(input.source.volatileSourceVersion, 'volatileSourceVersion')}:${suffix}${outputSuffix}${scopeSuffix}`;
    case 'comparison': return `comparison:${part(input.source.comparisonId, 'comparisonId')}:${suffix}${outputSuffix}${scopeSuffix}`;
  }
}

export function isDurableScmDiffSummaryCacheKey(key: string): boolean {
  return key.startsWith('checkpoint:') || key.startsWith('comparison:');
}
