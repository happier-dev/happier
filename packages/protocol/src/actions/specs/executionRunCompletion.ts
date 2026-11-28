import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

import type { ActionCompletionDeclaration, ExecutionRunCompletionDeclaration, ActionCompletionRun, ExecutionRunTerminalObservation, ExecutionRunTerminalObservationWithTiming } from '../actionCompletion.js';
import { readExecutionRunStartRunCreation } from '../../execution/runs/responseSchemas.js';
import { ScmDiffSummaryGenerateOutputSchema } from '../../scm/diffSummary.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { ReviewWalkthroughObservationSchema } from '../../reviews/reviewNarration.js';
import { ReviewPublicationEvidenceSchema, ReviewReviewerOutcomeV1Schema } from '../../reviews/reviewPublicationEvidence.js';
import { ReviewRoundBindingV1Schema, type ReviewRoundBindingV1 } from '../../reviews/reviewArtifactV1.js';
import { reviewReviewerIdsForStartV1, type ReviewStartInput } from '../../reviews/reviewStart.js';
import { parseWorkflowRunStartActionResultReferenceV1, type WorkflowRunActionResultReferenceV1 } from '../../workflows/actionsV1.js';
import { ActionExecuteResultSchema, parseActionExecuteFailure } from '../actionExecutionResult.js';
import { readRecord } from '../../inputs/inputRecords.js';

import { SessionRuntimeIssueV1Schema } from '../../sessions/control/runtimeIssueV1.js';
import { projectSessionRuntimeIssueMetadataV1 } from '../../sessions/control/runtimeIssueMetadataV1.js';

// Retained immediate output is a compatibility seam: additional owner fields survive,
// but the launched run identity and the Action's intent must remain explicit.
const FanoutOutputSchema = lazyZodSchema(() => z.looseObject({
  intent: z.enum(['review', 'plan', 'delegate']),
  sessionId: z.nullable(z.string()),
  reviewedFingerprint: z.optional(z.nullable(z.string())),
  reviewRound: z.optional(ReviewRoundBindingV1Schema),
  results: z.array(z.discriminatedUnion('ok', [
    z.looseObject({ key: z.string().check(z.minLength(1)), ok: z.literal(true), result: z.looseObject({ runId: z.string().check(z.minLength(1)) }) }),
    z.looseObject({ key: z.string().check(z.minLength(1)), ok: z.literal(false), errorCode: z.optional(z.string().check(z.minLength(1))),
      error: ReviewReviewerOutcomeV1Schema.shape.error, requestId: ReviewReviewerOutcomeV1Schema.shape.requestId,
      failureCause: ReviewReviewerOutcomeV1Schema.shape.failureCause, details: ReviewReviewerOutcomeV1Schema.shape.details,
      effectAttempted: ReviewReviewerOutcomeV1Schema.shape.effectAttempted }),
  ])),
}));

type FanoutIntent = z.infer<typeof FanoutOutputSchema>['intent'];

function readFanoutOutput(output: unknown, intent: FanoutIntent) {
  const parsed = FanoutOutputSchema.parse(output);
  if (parsed.intent !== intent) throw new Error('Retained Action intent changed');
  return parsed;
}

function readLaunches(output: unknown, intent: FanoutIntent) {
  return projectFanoutLaunches(readFanoutOutput(output, intent));
}

function projectFanoutLaunches(parsed: z.infer<typeof FanoutOutputSchema>) {
  return {
    runs: parsed.results.flatMap((item) => item.ok ? [{ key: item.key, runId: item.result.runId }] : []),
    failed: parsed.results.flatMap((item) => item.ok ? [] : [{
      key: item.key, errorCode: item.errorCode ?? item.error ?? 'execution_run_failed',
      runCreation: readExecutionRunStartRunCreation(item.details),
    }]),
  };
}

export type ReviewStartActionResultV1 =
  | Readonly<{ kind: 'native'; runs: readonly Readonly<{ key: string; runId: string }>[];
    failed: readonly Readonly<{ key: string; errorCode: string; runCreation: 'noRunCreated' }>[];
    reviewRound?: ReviewRoundBindingV1; reviewedFingerprint?: string | null }>
  | Readonly<{ kind: 'workflow'; workflow: WorkflowRunActionResultReferenceV1; reviewRound?: ReviewRoundBindingV1 }>
  | Readonly<{ kind: 'outcome_unknown' }>;

/** Unwrap Review metadata before validating the ordinary Workflow admission receipt. */
export function readReviewWorkflowStartActionResultV1(value: unknown): Readonly<{
  workflow: WorkflowRunActionResultReferenceV1;
  reviewRound?: ReviewRoundBindingV1;
}> | null {
  const envelope = ActionExecuteResultSchema.safeParse(value);
  const output = envelope.success ? envelope.data.ok ? envelope.data.result : undefined : value;
  const { reviewRound, reviewTarget: _reviewTarget, ...start } = readRecord(output);
  const workflow = parseWorkflowRunStartActionResultReferenceV1(start);
  if (!workflow) return null;
  if (reviewRound === undefined) return { workflow };
  const binding = ReviewRoundBindingV1Schema.safeParse(reviewRound);
  return binding.success ? { workflow, reviewRound: binding.data } : null;
}

/** Reads current authoring receipts against their exact selected reviewer identities.
 * Unknown effects are never proof that a start can be retried. Workflow admission
 * identifies only the accepted Workflow, not launches of its executable leaves.
 */
export function readReviewStartActionResultV1(value: unknown,
  selection: Pick<ReviewStartInput, 'reviewers' | 'steps'>): ReviewStartActionResultV1 {
  try {
    const workflow = readReviewWorkflowStartActionResultV1(value);
    if (workflow) return { kind: 'workflow', ...workflow };
    const envelope = ActionExecuteResultSchema.safeParse(value);
    const output = envelope.success ? envelope.data.ok ? envelope.data.result : undefined : value;
    const retained = readFanoutOutput(output, 'review');
    const launches = projectFanoutLaunches(retained);
    const remaining = new Set(reviewReviewerIdsForStartV1(selection));
    for (const launch of [...launches.runs, ...launches.failed]) {
      if (!remaining.delete(launch.key)) return { kind: 'outcome_unknown' };
    }
    if (remaining.size > 0) return { kind: 'outcome_unknown' };
    const failed: { key: string; errorCode: string; runCreation: 'noRunCreated' }[] = [];
    for (const failure of launches.failed) {
      if (failure.runCreation !== 'noRunCreated') return { kind: 'outcome_unknown' };
      failed.push({ ...failure, runCreation: failure.runCreation });
    }
    return { kind: 'native', runs: launches.runs, failed,
      ...(retained.reviewRound ? { reviewRound: retained.reviewRound } : {}),
      ...(retained.reviewedFingerprint === undefined ? {} : { reviewedFingerprint: retained.reviewedFingerprint }) };
  } catch {
    return { kind: 'outcome_unknown' };
  }
}

type ObservedRun = Readonly<ActionCompletionRun & { outcome: ExecutionRunTerminalObservationWithTiming }>;
function perRunOutcome({ key, runId, outcome }: ObservedRun) {
  return {
    key, runId, outcome: outcome.kind, ...runTiming(outcome),
    ...(outcome.questionSummary ? { questionSummary: outcome.questionSummary } : {}),
    ...(outcome.kind === 'failed' && outcome.runtimeIssueV1 ? { runtimeIssueV1: projectSessionRuntimeIssueMetadataV1(outcome.runtimeIssueV1) } : {}),
    ...(outcome.kind !== 'completed' && outcome.code ? { errorCode: outcome.code } : {}),
  };
}

function runTiming(outcome: ExecutionRunTerminalObservationWithTiming) {
  return { ...(outcome.startedAt === undefined ? {} : { startedAt: outcome.startedAt }),
    ...(outcome.finishedAt === undefined ? {} : { finishedAt: outcome.finishedAt }) };
}

function launchFailureOutcomes(output: unknown, intent: FanoutIntent) {
  // Launch identities are scheduling facts; terminal evidence consumes the full
  // retained producer receipt rather than that deliberately narrow projection.
  return readFanoutOutput(output, intent).results.flatMap(item => item.ok ? [] : [{
    key: item.key, errorCode: item.errorCode ?? item.error ?? 'execution_run_failed', outcome: 'launch_failed' as const,
    ...(item.error === undefined ? {} : { error: item.error }),
    ...(item.requestId === undefined ? {} : { requestId: item.requestId }),
    ...(item.failureCause === undefined ? {} : { failureCause: item.failureCause }),
    ...(item.details === undefined ? {} : { details: item.details }),
    ...(item.effectAttempted === undefined ? {} : { effectAttempted: item.effectAttempted }),
  }]);
}

const NarrationTerminalValueSchema = lazyZodSchema(() => z.strictObject({ runId: z.optional(z.string().check(z.minLength(1))),
  outcome: z.enum(['completed', 'failed', 'cancelled', 'launch_failed']),
  outputState: z.optional(z.enum(['complete', 'partial', 'failed', 'cancelled'])),
  runtimeIssueV1: z.optional(SessionRuntimeIssueV1Schema),
  error: ReviewReviewerOutcomeV1Schema.shape.error, requestId: ReviewReviewerOutcomeV1Schema.shape.requestId,
  failureCause: ReviewReviewerOutcomeV1Schema.shape.failureCause, details: ReviewReviewerOutcomeV1Schema.shape.details,
  effectAttempted: ReviewReviewerOutcomeV1Schema.shape.effectAttempted,
  errorCode: z.optional(z.string().check(z.minLength(1))), result: z.optional(StrictJsonValueSchema),
}));

const NarrationLaunchSchema = lazyZodSchema(() => z.looseObject({ runId: z.string().check(z.minLength(1)), comparisonId: z.string().check(z.minLength(1)),
  observation: z.optional(ReviewWalkthroughObservationSchema),
}).check(z.refine((launch) => !launch.observation || launch.observation.comparisonId === launch.comparisonId, 'Narrator observation must bind the launched comparison')));

function narrationTerminalValue(run: ObservedRun, purpose: 'input' | 'stored') {
  if (run.outcome.kind === 'outcome_uncertain') throw new Error('Unsettled narration');
  const output = run.outcome.kind === 'completed' ? (purpose === 'stored'
    ? createStoredReadSchema(ScmDiffSummaryGenerateOutputSchema)
    : ScmDiffSummaryGenerateOutputSchema).safeParse(run.outcome.result) : undefined;
  const outputState = output?.success ? output.data.outputs?.walkthrough?.state : undefined;
  return { runId: run.runId, outcome: run.outcome.kind,
    ...(run.outcome.kind === 'failed' && run.outcome.runtimeIssueV1 ? { runtimeIssueV1: projectSessionRuntimeIssueMetadataV1(run.outcome.runtimeIssueV1) } : {}),
    ...(outputState && outputState !== 'pending' && outputState !== 'writing' ? { outputState } : {}),
    ...(run.outcome.kind === 'completed' ? { result: run.outcome.result }
      : run.outcome.code ? { errorCode: run.outcome.code } : {}),
  };
}

function narrationLaunchFailure(value: unknown) {
  const retained = readRecord(value);
  const failure = parseActionExecuteFailure({ ...retained, ok: false,
    errorCode: retained.errorCode ?? 'review_narration_failed',
    error: retained.error ?? retained.errorCode ?? 'review_narration_failed' });
  return { outcome: 'launch_failed' as const, errorCode: failure?.errorCode ?? 'review_narration_failed',
    ...(failure?.error === undefined ? {} : { error: failure.error }),
    ...(failure?.requestId === undefined ? {} : { requestId: failure.requestId }),
    ...(failure?.failureCause === undefined ? {} : { failureCause: failure.failureCause }),
    ...(failure?.details === undefined ? {} : { details: failure.details }),
    ...(failure?.effectAttempted === undefined ? {} : { effectAttempted: failure.effectAttempted }),
  };
}

export const ReviewStartTerminalValueV1Schema = lazyZodSchema(() => z.strictObject({
  reviewRound: z.optional(ReviewRoundBindingV1Schema),
  reviewedFingerprint: z.nullable(z.string()),
  commentIds: z.array(z.string().check(z.minLength(1))),
  perEngineOutcome: z.array(ReviewReviewerOutcomeV1Schema),
  narration: z.optional(NarrationTerminalValueSchema),
}));
export const ReviewStartNativeTerminalValueV1Schema = ReviewStartTerminalValueV1Schema;

export const reviewWalkthroughCompletion: ActionCompletionDeclaration = {
  awaits: 'execution_runs',
  terminalOutputSchema: z.strictObject({ narration: NarrationTerminalValueSchema }),
  launched: (output, purpose = 'input') => {
    const launch = (purpose === 'stored' ? createStoredReadSchema(NarrationLaunchSchema) : NarrationLaunchSchema).parse(output);
    return { runs: [{ key: 'narrator', runId: launch.runId,
      observation: launch.observation ?? { kind: 'review_walkthrough', comparisonId: launch.comparisonId } }], failed: [] };
  },
  terminal: (_output, runs, purpose = 'input') => {
    if (runs.length !== 1) throw new Error('Narrator identity changed');
    return { narration: narrationTerminalValue(runs[0]!, purpose) };
  },
};

export const reviewStartExecutionRunCompletion: ExecutionRunCompletionDeclaration = {
  awaits: 'execution_runs',
  terminalOutputSchema: ReviewStartTerminalValueV1Schema,
  launched: (output, purpose = 'input') => {
    const launches = readLaunches(output, 'review');
    const retained = readFanoutOutput(output, 'review');
    const parsedNarration = (purpose === 'stored' ? createStoredReadSchema(NarrationLaunchSchema) : NarrationLaunchSchema)
      .safeParse(retained.narration);
    if (!parsedNarration.success) return launches;
    const narration = parsedNarration.data;
    const observation = narration.observation ?? { kind: 'review_walkthrough' as const, comparisonId: narration.comparisonId };
    const existing = launches.runs.some((run) => run.runId === narration.runId);
    return { ...launches, runs: existing
      ? launches.runs.map((run) => run.runId === narration.runId ? { ...run, observation } : run)
      : [...launches.runs, { key: 'narrator', runId: narration.runId, observation }] };
  },
  terminal: (output, runs, purpose = 'input') => {
    const retained = readFanoutOutput(output, 'review');
    const originalLaunches = readLaunches(output, 'review');
    const narrationRun = runs.find((run) => run.observation);
    const narrated = narrationRun?.outcome.kind === 'completed'
      ? (purpose === 'stored' ? createStoredReadSchema(ScmDiffSummaryGenerateOutputSchema) : ScmDiffSummaryGenerateOutputSchema)
        .safeParse(narrationRun.outcome.result) : undefined;
    const reviewedRuns = narrated?.success ? narrated.data.producer?.reviewedRuns
      : narrationRun?.outcome.kind === 'failed' || narrationRun?.outcome.kind === 'cancelled'
        ? narrationRun.outcome.reviewedRuns : undefined;
    const reviewRuns = runs.filter((run) => originalLaunches.runs.some((original) => original.runId === run.runId && original.key === run.key))
      .map((run): ObservedRun => {
        if (!run.observation) return run;
        const provenance = reviewedRuns?.find((review) => review.runId === run.runId);
        const evidence = provenance ? (purpose === 'stored'
          ? createStoredReadSchema(ReviewPublicationEvidenceSchema) : ReviewPublicationEvidenceSchema).parse(provenance) : undefined;
        // Narration success alone never certifies findings or materialized comments.
        const outcome: ExecutionRunTerminalObservation = provenance?.hasOutput
          && (provenance.reviewOutcome === 'complete' || provenance.reviewOutcome === 'partial')
          ? { kind: 'completed', result: {}, ...evidence, reviewedFingerprint: evidence?.reviewedFingerprint ?? null }
          : provenance?.status === 'cancelled' ? { kind: 'cancelled' }
            : { kind: 'failed', code: provenance?.reviewOutcome === 'failed' ? 'review_failed' : 'review_output_unavailable' };
        return { ...run, outcome: { ...outcome, ...runTiming(run.outcome) } };
      });
    const completed = reviewRuns.flatMap(({ outcome }) => outcome.kind === 'completed' ? [outcome] : []);
    const fingerprints = completed.map((outcome) => outcome.reviewedFingerprint === undefined
      ? retained.reviewedFingerprint : outcome.reviewedFingerprint);
    const agreed = fingerprints[0];
    const reviewedFingerprint = retained.reviewedFingerprint !== null && typeof agreed === 'string' && agreed.length > 0
      && completed.length === reviewRuns.length && launchFailureOutcomes(output, 'review').length === 0
      && fingerprints.every((fingerprint) => fingerprint === agreed)
      && (retained.reviewedFingerprint === undefined || retained.reviewedFingerprint === agreed)
      ? agreed : null;
    return {
      ...(retained.reviewRound ? { reviewRound: retained.reviewRound } : {}),
      reviewedFingerprint,
      // Only the host bridge's materialized ids count; raw findings are not proof of writes.
      commentIds: [...new Set(completed.flatMap((outcome) => outcome.commentIds ?? []))],
      perEngineOutcome: [
        ...reviewRuns.map((run) => {
          const reviewOutcome = run.observation
            ? reviewedRuns?.find((review) => review.runId === run.runId)?.reviewOutcome ?? 'unavailable'
            : run.outcome.kind === 'completed' ? run.outcome.reviewOutcome : undefined;
          return {
            ...perRunOutcome(run),
            ...(run.outcome.kind === 'failed' && run.outcome.inputDispatch === 'not_attempted'
              ? { outcome: 'launch_failed' as const } : {}),
            ...(reviewOutcome ? { reviewOutcome } : {}),
            ...(run.outcome.kind === 'completed' ? {
              ...(run.outcome.quality ? { quality: run.outcome.quality } : {}),
              materialization: run.outcome.materialization && run.outcome.commentIds
                ? run.outcome.materialization
                : { kind: 'failed', errorCode: 'review_materialization_unavailable' },
            } : {}),
          };
        }),
        ...launchFailureOutcomes(output, 'review'),
      ],
      ...(retained.narration ? { narration: narrationRun ? narrationTerminalValue(narrationRun, purpose)
        : narrationLaunchFailure(retained.narration) } : {}),
    };
  },
};

export const reviewStartCompletion: ActionCompletionDeclaration = {
  awaits: 'workflow_runs',
  immediateResultSchema: lazyZodSchema(() => z.union([
    FanoutOutputSchema.check(z.refine(output =>
      output.intent === 'review' && output.reviewRound !== undefined && output.results.length === 0)),
    ReviewStartTerminalValueV1Schema.check(z.refine(output => output.reviewRound !== undefined
      && output.perEngineOutcome.length > 0 && output.perEngineOutcome.every(outcome => outcome.outcome === 'launch_failed'))),
  ])),
  executionRuns: reviewStartExecutionRunCompletion,
  terminalOutputSchema: StrictJsonValueSchema,
  launched: output => {
    const started = readReviewWorkflowStartActionResultV1(output);
    return { workflows: started ? [{ key: 'review', runId: started.workflow.runId }] : [] };
  },
  terminal: (_output, workflows) => workflows[0]?.workflow.result,
};

export const planStartCompletion: ActionCompletionDeclaration = {
  awaits: 'execution_runs',
  terminalOutputSchema: z.strictObject({
    plans: z.array(z.strictObject({ key: z.string().check(z.minLength(1)), runId: z.string().check(z.minLength(1)), value: z.unknown() })),
    perEngineOutcome: z.array(ReviewReviewerOutcomeV1Schema),
  }),
  launched: (output) => readLaunches(output, 'plan'),
  terminal: (output, runs) => ({
    plans: runs.flatMap(({ key, runId, outcome }) => outcome.kind === 'completed'
      ? [{ key, runId, value: outcome.result }] : []),
    perEngineOutcome: [...runs.map(perRunOutcome), ...launchFailureOutcomes(output, 'plan')],
  }),
};

export const delegateStartCompletion: ActionCompletionDeclaration = {
  awaits: 'execution_runs',
  terminalOutputSchema: lazyZodSchema(() => z.strictObject({
    delegates: z.array(z.strictObject({
      key: z.string().check(z.minLength(1)),
      runId: z.string().check(z.minLength(1)),
      value: StrictJsonValueSchema,
    })),
    perEngineOutcome: z.array(ReviewReviewerOutcomeV1Schema),
  })),
  launched: output => readLaunches(output, 'delegate'),
  terminal: (output, runs) => ({
    delegates: runs.flatMap(({ key, runId, outcome }) => outcome.kind === 'completed'
      ? [{ key, runId, value: outcome.result }] : []),
    perEngineOutcome: [...runs.map(perRunOutcome), ...launchFailureOutcomes(output, 'delegate')],
  }),
};
