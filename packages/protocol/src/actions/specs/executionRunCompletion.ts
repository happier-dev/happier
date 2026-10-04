import { z } from 'zod';

import type { ActionCompletionDeclaration, ActionCompletionRun, ExecutionRunTerminalObservation } from '../actionCompletion.js';
import { readExecutionRunStartRunCreation } from '../../execution/runs/responseSchemas.js';
import { ScmDiffSummaryGenerateOutputSchema } from '../../scm/diffSummary.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { ReviewWalkthroughObservationSchema } from '../../reviews/reviewNarration.js';
import { ReviewPublicationEvidenceSchema, ReviewPublicationMaterializationSchema } from '../../reviews/reviewPublicationEvidence.js';

// Retained immediate output is a compatibility seam: additional owner fields survive,
// but the launched run identity and the Action's intent must remain explicit.
const FanoutOutputSchema = z.object({
  intent: z.enum(['review', 'plan']),
  sessionId: z.string().nullable(),
  reviewedFingerprint: z.string().nullable().optional(),
  results: z.array(z.discriminatedUnion('ok', [
    z.object({ key: z.string().min(1), ok: z.literal(true), result: z.object({ runId: z.string().min(1) }).passthrough() }).passthrough(),
    z.object({ key: z.string().min(1), ok: z.literal(false), errorCode: z.string().min(1).optional(), error: z.string().min(1).optional() }).passthrough(),
  ])),
}).passthrough();

const PerEngineOutcomeSchema = z.object({
  key: z.string().min(1), runId: z.string().min(1).optional(),
  outcome: z.enum(['completed', 'failed', 'cancelled', 'launch_failed']),
  reviewOutcome: z.enum(['complete', 'partial', 'failed', 'unavailable']).optional(),
  errorCode: z.string().min(1).optional(), materialization: ReviewPublicationMaterializationSchema.optional(),
}).strict();

function readFanoutOutput(output: unknown, intent: 'review' | 'plan') {
  const parsed = FanoutOutputSchema.parse(output);
  if (parsed.intent !== intent) throw new Error('Retained Action intent changed');
  return parsed;
}

function readLaunches(output: unknown, intent: 'review' | 'plan') {
  const parsed = readFanoutOutput(output, intent);
  return {
    runs: parsed.results.flatMap((item) => item.ok ? [{ key: item.key, runId: item.result.runId }] : []),
    failed: parsed.results.flatMap((item) => item.ok ? [] : [{
      key: item.key, errorCode: item.errorCode ?? item.error ?? 'execution_run_failed',
      runCreation: readExecutionRunStartRunCreation(item.details),
    }]),
  };
}

type ObservedRun = Readonly<ActionCompletionRun & { outcome: ExecutionRunTerminalObservation }>;
function perRunOutcome({ key, runId, outcome }: ObservedRun) {
  return {
    key, runId, outcome: outcome.kind,
    ...(outcome.kind !== 'completed' && outcome.code ? { errorCode: outcome.code } : {}),
  };
}

function launchFailureOutcomes(output: unknown, intent: 'review' | 'plan') {
  return readLaunches(output, intent).failed.map(({ key, errorCode }) => ({ key, errorCode, outcome: 'launch_failed' as const }));
}

const NarrationTerminalValueSchema = z.object({ runId: z.string().min(1).optional(),
  outcome: z.enum(['completed', 'failed', 'cancelled', 'launch_failed']),
  outputState: z.enum(['complete', 'partial', 'failed', 'cancelled']).optional(),
  errorCode: z.string().min(1).optional(), result: StrictJsonValueSchema.optional(),
}).strict();

const NarrationLaunchSchema = z.object({ runId: z.string().min(1), comparisonId: z.string().min(1),
  observation: ReviewWalkthroughObservationSchema.optional(),
}).passthrough().refine((launch) => !launch.observation || launch.observation.comparisonId === launch.comparisonId,
  'Narrator observation must bind the launched comparison');

function narrationTerminalValue(run: ObservedRun) {
  if (run.outcome.kind === 'outcome_uncertain') throw new Error('Unsettled narration');
  const output = run.outcome.kind === 'completed' ? ScmDiffSummaryGenerateOutputSchema.safeParse(run.outcome.result) : undefined;
  const outputState = output?.success ? output.data.outputs?.walkthrough?.state : undefined;
  return { runId: run.runId, outcome: run.outcome.kind,
    ...(outputState && outputState !== 'pending' && outputState !== 'writing' ? { outputState } : {}),
    ...(run.outcome.kind === 'completed' ? { result: run.outcome.result }
      : run.outcome.code ? { errorCode: run.outcome.code } : {}),
  };
}

export const ReviewStartTerminalValueV1Schema = z.object({
  reviewedFingerprint: z.string().nullable(),
  commentIds: z.array(z.string().min(1)),
  perEngineOutcome: z.array(PerEngineOutcomeSchema),
  narration: NarrationTerminalValueSchema.optional(),
}).strict();

export const reviewWalkthroughCompletion: ActionCompletionDeclaration = {
  awaits: 'execution_runs',
  terminalOutputSchema: z.object({ narration: NarrationTerminalValueSchema }).strict(),
  launched: (output) => {
    const launch = NarrationLaunchSchema.parse(output);
    return { runs: [{ key: 'narrator', runId: launch.runId,
      observation: launch.observation ?? { kind: 'review_walkthrough', comparisonId: launch.comparisonId } }], failed: [] };
  },
  terminal: (_output, runs) => {
    if (runs.length !== 1) throw new Error('Narrator identity changed');
    return { narration: narrationTerminalValue(runs[0]!) };
  },
};

export const reviewStartCompletion: ActionCompletionDeclaration = {
  awaits: 'execution_runs',
  terminalOutputSchema: ReviewStartTerminalValueV1Schema,
  launched: (output) => {
    const launches = readLaunches(output, 'review');
    const retained = readFanoutOutput(output, 'review');
    const parsedNarration = NarrationLaunchSchema.safeParse(retained.narration);
    if (!parsedNarration.success) return launches;
    const narration = parsedNarration.data;
    const observation = narration.observation ?? { kind: 'review_walkthrough' as const, comparisonId: narration.comparisonId };
    const existing = launches.runs.some((run) => run.runId === narration.runId);
    return { ...launches, runs: existing
      ? launches.runs.map((run) => run.runId === narration.runId ? { ...run, observation } : run)
      : [...launches.runs, { key: 'narrator', runId: narration.runId, observation }] };
  },
  terminal: (output, runs) => {
    const retained = readFanoutOutput(output, 'review');
    const originalLaunches = readLaunches(output, 'review');
    const narrationRun = runs.find((run) => run.observation);
    const narrated = narrationRun?.outcome.kind === 'completed'
      ? ScmDiffSummaryGenerateOutputSchema.safeParse(narrationRun.outcome.result) : undefined;
    const reviewedRuns = narrated?.success ? narrated.data.producer?.reviewedRuns
      : narrationRun?.outcome.kind === 'failed' || narrationRun?.outcome.kind === 'cancelled'
        ? narrationRun.outcome.reviewedRuns : undefined;
    const reviewRuns = runs.filter((run) => originalLaunches.runs.some((original) => original.runId === run.runId && original.key === run.key))
      .map((run): ObservedRun => {
        if (!run.observation) return run;
        const provenance = reviewedRuns?.find((review) => review.runId === run.runId);
        const evidence = provenance ? ReviewPublicationEvidenceSchema.parse(provenance) : undefined;
        // Narration success alone never certifies findings or materialized comments.
        const outcome: ExecutionRunTerminalObservation = provenance?.hasOutput
          && (provenance.reviewOutcome === 'complete' || provenance.reviewOutcome === 'partial')
          ? { kind: 'completed', result: {}, ...evidence, reviewedFingerprint: evidence?.reviewedFingerprint ?? null }
          : provenance?.status === 'cancelled' ? { kind: 'cancelled' }
            : { kind: 'failed', code: provenance?.reviewOutcome === 'failed' ? 'review_failed' : 'review_output_unavailable' };
        return { ...run, outcome };
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
      reviewedFingerprint,
      // Only the host bridge's materialized ids count; raw findings are not proof of writes.
      commentIds: [...new Set(completed.flatMap((outcome) => outcome.commentIds ?? []))],
      perEngineOutcome: [
        ...reviewRuns.map((run) => {
          const reviewOutcome = run.observation
            ? reviewedRuns?.find((review) => review.runId === run.runId)?.reviewOutcome ?? 'unavailable' : undefined;
          return {
            ...perRunOutcome(run),
            ...(reviewOutcome ? { reviewOutcome } : {}),
            ...(run.outcome.kind === 'completed' ? {
              materialization: run.outcome.materialization && run.outcome.commentIds
                ? run.outcome.materialization
                : { kind: 'failed', errorCode: 'review_materialization_unavailable' },
            } : {}),
          };
        }),
        ...launchFailureOutcomes(output, 'review'),
      ],
      ...(retained.narration ? { narration: narrationRun ? narrationTerminalValue(narrationRun)
        : { outcome: 'launch_failed', errorCode: 'review_narration_failed' } } : {}),
    };
  },
};

export const planStartCompletion: ActionCompletionDeclaration = {
  awaits: 'execution_runs',
  terminalOutputSchema: z.object({
    plans: z.array(z.object({ key: z.string().min(1), runId: z.string().min(1), value: z.unknown() }).strict()),
    perEngineOutcome: z.array(PerEngineOutcomeSchema),
  }).strict(),
  launched: (output) => readLaunches(output, 'plan'),
  terminal: (output, runs) => ({
    plans: runs.flatMap(({ key, runId, outcome }) => outcome.kind === 'completed'
      ? [{ key, runId, value: outcome.result }] : []),
    perEngineOutcome: [...runs.map(perRunOutcome), ...launchFailureOutcomes(output, 'plan')],
  }),
};
