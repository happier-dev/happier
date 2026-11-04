import { z } from 'zod/mini';

import { lazyZodSchema } from '../lazyZodSchema.js';

import { ScmBackendPreferenceSchema } from './backendIdentity.js';
import { ScmComparisonSchema, ScmComparisonSourceSchema, type ScmComparison } from './comparison.js';
import { ReviewLaunchFailureSchema } from '../reviews/reviewLaunchFailure.js';
import { ReviewPublicationEvidenceSchema } from '../reviews/reviewPublicationEvidence.js';
import { ExecutionRunTransportErrorCodeSchema } from '../execution/runs/runPrimitives.js';
import { AGENT_START_REFUSAL_CODES_V1 } from '../account/settings/admitAgentStartV1.js';
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

export const ScmDiffSummaryModelSelectorSchema = lazyZodSchema(() => z.strictObject({
    profileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    modelId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    backendTargetKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }).check(z.refine((value) => Boolean(value.profileId || value.modelId || value.backendTargetKey), { message: 'modelSelector requires profileId, modelId, or backendTargetKey' })));
export type ScmDiffSummaryModelSelector =
  z.infer<typeof ScmDiffSummaryModelSelectorSchema>;

export const SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION = 1;

export const ScmDiffSummaryResolvedSelectorSchema = lazyZodSchema(() => z.strictObject({
  catalogId: z.string().check(z.trim(), z.minLength(1)),
}));
export type ScmDiffSummaryResolvedSelector =
  z.infer<typeof ScmDiffSummaryResolvedSelectorSchema>;

export const ScmDiffSummaryCachePolicySchema = lazyZodSchema(() => z.strictObject({
  mode: z.enum(['read_write', 'bypass']),
  reason: z.optional(z.string().check(z.minLength(1))),
}));
export type ScmDiffSummaryCachePolicy =
  z.infer<typeof ScmDiffSummaryCachePolicySchema>;

/** A language tag controls prose only; it never supplies prompt instructions. */
export const ScmDiffSummaryOutputLanguageSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.refine(value => {
  try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; }
}, 'Expected a language tag')));

// Retain concrete identity for shared Control input JSON Schema references.
export const ScmDiffSummaryGenerateInputSchema = lazyZodSchema(() => z.strictObject({
    cwd: z.string().check(z.minLength(1)),
    sessionId: z.optional(z.string().check(z.minLength(1))),
    comparisonId: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))),
    backendPreference: z.optional(ScmBackendPreferenceSchema),
    source: ScmDiffSummarySourceSchema,
    turnId: z.optional(z.string().check(z.minLength(1))),
    checkpointReceiptId: z.optional(z.string().check(z.minLength(1))),
    turnEvidenceMode: z.optional(ScmDiffSummaryTurnEvidenceModeSchema),
    modelSelector: z.optional(ScmDiffSummaryModelSelectorSchema),
    cachePolicy: z.optional(ScmDiffSummaryCachePolicySchema),
    investigateSurroundingFiles: z.optional(z.boolean()),
    outputLanguage: z.optional(ScmDiffSummaryOutputLanguageSchema),
    /** The host supplies template and Session evidence; callers never submit test claims. */
    pullRequestDraft: z.optional(z.strictObject({ providerId: z.optional(z.string().check(z.minLength(1))) })),
    outputs: z.optional(z.array(z.enum(['summary', 'walkthrough', 'commitPlan'])).check(z.minLength(1))),
  }).check(z.superRefine((value, ctx) => {
    if (value.source.kind === 'turnCheckpoint') {
      for (const [key, sourceValue, requestValue] of [
        ['turnId', value.source.turnId, value.turnId],
        ['checkpointReceiptId', value.source.checkpointReceiptId, value.checkpointReceiptId],
        ['turnEvidenceMode', value.source.evidenceMode, value.turnEvidenceMode],
        ['sessionId', value.source.sessionId, value.sessionId],
      ] as const) {
        if (sourceValue !== undefined && requestValue !== undefined && sourceValue !== requestValue) {
          ctx.addIssue({ code: "custom", path: [key], message: 'Selectors must identify one captured source' });
        }
      }
    }
    if (value.source.kind === 'session' && value.sessionId && value.source.sessionId !== value.sessionId) {
      ctx.addIssue({ code: "custom", path: ['sessionId'], message: 'Selectors must identify one session' });
    }
    if (
      value.source.kind === 'turnCheckpoint' &&
      !value.turnId && !value.source.turnId &&
      !value.checkpointReceiptId && !value.source.checkpointReceiptId
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          'turnCheckpoint comparisons require a turn or checkpoint receipt selector resolved by the host',
        path: ['checkpointReceiptId'],
      });
    }
    if (value.outputs?.includes('commitPlan') && value.source.kind !== 'workingTree') {
      ctx.addIssue({ code: "custom", path: ['outputs'], message: 'Commit plans require a pending working-tree comparison' });
    }
    if (value.outputs && new Set(value.outputs).size !== value.outputs.length) {
      ctx.addIssue({ code: "custom", path: ['outputs'], message: 'Requested outputs must be unique' });
    }
    if (value.source.kind === 'workingTree' && value.checkpointReceiptId) {
      ctx.addIssue({
        code: "custom",
        message:
          'workingTree summaries must not carry a checkpointReceiptId; use turnCheckpoint source for receipt-keyed cache lookup',
        path: ['checkpointReceiptId'],
      });
    }
  })));
export type ScmDiffSummaryGenerateInput =
  z.infer<typeof ScmDiffSummaryGenerateInputSchema>;

/** Capture current evidence, or read an exact retained comparison without model admission. */
// Retain concrete identity for shared Control input JSON Schema references.
export const ScmComparisonCaptureInputSchema = lazyZodSchema(() => z.strictObject({
  cwd: z.string().check(z.minLength(1)), sessionId: z.optional(z.string().check(z.minLength(1))),
  comparisonId: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))),
  projection: z.optional(z.strictObject({ kind: z.literal('index'),
    cursor: z.optional(z.number().check(z.int(), z.nonnegative())),
    path: z.optional(z.string().check(z.minLength(1))),
  })),
  backendPreference: z.optional(ScmBackendPreferenceSchema), source: ScmDiffSummarySourceSchema,
  turnId: z.optional(z.string().check(z.minLength(1))), checkpointReceiptId: z.optional(z.string().check(z.minLength(1))),
  turnEvidenceMode: z.optional(ScmDiffSummaryTurnEvidenceModeSchema),
}).check(z.superRefine((value, ctx) => {
  const { comparisonId: _comparisonId, projection: _projection, ...selectors } = value;
  const parsed = ScmDiffSummaryGenerateInputSchema.safeParse(selectors);
  if (!parsed.success) for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
})));
export type ScmComparisonCaptureInput = z.infer<typeof ScmComparisonCaptureInputSchema>;

export const ScmDiffSummaryTruncationReasonSchema = lazyZodSchema(() => z.enum([
  'fileBudget',
  'diffBytes',
  'fileCount',
]));
export type ScmDiffSummaryTruncationReason =
  z.infer<typeof ScmDiffSummaryTruncationReasonSchema>;

export const ScmDiffSummaryTruncationSchema = lazyZodSchema(() => z.looseObject({
  reason: ScmDiffSummaryTruncationReasonSchema,
  droppedFiles: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type ScmDiffSummaryTruncation =
  z.infer<typeof ScmDiffSummaryTruncationSchema>;

export const ScmDiffSummaryGenerationStateSchema = lazyZodSchema(() => z.enum([
  'complete',
  'partial',
]));
export type ScmDiffSummaryGenerationState =
  z.infer<typeof ScmDiffSummaryGenerationStateSchema>;

export const ScmDiffSummaryCostMetadataSchema = lazyZodSchema(() => z.looseObject({
  inputTokens: z.optional(z.number().check(z.int(), z.nonnegative())),
  outputTokens: z.optional(z.number().check(z.int(), z.nonnegative())),
  estimatedUsd: z.optional(z.number().check(z.nonnegative())),
}));
export type ScmDiffSummaryCostMetadata =
  z.infer<typeof ScmDiffSummaryCostMetadataSchema>;

export const ScmDiffSummaryMetadataSchema = lazyZodSchema(() => z.strictObject({
  source: ScmDiffSummarySourceSchema,
  sourceKey: z.string().check(z.minLength(1)),
  turnId: z.optional(z.string().check(z.minLength(1))),
  checkpointReceiptId: z.optional(z.string().check(z.minLength(1))),
  turnEvidenceMode: z.optional(ScmDiffSummaryTurnEvidenceModeSchema),
  contentConfidence: z.optional(z.enum(['exact', 'unavailable'])),
  attributionScope: z.optional(z.enum([
    'no_happier_checkpoint_overlap_observed',
    'shared_worktree',
    'unknown',
  ])),
}));
export type ScmDiffSummaryMetadata =
  z.infer<typeof ScmDiffSummaryMetadataSchema>;

export const ScmDiffSummaryErrorCodeSchema = lazyZodSchema(() => z.enum([
  'SCM_DIFF_SUMMARY_DISABLED',
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

export const ScmDiffSummarySummarySchema = lazyZodSchema(() => z.strictObject({
  summaryMarkdown: z.string().check(z.trim(), z.minLength(1)), risks: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  testImpact: z.optional(z.string().check(z.trim(), z.minLength(1))), suggestedPrBody: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export const ScmReviewFindingIdentitySchema = lazyZodSchema(() => z.strictObject({ runId: z.string().check(z.minLength(1)), findingId: z.string().check(z.minLength(1)) }));
export const ScmReviewExplanationRequesterSchema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['user', 'agent', 'plugin', 'automation', 'workflow', 'unknown']), id: z.optional(z.string().check(z.minLength(1))),
}));
export type ScmReviewExplanationRequester = z.infer<typeof ScmReviewExplanationRequesterSchema>;
// Retain concrete identity for shared Control target JSON Schema references.
export const ScmReviewExplanationTargetsSchema = lazyZodSchema(() => z.array(z.strictObject({
  stopId: z.string().check(z.minLength(1)), findingRefs: z.array(ScmReviewFindingIdentitySchema).check(z.minLength(1)),
})).check(z.minLength(1), z.refine(targets => new Set(targets.map(target => target.stopId)).size === targets.length, 'Explanation stop ids must be unique')));
export const ScmReviewExplanationSchema = lazyZodSchema(() => z.strictObject({
  markdown: z.string().check(z.trim(), z.minLength(1)), findingRefs: z.array(ScmReviewFindingIdentitySchema).check(z.minLength(1)),
  provenance: z.strictObject({ requestedBy: ScmReviewExplanationRequesterSchema,
    requestedAtMs: z.number().check(z.int(), z.nonnegative()), generatedAtMs: z.number().check(z.int(), z.nonnegative()),
    modelId: z.optional(z.string().check(z.minLength(1))), runId: z.optional(z.string().check(z.minLength(1))),
  }),
}));
export const ScmDiffSummaryWalkthroughSchema = lazyZodSchema(() => z.strictObject({
  title: z.string().check(z.trim(), z.minLength(1)), intro: z.string(),
  stops: z.array(z.strictObject({
    id: z.string().check(z.minLength(1)), title: z.string().check(z.trim(), z.minLength(1)), explanationMarkdown: z.string().check(z.trim(), z.minLength(1)),
    changeRefs: z.array(z.string().check(z.minLength(1))), importance: z.optional(z.enum(['low', 'medium', 'high'])),
    findingRefs: z.optional(z.array(z.string().check(z.minLength(1)))),
    suggestedQuestions: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
    reviewExplanations: z.optional(z.array(ScmReviewExplanationSchema).check(z.minLength(1))),
  })),
  readingHint: z.optional(z.string()), otherChangeRefs: z.array(z.string().check(z.minLength(1))),
}));
export type ScmDiffSummaryWalkthrough = z.infer<typeof ScmDiffSummaryWalkthroughSchema>;
export const ScmDiffSummaryCommitPlanSchema = lazyZodSchema(() => z.strictObject({
  groups: z.array(z.strictObject({
    id: z.string().check(z.minLength(1)), message: z.string().check(z.trim(), z.minLength(1)), rationale: z.string(),
    changeRefs: z.array(z.string().check(z.minLength(1))),
  })), leftOutChangeRefs: z.array(z.string().check(z.minLength(1))),
}));
export type ScmDiffSummaryCommitPlan = z.infer<typeof ScmDiffSummaryCommitPlanSchema>;

export const ScmDiffSummaryModelOutputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.partial(ScmDiffSummarySummarySchema), {
  walkthrough: z.optional(ScmDiffSummaryWalkthroughSchema), commitPlan: z.optional(ScmDiffSummaryCommitPlanSchema),
  reviewExplanations: z.optional(z.array(z.strictObject({ stopId: z.string().check(z.minLength(1)), markdown: z.string().check(z.trim(), z.minLength(1)) })).check(z.minLength(1))),
})).check(z.refine((value) => Boolean(value.summaryMarkdown || value.walkthrough || value.commitPlan || value.reviewExplanations), 'A structured output is required')));
export type ScmDiffSummaryModelOutput = z.infer<typeof ScmDiffSummaryModelOutputSchema>;

export const ScmDiffSummaryFailureReasonCodeSchema = lazyZodSchema(() => z.union([
  ExecutionRunTransportErrorCodeSchema,
  z.enum(AGENT_START_REFUSAL_CODES_V1),
  z.enum(['generation_cancelled', 'RPC_CLIENT_NOT_AVAILABLE', 'DIFF_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'SUMMARY_FAILED',
    'action_failed', 'approval_required']),
]));

function progress<T extends z.ZodMiniType>(value: T) {
  return z.strictObject({ state: ScmDiffSummaryOutputStateSchema, value: z.optional(value),
    reason: z.optional(z.string().check(z.minLength(1))), reasonCode: z.optional(ScmDiffSummaryFailureReasonCodeSchema),
  }).check(z.refine((output) => output.state !== 'complete' || output.value !== undefined, 'Complete output requires a value'));
}
export const ScmDiffSummaryOutputsSchema = lazyZodSchema(() => z.strictObject({
  summary: z.optional(progress(ScmDiffSummarySummarySchema)),
  walkthrough: z.optional(progress(ScmDiffSummaryWalkthroughSchema)),
  commitPlan: z.optional(progress(ScmDiffSummaryCommitPlanSchema)),
}));
export type ScmDiffSummaryOutputs = z.infer<typeof ScmDiffSummaryOutputsSchema>;
export const ScmDiffSummaryAnalysisCoverageSchema = lazyZodSchema(() => z.strictObject({
  suppliedChangeRefs: z.array(z.string().check(z.minLength(1))), analysedChangeRefs: z.array(z.string().check(z.minLength(1))),
  remainingChangeRefs: z.array(z.string().check(z.minLength(1))),
  parts: z.optional(z.strictObject({ admitted: z.number().check(z.int(), z.nonnegative()), completed: z.number().check(z.int(), z.nonnegative()),
    total: z.number().check(z.int(), z.nonnegative()), phase: z.enum(['evidence', 'merge', 'done']),
  })),
}));
export type ScmDiffSummaryAnalysisCoverage = z.infer<typeof ScmDiffSummaryAnalysisCoverageSchema>;

/** Provenance is host-authored. Finding identities always include their owning Run. */
export const ScmDiffSummaryReviewRunSchema = lazyZodSchema(() => z.strictObject({
  ...ReviewPublicationEvidenceSchema.shape,
  runId: z.string().check(z.minLength(1)), callId: z.string().check(z.minLength(1)), backendId: z.string().check(z.minLength(1)),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'timeout']),
  hasOutput: z.boolean(), comparisonId: z.optional(z.string().check(z.minLength(1))),
  reviewOutcome: z.optional(z.enum(['complete', 'partial', 'failed', 'unavailable'])),
}));
export type ScmDiffSummaryReviewRun = z.infer<typeof ScmDiffSummaryReviewRunSchema>;
export const ScmDiffSummaryReviewProvenanceSchema = lazyZodSchema(() => z.strictObject({
  reviewedRuns: z.array(ScmDiffSummaryReviewRunSchema).check(z.minLength(1)),
  narrationMode: z.enum(['continued_review', 'seeded_narrator']),
  comparisonFreshness: z.enum(['unchanged', 'changed', 'unknown']),
  launchFailures: z.optional(z.array(ReviewLaunchFailureSchema)),
}));
export type ScmDiffSummaryReviewProvenance = z.infer<typeof ScmDiffSummaryReviewProvenanceSchema>;

const envelope = {
  /** Start may still arrive. This observation never fails or advances the saved output revision. */
  admission: z.optional(z.literal('outcomeUnknown')),
  comparison: z.optional(ScmComparisonSchema), requestedOutputs: z.optional(z.array(ScmDiffSummaryOutputKindSchema).check(z.minLength(1))),
  outputs: z.optional(ScmDiffSummaryOutputsSchema), analysis: z.optional(ScmDiffSummaryAnalysisCoverageSchema),
  runId: z.optional(z.string().check(z.minLength(1))), resultId: z.optional(z.string().check(z.minLength(1))), revision: z.optional(z.number().check(z.int(), z.nonnegative())),
  producer: z.optional(z.strictObject({ kind: z.enum(['generation', 'review']), modelId: z.optional(z.string().check(z.minLength(1))),
    runId: z.optional(z.string().check(z.minLength(1))), seededFromRunId: z.optional(z.string().check(z.minLength(1))),
    reviewedBy: z.optional(z.array(z.string().check(z.minLength(1)))),
    reviewedRuns: z.optional(z.array(ScmDiffSummaryReviewRunSchema)),
    narrationMode: z.optional(z.enum(['continued_review', 'seeded_narrator'])),
    comparisonFreshness: z.optional(z.enum(['unchanged', 'changed', 'unknown'])),
    narratedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    launchFailures: z.optional(z.array(ReviewLaunchFailureSchema)),
  })),
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
  function resolveGroup(groups: readonly (readonly string[])[], keepUnassignedInOtherChanges = false) {
    const used = new Set<string>();
    const resolved = groups.map((group) => group.map((ref) => {
      const id = refs.get(ref);
      if (!id) throw new Error(`Unknown comparison change reference: ${ref}`);
      if (used.has(id)) throw new Error(`Duplicate comparison change reference: ${ref}`);
      used.add(id);
      return id;
    }));
    if (params.requireCompleteCoverage && used.size !== occurrences.length) {
      if (!keepUnassignedInOtherChanges) throw new Error('Unassigned comparison changes must remain explicitly reachable');
      // The host keeps captured changes outside the model's story reachable;
      // this disposition does not establish analysis or personal review coverage.
      resolved[resolved.length - 1].push(...occurrences.filter(occurrence => !used.has(occurrence.id)).map(occurrence => occurrence.id));
    }
    return resolved;
  }
  function uniqueIds(ids: readonly string[]) {
    if (new Set(ids).size !== ids.length) throw new Error('Result-local ids must be unique');
  }
  if (output.walkthrough) {
    uniqueIds(output.walkthrough.stops.map((stop) => stop.id));
    const resolved = resolveGroup([...output.walkthrough.stops.map((stop) => stop.changeRefs), output.walkthrough.otherChangeRefs],
      params.referenceMode !== 'canonical');
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

export const ScmDiffSummaryGenerateSuccessSchema = lazyZodSchema(() => z.strictObject({
  success: z.literal(true),
  /** Actual authored initial Run input, for exact lifecycle observation. */
  inputId: z.optional(z.string().check(z.minLength(1))),
  summaryMarkdown: z.optional(z.string().check(z.minLength(1))),
  sourceKey: z.string().check(z.minLength(1)),
  checkpointReceiptId: z.optional(z.string().check(z.minLength(1))),
  metadata: ScmDiffSummaryMetadataSchema,
  truncation: z.optional(ScmDiffSummaryTruncationSchema),
  generationState: z.optional(ScmDiffSummaryGenerationStateSchema),
  cost: z.optional(ScmDiffSummaryCostMetadataSchema),
  risks: z.optional(z.array(z.string().check(z.minLength(1)))),
  testImpact: z.optional(z.string().check(z.minLength(1))),
  suggestedPrBody: z.optional(z.string().check(z.minLength(1))),
  ...envelope,
}).check(z.refine((value) => Boolean(value.summaryMarkdown || value.comparison), 'A comparison or summary is required')));
export type ScmDiffSummaryGenerateSuccess =
  z.infer<typeof ScmDiffSummaryGenerateSuccessSchema>;

export const ScmDiffSummaryGenerateFailureSchema = lazyZodSchema(() => z.strictObject({
  success: z.literal(false),
  error: z.string().check(z.minLength(1)),
  errorCode: ScmDiffSummaryErrorCodeSchema,
  nextAction: z.optional(z.literal('chooseModel')),
  sourceKey: z.optional(z.string().check(z.minLength(1))),
  checkpointReceiptId: z.optional(z.string().check(z.minLength(1))),
  metadata: z.optional(ScmDiffSummaryMetadataSchema),
  cost: z.optional(ScmDiffSummaryCostMetadataSchema),
  ...envelope,
}));
export type ScmDiffSummaryGenerateFailure =
  z.infer<typeof ScmDiffSummaryGenerateFailureSchema>;

export const ScmDiffSummaryGenerateOutputSchema = lazyZodSchema(() => z.union([
  ScmDiffSummaryGenerateSuccessSchema,
  ScmDiffSummaryGenerateFailureSchema,
]).check(z.superRefine((value, ctx) => {
  if (!value.comparison) return;
  const issue = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message });
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
})));
export type ScmDiffSummaryGenerateOutput =
  z.infer<typeof ScmDiffSummaryGenerateOutputSchema>;

export const ScmComparisonCaptureOutputSchema = lazyZodSchema(() => z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), comparison: ScmComparisonSchema, metadata: ScmDiffSummaryMetadataSchema,
    /** Page coverage is distinct from the captured source inventory's coverage. */
    page: z.optional(z.strictObject({ totalFiles: z.number().check(z.int(), z.nonnegative()),
      nextCursor: z.nullable(z.number().check(z.int(), z.nonnegative())) })),
  }),
  z.strictObject({ success: z.literal(false), error: z.string().check(z.minLength(1)), errorCode: ScmDiffSummaryErrorCodeSchema }),
]));
export type ScmComparisonCaptureOutput = z.infer<typeof ScmComparisonCaptureOutputSchema>;

export const ScmDiffSummaryCacheKeyDescriptorSchema = lazyZodSchema(() => z.strictObject({
    source: ScmDiffSummarySourceSchema,
    checkpointReceiptId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    checkpointRef: z.optional(z.string().check(z.trim(), z.minLength(1))),
    volatileSourceVersion: z.optional(z.string().check(z.trim(), z.minLength(1))),
    comparisonId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    outputs: z.optional(z.array(ScmDiffSummaryOutputKindSchema).check(z.minLength(1))),
    outputLanguage: z.optional(ScmDiffSummaryOutputLanguageSchema),
    turnEvidenceMode: z.optional(ScmDiffSummaryTurnEvidenceModeSchema),
    investigateSurroundingFiles: z.optional(z.boolean()),
    summarySchemaVersion: z.number().check(z.int(), z.positive()),
    resolvedSelector: ScmDiffSummaryResolvedSelectorSchema,
  }).check(z.superRefine((value, ctx) => {
    if (value.source.kind !== 'turnCheckpoint' && value.source.kind !== 'workingTree' && !value.comparisonId) {
      ctx.addIssue({ code: "custom", path: ['comparisonId'], message: 'Historical sources require a captured comparison identity' });
    }
    if (value.source.kind === 'turnCheckpoint') {
      if (!value.checkpointReceiptId) {
        ctx.addIssue({
          code: "custom",
          path: ['checkpointReceiptId'],
          message: 'turnCheckpoint cache descriptors require checkpointReceiptId',
        });
      }
      if (!value.checkpointRef) {
        ctx.addIssue({
          code: "custom",
          path: ['checkpointRef'],
          message: 'turnCheckpoint cache descriptors require checkpointRef',
        });
      }
      if (value.volatileSourceVersion) {
        ctx.addIssue({
          code: "custom",
          path: ['volatileSourceVersion'],
          message: 'turnCheckpoint cache descriptors must not use volatileSourceVersion',
        });
      }
    }

    if (value.source.kind === 'workingTree') {
      if (!value.volatileSourceVersion) {
        ctx.addIssue({
          code: "custom",
          path: ['volatileSourceVersion'],
          message: 'workingTree cache descriptors require volatileSourceVersion',
        });
      }
      if (value.checkpointReceiptId) {
        ctx.addIssue({
          code: "custom",
          path: ['checkpointReceiptId'],
          message: 'workingTree cache descriptors must not use checkpointReceiptId',
        });
      }
    }
  })));
export type ScmDiffSummaryCacheKeyDescriptor =
  z.infer<typeof ScmDiffSummaryCacheKeyDescriptorSchema>;

export const ScmDiffSummaryCacheEntrySchema = lazyZodSchema(() => z.looseObject({
  key: ScmDiffSummaryCacheKeyDescriptorSchema,
  checkpointRef: z.optional(z.string().check(z.minLength(1))),
  value: ScmDiffSummaryGenerateOutputSchema,
  createdAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  updatedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
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
  outputLanguage?: string;
  scopeKey?: string;
  investigateSurroundingFiles?: boolean;
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
  const suffix = `schema:${input.summarySchemaVersion}:selector:${selector}`
    + (input.outputLanguage ? `:language:${part(ScmDiffSummaryOutputLanguageSchema.parse(input.outputLanguage), 'outputLanguage')}` : '')
    + (input.investigateSurroundingFiles === true ? ':investigation:surrounding-files' : '');
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
