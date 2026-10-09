import { lazyZodSchema } from '../lazyZodSchema.js';
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
import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from './operations/v1.js';

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

export type ActionCompletionOperation = Readonly<{ key: string; serverId: string; machineId: string; operationId: string }>;
export type ActionCompletionContextV1 = Readonly<{ serverId?: string | null }>;

type ExecutionRunCompletionDeclaration = Readonly<{
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

type OperationCompletionDeclaration = Readonly<{
  awaits: 'action_operations';
  /** Explicit producer evidence that no finite launch is required. Never readiness. */
  immediateResultSchema?: z.ZodType;
  launched: (output: unknown, context?: ActionCompletionContextV1) => Readonly<{
    operations: readonly ActionCompletionOperation[];
  }>;
  terminalOutputSchema: z.ZodType;
  terminal: (output: unknown, operations: readonly Readonly<
    ActionCompletionOperation & { operation: ActionOperationSnapshotV1 }
  >[]) => unknown;
}>;
export type ActionCompletionDeclaration = ExecutionRunCompletionDeclaration | OperationCompletionDeclaration;

export const ActionCompletionContractV1Schema = lazyZodSchema(() => z.object({
  awaits: z.enum(['execution_runs', 'action_operations']),
  terminalOutputSchema: PluginJsonSchemaV2Schema,
}).strict());
export type ActionCompletionContractV1 = z.infer<typeof ActionCompletionContractV1Schema>;

const ActionCompletionRunSchema = lazyZodSchema(() => z.object({ key: z.string().min(1), runId: z.string().min(1),
  observation: ReviewWalkthroughObservationSchema.optional(),
}).strict());
const ActionCompletionLaunchesSchema = lazyZodSchema(() => z.object({
  runs: z.array(ActionCompletionRunSchema),
  failed: z.array(z.object({ key: z.string().min(1), errorCode: z.string().min(1), runCreation: ExecutionRunStartRunCreationSchema }).strict()),
}).strict());
const ActionCompletionOperationSchema = lazyZodSchema(() => z.object({
  key: z.string().min(1), serverId: z.string().trim().min(1),
  machineId: z.string().trim().min(1), operationId: z.string().trim().min(1),
}).strict());
const ActionCompletionOperationLaunchesSchema = lazyZodSchema(() => z.object({
  operations: z.array(ActionCompletionOperationSchema).min(1),
}).strict());
export const ActionCompletionStateV1Schema = lazyZodSchema(() => z.object({
  output: StrictJsonValueSchema,
  awaitedRuns: z.array(ActionCompletionRunSchema).min(1).optional(),
  awaitedOperations: z.array(ActionCompletionOperationSchema).min(1).optional(),
}).strict().refine(state => (state.awaitedRuns !== undefined) !== (state.awaitedOperations !== undefined), {
  message: 'Completion retains exactly one observation owner.',
}));
export type ActionCompletionStateV1 = z.infer<typeof ActionCompletionStateV1Schema>;

export type ActionCompletionResult =
  | Readonly<{ kind: 'completed'; value: JsonValue }>
  | Readonly<{ kind: 'failed'; errorCode: string; value?: JsonValue }>
  | Readonly<{ kind: 'cancelled'; errorCode: 'cancelled'; value?: JsonValue }>
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
  context?: ActionCompletionContextV1,
): ActionCompletionResult
  | Readonly<{ kind: 'failed'; errorCode: string; noRunsLaunched: true }>
  | Readonly<{ kind: 'awaiting'; state: ActionCompletionStateV1 }> {
  if (!executed.ok) {
    const details = StrictJsonValueSchema.safeParse(executed.details);
    return { kind: 'failed', errorCode: executed.errorCode, ...(details.success ? { value: details.data } : {}) };
  }
  const output = StrictJsonValueSchema.safeParse(executed.result);
  if (!output.success) return { kind: 'failed', errorCode: 'invalid_action_output' };
  if (!declaration) return { kind: 'completed', value: output.data };
  try {
    if (declaration.awaits === 'action_operations') {
      const immediate = declaration.immediateResultSchema?.safeParse(output.data);
      if (immediate?.success) return { kind: 'completed', value: output.data };
      const launched = ActionCompletionOperationLaunchesSchema.parse(declaration.launched(output.data, context));
      return { kind: 'awaiting', state: { output: output.data, awaitedOperations: launched.operations } };
    }
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
  observeRun?: (run: ActionCompletionRun) => Promise<ExecutionRunTerminalObservation>;
  observeOperation?: (operation: ActionCompletionOperation) => Promise<unknown>;
}>): Promise<ActionCompletionResult> {
  const uncertain = { kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' } as const;
  const contract = ActionCompletionContractV1Schema.safeParse(params.completion);
  const state = ActionCompletionStateV1Schema.safeParse(params.state);
  if (!contract.success || !state.success) return uncertain;
  if (contract.data.awaits === 'action_operations') {
    try {
      const declaration = params.resolveDeclaration(params.actionId);
      if (declaration?.awaits !== 'action_operations' || !state.data.awaitedOperations || !params.observeOperation) return uncertain;
      const launched = ActionCompletionOperationLaunchesSchema.parse(declaration.launched(state.data.output,
        { serverId: state.data.awaitedOperations[0]?.serverId }));
      if (!sameStrictJsonValue(launched.operations, state.data.awaitedOperations)) return uncertain;
      const observations = await Promise.all(state.data.awaitedOperations.map(async target => {
        const operation = ActionOperationSnapshotV1Schema.parse(await params.observeOperation!(target));
        if (operation.operationId !== target.operationId || operation.scope.machineId !== target.machineId
          || operation.actionId !== params.actionId
          || (operation.state === 'accepted' || operation.state === 'running') && !operation.setupReview) {
          throw new Error('action_operation_terminal_observation_unavailable');
        }
        return { ...target, operation };
      }));
      const value = StrictJsonValueSchema.safeParse(declaration.terminal(state.data.output, observations));
      if (!value.success) return { kind: 'failed', errorCode: 'invalid_action_output' };
      const review = observations.find(({ operation }) => operation.setupReview)?.operation.setupReview;
      if (review) {
        return { kind: 'failed', errorCode: review.code, value: value.data };
      }
      const validated = validateExecutionRunProfileResult(value.data, { kind: 'json', schema: contract.data.terminalOutputSchema });
      if (!validated.ok) return { kind: 'failed', errorCode: 'invalid_action_output' };
      const failure = observations.find(({ operation }) => operation.state === 'failed')?.operation;
      if (failure) return { kind: 'failed', errorCode: failure.error!.errorCode, value: validated.value };
      if (observations.some(({ operation }) => operation.state === 'cancelled')) {
        return { kind: 'cancelled', errorCode: 'cancelled', value: validated.value };
      }
      return { kind: 'completed', value: validated.value };
    } catch { return uncertain; }
  }
  if (!state.data.awaitedRuns || !params.observeRun) return uncertain;
  const observeRun = params.observeRun;
  let declaration: ActionCompletionDeclaration | undefined;
  let hasUnknownLaunch = false;
  try {
    declaration = params.resolveDeclaration(params.actionId);
    if (!declaration || declaration.awaits !== 'execution_runs') return uncertain;
    const launches = ActionCompletionLaunchesSchema.parse(declaration.launched(state.data.output));
    if (!sameStrictJsonValue(launches.runs, state.data.awaitedRuns)) return uncertain;
    hasUnknownLaunch = launches.failed.some((failure) => failure.runCreation === 'outcomeUnknown');
  } catch {
    return uncertain;
  }
  // Await every launched run. A transport failure is unknown, not a failed/cancelled run fact.
  const observed = await Promise.allSettled(state.data.awaitedRuns.map(async (run) => ({
    ...run, outcome: await observeRun(run),
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

export const ProjectCommandActionOutputV1Schema = lazyZodSchema(() => z.object({ operation: ActionOperationSnapshotV1Schema }).strict());

/** One finite completion owner; preparation can also produce strict no-launch final facts. */
export function createProjectCommandActionCompletionV1(options: Readonly<{ immediateResultSchema?: z.ZodType }> = {}): OperationCompletionDeclaration {
  const immediateResultSchema = options.immediateResultSchema;
  return {
    awaits: 'action_operations',
    ...(immediateResultSchema ? { immediateResultSchema } : {}),
    terminalOutputSchema: lazyZodSchema(() => immediateResultSchema
      ? z.union([ProjectCommandActionOutputV1Schema, immediateResultSchema]) : ProjectCommandActionOutputV1Schema),
    launched: (output, context) => {
      const { operation } = ProjectCommandActionOutputV1Schema.parse(output);
      if (!context?.serverId || operation.domainRef?.kind !== 'projectCommand') throw new Error('action_operation_context_unavailable');
      return { operations: [{ key: 'command', serverId: context.serverId, machineId: operation.scope.machineId,
        operationId: operation.operationId }] };
    },
    terminal: (output, operations) => {
      const accepted = ProjectCommandActionOutputV1Schema.parse(output).operation;
      const operation = operations[0]?.operation;
      const prior = accepted.domainRef;
      const current = operation?.domainRef;
      if (!operation || operation.scope.accountId !== accepted.scope.accountId
        || operation.scope.sessionId !== accepted.scope.sessionId || prior?.kind !== 'projectCommand'
        || current?.kind !== 'projectCommand' || current.serverId !== prior.serverId || current.machineId !== prior.machineId
        || current.workspaceRefId !== prior.workspaceRefId
        || !sameStrictJsonValue(current.originRun ?? null, prior.originRun ?? null)) {
        throw new Error('action_operation_correspondence_mismatch');
      }
      return { operation };
    },
  };
}

/** Finite command acceptance is an observation handle, never a completed workflow leaf. */
export const projectCommandActionCompletionV1 = createProjectCommandActionCompletionV1();
