import { z } from 'zod';

import { sameStrictJsonValue, projectNativeJsonValueForTransport, StrictJsonValueSchema, type JsonValue } from '../json/strictJsonValue.js';
import { validateExecutionRunProfileResult } from '../execution/runs/resultContract.js';
import { normalizePluginJsonSchema } from '../plugins/actions/protocolComposableSchema.js';
import { PluginJsonSchemaV2Schema } from '../plugins/contributions/jsonSchema.js';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';
import type { ActionExecuteResult } from './actionExecutionResult.js';
import type { ExecutionRunGetResponse } from '../execution/runs/responseSchemas.js';
import { ExecutionRunStartRunCreationSchema, type ExecutionRunStartRunCreation } from '../execution/runs/responseSchemas.js';
import { ReviewWalkthroughObservationSchema, type ReviewWalkthroughObservation } from '../reviews/reviewNarration.js';
import { ScmDiffSummaryGenerateOutputSchema, type ScmDiffSummaryReviewRun } from '../scm/diffSummary.js';
import { ScmDiffSummaryResultErrorCodeSchema } from '../scm/diffSummaryResult.js';
import { ReviewPublicationEvidenceSchema, type ReviewPublicationMaterialization } from '../reviews/reviewPublicationEvidence.js';

export type ActionCompletionRun = Readonly<{ key: string; runId: string; observation?: ReviewWalkthroughObservation }>;
export type ActionCompletionLaunchFailure = Readonly<{ key: string; errorCode: string; runCreation: ExecutionRunStartRunCreation }>;
export type ReviewRunMaterialization = ReviewPublicationMaterialization;

/** Terminal evidence supplied by the execution-run observation owner, never an Action poll. */
export type ExecutionRunTerminalObservation =
  | Readonly<{
    kind: 'completed'; result: JsonValue;
    reviewedFingerprint?: string | null;
    commentIds?: readonly string[];
    materialization?: ReviewRunMaterialization;
  }>
  | Readonly<{ kind: 'failed'; code: string; reviewedRuns?: readonly ScmDiffSummaryReviewRun[] }>
  | Readonly<{ kind: 'cancelled'; code?: string; reviewedRuns?: readonly ScmDiffSummaryReviewRun[] }>
  | Readonly<{ kind: 'outcome_uncertain'; code: string }>;

/** Adapts a validated native terminal snapshot, not a polling Action or raw findings. */
export function readActionCompletionRunObservationV1(native: Readonly<{
  run: Pick<ExecutionRunGetResponse['run'], 'status' | 'error'>;
  latestToolResult?: unknown;
  structuredMeta?: ExecutionRunGetResponse['structuredMeta'];
}>, observation?: ReviewWalkthroughObservation): ExecutionRunTerminalObservation {
  if (observation) {
    if (native.run.error?.code === 'execution_run_send_outcome_unknown') {
      return { kind: 'outcome_uncertain', code: native.run.error.code };
    }
    const tool = native.latestToolResult;
    const raw = native.structuredMeta?.kind === 'scm_diff_summary.v1' ? native.structuredMeta.payload
      : tool;
    const output = ScmDiffSummaryGenerateOutputSchema.safeParse(raw);
    const matches = output.success && output.data.comparison?.id === observation.comparisonId
      && (!observation.resultId || output.data.resultId === observation.resultId);
    // A refused/cancelled prose operation does not erase genuine reviewer
    // evidence. Its saved revision need not advance for that earlier fact.
    const reviewedRuns = matches && output.data.producer?.kind === 'review'
      ? output.data.producer.reviewedRuns?.filter((run) => !run.comparisonId || run.comparisonId === observation.comparisonId)
      : undefined;
    const reviewEvidence = reviewedRuns?.length ? { reviewedRuns } : {};
    const publicationFailure = ScmDiffSummaryResultErrorCodeSchema.safeParse(native.run.error?.code);
    if (publicationFailure.success) return { kind: 'failed', code: publicationFailure.data, ...reviewEvidence };
    if (matches
      && (observation.afterRevision === undefined || output.data.revision !== undefined && output.data.revision > observation.afterRevision)) {
      const state = output.data.outputs?.walkthrough?.state;
      if (state && state !== 'pending' && state !== 'writing') {
        return { kind: 'completed', result: projectNativeJsonValueForTransport(output.data) };
      }
    }
    if (native.run.status === 'failed' || native.run.status === 'timeout') {
      return { kind: 'failed', code: native.run.error?.code ?? 'execution_run_failed', ...reviewEvidence };
    }
    if (native.run.status === 'cancelled') return { kind: 'cancelled', ...reviewEvidence };
    if (native.run.status === 'succeeded') return { kind: 'outcome_uncertain', code: 'execution_run_result_unavailable' };
    return { kind: 'outcome_uncertain', code: 'execution_run_output_not_settled' };
  }
  if (native.run.status === 'failed' || native.run.status === 'timeout') {
    return { kind: 'failed', code: native.run.error?.code ?? 'execution_run_failed' };
  }
  if (native.run.status === 'cancelled') return { kind: 'cancelled' };
  if (native.run.status !== 'succeeded') return { kind: 'outcome_uncertain', code: 'execution_run_not_terminal' };
  let result: JsonValue;
  try { result = projectNativeJsonValueForTransport(native.latestToolResult); }
  catch { return { kind: 'outcome_uncertain', code: 'execution_run_result_unavailable' }; }
  const evidence = ReviewPublicationEvidenceSchema.safeParse(result);
  return { kind: 'completed', result, ...(evidence.success ? evidence.data : {}) };
}

/** Unknown admission is settled uncertainty; only missing completion evidence remains pending. */
export function isActionCompletionRunObservationPendingV1(observation: ExecutionRunTerminalObservation): boolean {
  return observation.kind === 'outcome_uncertain'
    && (observation.code === 'execution_run_output_not_settled' || observation.code === 'execution_run_not_terminal');
}

export type ActionCompletionDeclaration = Readonly<{
  awaits: 'execution_runs';
  launched: (output: unknown) => Readonly<{
    runs: readonly ActionCompletionRun[];
    failed: readonly ActionCompletionLaunchFailure[];
  }>;
  terminalOutputSchema: z.ZodType;
  terminal: (output: unknown, runs: readonly Readonly<
    ActionCompletionRun & { outcome: ExecutionRunTerminalObservation }
  >[]) => unknown;
}>;

export const ActionCompletionContractV1Schema = z.object({
  awaits: z.literal('execution_runs'),
  terminalOutputSchema: PluginJsonSchemaV2Schema,
}).strict();
export type ActionCompletionContractV1 = z.infer<typeof ActionCompletionContractV1Schema>;

const ActionCompletionRunSchema = z.object({ key: z.string().min(1), runId: z.string().min(1),
  observation: ReviewWalkthroughObservationSchema.optional(),
}).strict();
const ActionCompletionLaunchesSchema = z.object({
  runs: z.array(ActionCompletionRunSchema),
  failed: z.array(z.object({ key: z.string().min(1), errorCode: z.string().min(1), runCreation: ExecutionRunStartRunCreationSchema }).strict()),
}).strict();
export const ActionCompletionStateV1Schema = z.object({
  output: StrictJsonValueSchema,
  awaitedRuns: z.array(ActionCompletionRunSchema).min(1),
}).strict();
export type ActionCompletionStateV1 = z.infer<typeof ActionCompletionStateV1Schema>;

export type ActionCompletionResult =
  | Readonly<{ kind: 'completed'; value: JsonValue }>
  | Readonly<{ kind: 'failed'; errorCode: string }>
  | Readonly<{ kind: 'outcome_uncertain'; errorCode: 'outcome_uncertain' }>;

export function freezeActionCompletionContractV1(declaration: ActionCompletionDeclaration): ActionCompletionContractV1 {
  return {
    awaits: declaration.awaits,
    terminalOutputSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(
      declaration.terminalOutputSchema, { target: 'draft-7' },
    )),
  };
}

export function prepareActionCompletionV1(
  declaration: ActionCompletionDeclaration | undefined,
  executed: ActionExecuteResult,
): ActionCompletionResult
  | Readonly<{ kind: 'failed'; errorCode: string; noRunsLaunched: true }>
  | Readonly<{ kind: 'awaiting'; state: ActionCompletionStateV1 }> {
  if (!executed.ok) return { kind: 'failed', errorCode: executed.errorCode };
  const output = StrictJsonValueSchema.safeParse(executed.result);
  if (!output.success) return { kind: 'failed', errorCode: 'invalid_action_output' };
  if (!declaration) return { kind: 'completed', value: output.data };
  try {
    const launched = ActionCompletionLaunchesSchema.parse(declaration.launched(output.data));
    if (launched.runs.length === 0) {
      return { kind: 'failed', errorCode: launched.failed[0]?.errorCode ?? 'action_failed',
        ...(launched.failed.length > 0 && launched.failed.every((failure) => failure.runCreation === 'noRunCreated')
          ? { noRunsLaunched: true as const } : {}) };
    }
    // This fact must be persisted by the caller before invoking the observation phase.
    return { kind: 'awaiting', state: { output: output.data, awaitedRuns: launched.runs } };
  } catch {
    // The invoke has already happened: invalid launch correspondence cannot safely be retried.
    return { kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' };
  }
}

export async function resumeActionCompletionV1(params: Readonly<{
  actionId: string;
  completion: unknown;
  state: unknown;
  resolveDeclaration: (actionId: string) => ActionCompletionDeclaration | undefined;
  observeRun: (run: ActionCompletionRun) => Promise<ExecutionRunTerminalObservation>;
}>): Promise<ActionCompletionResult> {
  const uncertain = { kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' } as const;
  const contract = ActionCompletionContractV1Schema.safeParse(params.completion);
  const state = ActionCompletionStateV1Schema.safeParse(params.state);
  if (!contract.success || !state.success) return uncertain;
  let declaration: ActionCompletionDeclaration | undefined;
  let hasUnknownLaunch = false;
  try {
    declaration = params.resolveDeclaration(params.actionId);
    if (!declaration || declaration.awaits !== contract.data.awaits) return uncertain;
    const launches = ActionCompletionLaunchesSchema.parse(declaration.launched(state.data.output));
    if (!sameStrictJsonValue(launches.runs, state.data.awaitedRuns)) return uncertain;
    hasUnknownLaunch = launches.failed.some((failure) => failure.runCreation === 'outcomeUnknown');
  } catch {
    return uncertain;
  }
  // Await every launched run. A transport failure is unknown, not a failed/cancelled run fact.
  const observed = await Promise.allSettled(state.data.awaitedRuns.map(async (run) => ({
    ...run, outcome: await params.observeRun(run),
  })));
  const runs: Array<ActionCompletionRun & { outcome: ExecutionRunTerminalObservation }> = [];
  for (const result of observed) {
    if (result.status === 'rejected' || result.value.outcome.kind === 'outcome_uncertain') return uncertain;
    runs.push(result.value);
  }
  let terminal: unknown;
  try {
    terminal = declaration.terminal(state.data.output, runs);
  } catch {
    // The current retained-state parser no longer understands this persisted invocation.
    return uncertain;
  }
  const value = StrictJsonValueSchema.safeParse(terminal);
  if (!value.success) return { kind: 'failed', errorCode: 'invalid_action_output' };
  // Typed producer output is already decoded: do not JSON.parse strings a second time.
  const validated = validateExecutionRunProfileResult(value.data, {
    kind: 'json', schema: contract.data.terminalOutputSchema,
  });
  if (!validated.ok) return { kind: 'failed', errorCode: 'invalid_action_output' };
  // Completing known runs cannot establish what happened to an unacknowledged sibling.
  return hasUnknownLaunch ? uncertain : { kind: 'completed', value: validated.value };
}
