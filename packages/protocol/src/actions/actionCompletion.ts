import { EXECUTION_RUN_KIND_BY_INTENT } from '../execution/runs/startRequest.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

import { sameStrictJsonValue, projectNativeJsonValueForTransport, StrictJsonValueSchema, type JsonValue } from '../json/strictJsonValue.js';
import { validateExecutionRunProfileResult } from '../execution/runs/resultContract.js';
import { normalizePluginJsonSchema } from '../plugins/actions/protocolComposableSchema.js';
import { PluginJsonSchemaV2Schema } from '../plugins/contributions/jsonSchema.js';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';
import { isActionOutcomeUnknownErrorCodeV1, type ActionExecuteResult, type ActionFailureCauseV1 } from './actionExecutionResult.js';
import { readActionFailureEnvelope } from './executor/actionFailureEnvelope.js';
import type { ExecutionRunGetResponse } from '../execution/runs/responseSchemas.js';
import { ExecutionRunStartRunCreationSchema, type ExecutionRunStartRunCreation } from '../execution/runs/responseSchemas.js';
import { ExecutionRunOutputObservationSchema, type ExecutionRunOutputObservation } from '../reviews/reviewNarration.js';
import { ScmDiffSummaryGenerateOutputSchema, type ScmDiffSummaryReviewRun } from '../scm/diffSummary.js';
import { ScmDiffSummaryResultErrorCodeSchema } from '../scm/diffSummaryResult.js';
import { projectReviewQuestionSummaryV1, ReviewPublicationEvidenceSchema, type ReviewPublicationMaterialization, type ReviewReviewerOutcomeV1 } from '../reviews/reviewPublicationEvidence.js';
import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from './operations/v1.js';
import type { DeploymentReceiptResultV1 } from '../deployments/deploymentActionsV1.js';
import type { WorkflowRunWaitResultV1 } from '../workflows/actionsV1.js';
import { isTerminalAutomationRunStateV3 } from '../automations/automationRunStateV3.js';

import { projectSessionRuntimeIssueMetadataV1 } from '../sessions/control/runtimeIssueMetadataV1.js';
import type { SessionRuntimeIssueV1 } from '../sessions/control/runtimeIssueV1.js';

export type ActionCompletionRun = Readonly<{ key: string; runId: string; observation?: ExecutionRunOutputObservation }>;
export type ActionCompletionLaunchFailure = Readonly<{ key: string; errorCode: string; runCreation: ExecutionRunStartRunCreation }>;
export type ReviewRunMaterialization = ReviewPublicationMaterialization;

/** Terminal evidence supplied by the execution-run observation owner, never an Action poll. */
export type ExecutionRunTerminalObservation = (
  | Readonly<{
    kind: 'completed'; result: JsonValue;
    reviewedFingerprint?: string | null;
    commentIds?: readonly string[];
    materialization?: ReviewRunMaterialization;
    reviewOutcome?: ReviewReviewerOutcomeV1['reviewOutcome'];
    quality?: ReviewReviewerOutcomeV1['quality'];
  }>
  | Readonly<{ kind: 'failed'; code: string; inputDispatch?: 'not_attempted'; runtimeIssueV1?: SessionRuntimeIssueV1; reviewedRuns?: readonly ScmDiffSummaryReviewRun[] }>
  | Readonly<{ kind: 'cancelled'; code?: string; reviewedRuns?: readonly ScmDiffSummaryReviewRun[] }>
  | Readonly<{ kind: 'outcome_uncertain'; code: string }>) & Readonly<{ questionSummary?: ReviewReviewerOutcomeV1['questionSummary'] }>;
/** A settled run carries its own start and finish from the run record, in epoch ms. */
export type ExecutionRunTerminalObservationWithTiming = ExecutionRunTerminalObservation & Readonly<{ startedAt?: number; finishedAt?: number }>;
type NativeRunSnapshot = Readonly<{
  run: Pick<ExecutionRunGetResponse['run'], 'status' | 'error'> & Partial<Pick<ExecutionRunGetResponse['run'], 'startedAtMs' | 'finishedAtMs'>>;
  reviewFindings?: ExecutionRunGetResponse['reviewFindings'];
  latestToolResult?: unknown;
  structuredMeta?: ExecutionRunGetResponse['structuredMeta'];
}>;

/** Adapts a validated native terminal snapshot, not a polling Action or raw findings. */
export function readActionCompletionRunObservationV1(native: NativeRunSnapshot,
  observation?: ExecutionRunOutputObservation): ExecutionRunTerminalObservationWithTiming {
  const settled = readNativeRunTerminalObservation(native, observation);
  if (settled.kind === 'outcome_uncertain') return settled;
  const questionSummary = projectReviewQuestionSummaryV1(native.reviewFindings ?? native.structuredMeta?.payload ?? native.latestToolResult);
  return { ...settled, ...(questionSummary ? { questionSummary } : {}), ...(native.run.startedAtMs === undefined ? {} : { startedAt: native.run.startedAtMs }),
    ...(native.run.finishedAtMs === undefined ? {} : { finishedAt: native.run.finishedAtMs }) };
}

function readNativeRunTerminalObservation(native: NativeRunSnapshot, observation?: ExecutionRunOutputObservation): ExecutionRunTerminalObservation {
  const runtimeIssueV1 = native.run.error?.runtimeIssueV1;
  const runtimeEvidence = runtimeIssueV1 ? { runtimeIssueV1: projectSessionRuntimeIssueMetadataV1(runtimeIssueV1) } : {};
  if (observation) {
    if (native.run.error?.code === 'execution_run_send_outcome_unknown') {
      return { kind: 'outcome_uncertain', code: native.run.error.code };
    }
    const tool = native.latestToolResult;
    const raw = native.structuredMeta?.kind === EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary ? native.structuredMeta.payload
      : tool;
    const output = createStoredReadSchema(ScmDiffSummaryGenerateOutputSchema).safeParse(raw);
    const matches = output.success && output.data.comparison?.id === observation.comparisonId
      && (!observation.resultId || output.data.resultId === observation.resultId);
    // A refused/cancelled prose operation does not erase genuine reviewer
    // evidence. Its saved revision need not advance for that earlier fact.
    const reviewedRuns = matches && output.data.producer?.kind === 'review'
      ? output.data.producer.reviewedRuns?.filter((run) => !run.comparisonId || run.comparisonId === observation.comparisonId)
      : undefined;
    const reviewEvidence = reviewedRuns?.length ? { reviewedRuns } : {};
    const publicationFailure = ScmDiffSummaryResultErrorCodeSchema.safeParse(native.run.error?.code);
    if (publicationFailure.success) return { kind: 'failed', code: publicationFailure.data, ...runtimeEvidence, ...reviewEvidence };
    if (matches
      && (observation.afterRevision === undefined || output.data.revision !== undefined && output.data.revision > observation.afterRevision)) {
      const state = output.data.outputs?.[observation.kind === 'scm_diff_summary' ? observation.output : 'walkthrough']?.state;
      if (state && state !== 'pending' && state !== 'writing') {
        return { kind: 'completed', result: projectNativeJsonValueForTransport(output.data) };
      }
    }
    if (native.run.status === 'failed' || native.run.status === 'timeout') {
      return { kind: 'failed', code: native.run.error?.code ?? 'execution_run_failed', ...runtimeEvidence, ...reviewEvidence };
    }
    if (native.run.status === 'cancelled') return { kind: 'cancelled', ...reviewEvidence };
    if (native.run.status === 'succeeded') return { kind: 'outcome_uncertain', code: 'execution_run_result_unavailable' };
    return { kind: 'outcome_uncertain', code: 'execution_run_output_not_settled' };
  }
  if (native.run.status === 'failed' || native.run.status === 'timeout') {
    const inputDispatch = native.run.error?.inputDispatch;
    return { kind: 'failed', code: native.run.error?.code ?? 'execution_run_failed',
      ...(inputDispatch ? { inputDispatch } : {}), ...runtimeEvidence };
  }
  if (native.run.status === 'cancelled') return { kind: 'cancelled' };
  if (native.run.status !== 'succeeded') return { kind: 'outcome_uncertain', code: 'execution_run_not_terminal' };
  let result: JsonValue;
  try { result = projectNativeJsonValueForTransport(native.latestToolResult); }
  catch { return { kind: 'outcome_uncertain', code: 'execution_run_result_unavailable' }; }
  const evidence = createStoredReadSchema(ReviewPublicationEvidenceSchema).safeParse(result);
  return { kind: 'completed', result, ...(evidence.success ? evidence.data : {}) };
}

/** Unknown admission is settled uncertainty; only missing completion evidence remains pending. */
export function isActionCompletionRunObservationPendingV1(observation: ExecutionRunTerminalObservation): boolean {
  return observation.kind === 'outcome_uncertain'
    && (observation.code === 'execution_run_output_not_settled' || observation.code === 'execution_run_not_terminal');
}

export type ActionCompletionOperation = Readonly<{ key: string; serverId: string; machineId: string; operationId: string }>;
export type ActionCompletionWorkflow = Readonly<{ key: string; runId: string }>;
export type ActionCompletionContextV1 = Readonly<{
  serverId?: string | null;
  /** The admitted invocation's frozen input, also retained by Workflow recovery. */
  input?: unknown;
}>;

export type ExecutionRunCompletionDeclaration = Readonly<{
  awaits: 'execution_runs';
  launched: (output: unknown, purpose?: 'input' | 'stored') => Readonly<{
    runs: readonly ActionCompletionRun[];
    failed: readonly ActionCompletionLaunchFailure[];
  }>;
  terminalOutputSchema: z.ZodMiniType;
  terminal: (output: unknown, runs: readonly Readonly<
    ActionCompletionRun & { outcome: ExecutionRunTerminalObservationWithTiming }
  >[], purpose?: 'input' | 'stored') => unknown;
}>;

type OperationCompletionDeclaration = Readonly<{
  awaits: 'action_operations';
  /** Explicit producer evidence that no finite launch is required. Never readiness. */
  immediateResultSchema?: z.ZodMiniType;
  launched: (output: unknown, context?: ActionCompletionContextV1) => Readonly<{
    operations: readonly ActionCompletionOperation[];
  }>;
  terminalOutputSchema: z.ZodMiniType;
  terminal: (output: unknown, operations: readonly Readonly<
    ActionCompletionOperation & { operation: ActionOperationSnapshotV1 }
  >[]) => unknown;
}>;
type WorkflowCompletionDeclaration = Readonly<{
  awaits: 'workflow_runs';
  immediateResultSchema?: z.ZodMiniType;
  /** Direct starts retain their existing native completion owner. */
  executionRuns?: ExecutionRunCompletionDeclaration;
  launched: (output: unknown, context?: ActionCompletionContextV1) => Readonly<{
    workflows: readonly ActionCompletionWorkflow[];
  }>;
  terminalOutputSchema: z.ZodMiniType;
  terminal: (output: unknown, workflows: readonly Readonly<
    ActionCompletionWorkflow & { workflow: WorkflowRunWaitResultV1 }
  >[]) => unknown;
}>;
export type ActionCompletionDeclaration = ExecutionRunCompletionDeclaration | OperationCompletionDeclaration | WorkflowCompletionDeclaration;

export const ActionCompletionContractV1Schema = lazyZodSchema(() => z.strictObject({
  awaits: z.enum(['execution_runs', 'action_operations', 'workflow_runs']),
  terminalOutputSchema: PluginJsonSchemaV2Schema,
}));
export type ActionCompletionContractV1 = z.infer<typeof ActionCompletionContractV1Schema>;

const ActionCompletionRunSchema = lazyZodSchema(() => z.strictObject({ key: z.string().check(z.minLength(1)), runId: z.string().check(z.minLength(1)),
  observation: z.optional(ExecutionRunOutputObservationSchema),
}));
const ActionCompletionLaunchesSchema = lazyZodSchema(() => z.strictObject({
  runs: z.array(ActionCompletionRunSchema),
  failed: z.array(z.strictObject({ key: z.string().check(z.minLength(1)), errorCode: z.string().check(z.minLength(1)), runCreation: ExecutionRunStartRunCreationSchema })),
}));
const ActionCompletionOperationSchema = lazyZodSchema(() => z.strictObject({
  key: z.string().check(z.minLength(1)), serverId: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.string().check(z.trim(), z.minLength(1)), operationId: z.string().check(z.trim(), z.minLength(1)),
}));
const ActionCompletionOperationLaunchesSchema = lazyZodSchema(() => z.strictObject({
  operations: z.array(ActionCompletionOperationSchema).check(z.minLength(1)),
}));
const ActionCompletionWorkflowSchema = lazyZodSchema(() => z.strictObject({
  key: z.string().check(z.minLength(1)), runId: z.string().check(z.minLength(1)),
}));
const ActionCompletionWorkflowLaunchesSchema = lazyZodSchema(() => z.strictObject({
  workflows: z.array(ActionCompletionWorkflowSchema),
}));
export const ActionCompletionStateV1Schema = lazyZodSchema(() => z.strictObject({
  output: StrictJsonValueSchema,
  awaitedRuns: z.optional(z.array(ActionCompletionRunSchema).check(z.minLength(1))),
  awaitedOperations: z.optional(z.array(ActionCompletionOperationSchema).check(z.minLength(1))),
  awaitedWorkflows: z.optional(z.array(ActionCompletionWorkflowSchema).check(z.minLength(1))),
}).check(z.refine(state => [state.awaitedRuns, state.awaitedOperations, state.awaitedWorkflows].filter(owner => owner !== undefined).length === 1, {
  message: 'Completion retains exactly one observation owner.',
})));
export type ActionCompletionStateV1 = z.infer<typeof ActionCompletionStateV1Schema>;

export type ActionCompletionResult =
  | Readonly<{ kind: 'completed'; value: JsonValue }>
  | Readonly<{ kind: 'failed'; errorCode: string; error?: string; value?: JsonValue; failureCause?: ActionFailureCauseV1 }>
  | Readonly<{ kind: 'cancelled'; errorCode: 'cancelled'; value?: JsonValue }>
  | Readonly<{ kind: 'outcome_uncertain'; errorCode: 'outcome_uncertain' }>;

const frozenActionCompletionCache = new WeakMap<ActionCompletionDeclaration, ActionCompletionContractV1>();

function deepFreezeContractValue<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeContractValue(child);
  return value;
}

export function freezeActionCompletionContractV1(declaration: ActionCompletionDeclaration): ActionCompletionContractV1 {
  const cached = frozenActionCompletionCache.get(declaration);
  if (cached) return cached;
  const frozen: ActionCompletionContractV1 = deepFreezeContractValue({
    awaits: declaration.awaits,
    terminalOutputSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(
      declaration.terminalOutputSchema, { target: 'draft-7' },
    )),
  });
  frozenActionCompletionCache.set(declaration, frozen);
  return frozen;
}

export function prepareActionCompletionV1(
  declaration: ActionCompletionDeclaration | undefined,
  executed: ActionExecuteResult,
  context?: ActionCompletionContextV1,
): ActionCompletionResult
  | Readonly<{ kind: 'failed'; errorCode: string; error?: string; value?: JsonValue; failureCause?: ActionFailureCauseV1; noRunsLaunched: true }>
  | Readonly<{ kind: 'awaiting'; state: ActionCompletionStateV1 }> {
  if (!executed.ok) {
    const details = StrictJsonValueSchema.safeParse(executed.details);
    const noEffectAttempted = (declaration?.awaits === 'workflow_runs' || declaration?.awaits === 'action_operations')
      && executed.effectAttempted === false
      && executed.errorCode !== 'action_failed'
      && !isActionOutcomeUnknownErrorCodeV1(executed.errorCode);
    return { kind: 'failed', errorCode: executed.errorCode, error: executed.error, ...(details.success ? { value: details.data } : {}),
      ...(executed.failureCause === undefined ? {} : { failureCause: executed.failureCause }),
      ...(noEffectAttempted ? { noRunsLaunched: true as const } : {}) };
  }
  const output = StrictJsonValueSchema.safeParse(executed.result);
  if (!output.success) return { kind: 'failed', errorCode: 'invalid_action_output' };
  if (!declaration) return { kind: 'completed', value: output.data };
  try {
    if (declaration.awaits === 'workflow_runs') {
      if (declaration.immediateResultSchema?.safeParse(output.data).success) return { kind: 'completed', value: output.data };
      const launched = ActionCompletionWorkflowLaunchesSchema.parse(declaration.launched(output.data, context));
      if (launched.workflows.length > 0) return { kind: 'awaiting', state: { output: output.data, awaitedWorkflows: launched.workflows } };
      if (!declaration.executionRuns) return { kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' };
      declaration = declaration.executionRuns;
    }
    if (declaration.awaits === 'action_operations') {
      const immediate = declaration.immediateResultSchema?.safeParse(output.data);
      if (immediate?.success) return { kind: 'completed', value: output.data };
      const launched = ActionCompletionOperationLaunchesSchema.parse(declaration.launched(output.data, context));
      return { kind: 'awaiting', state: { output: output.data, awaitedOperations: launched.operations } };
    }
    const launched = ActionCompletionLaunchesSchema.parse(declaration.launched(output.data));
    if (launched.runs.length === 0) {
      const firstFailed = launched.failed[0];
      const rawFailedItem = firstFailed && output.data && typeof output.data === 'object' && !Array.isArray(output.data)
        && Array.isArray((output.data as Readonly<Record<string, unknown>>).results)
        ? (output.data as Readonly<{ results: readonly unknown[] }>).results.find(
            (item) => item && typeof item === 'object' && !Array.isArray(item)
              && (item as Readonly<Record<string, unknown>>).ok === false
              && (item as Readonly<Record<string, unknown>>).key === firstFailed.key,
          )
        : undefined;
      const failedEnvelope = rawFailedItem ? readActionFailureEnvelope(rawFailedItem) : null;
      const hasExplicitError = rawFailedItem && typeof rawFailedItem === 'object' && !Array.isArray(rawFailedItem)
        && typeof (rawFailedItem as Readonly<Record<string, unknown>>).error === 'string'
        && ((rawFailedItem as Readonly<Record<string, unknown>>).error as string).trim().length > 0;
      const failedDetails = failedEnvelope?.details !== undefined
        ? StrictJsonValueSchema.safeParse(failedEnvelope.details)
        : undefined;
      return {
        kind: 'failed',
        errorCode: failedEnvelope?.errorCode ?? firstFailed?.errorCode ?? 'action_failed',
        ...(failedEnvelope && hasExplicitError ? { error: failedEnvelope.error } : {}),
        ...(failedDetails?.success ? { value: failedDetails.data } : {}),
        ...(failedEnvelope?.failureCause === undefined ? {} : { failureCause: failedEnvelope.failureCause }),
        ...(launched.failed.length > 0 && launched.failed.every((failure) => failure.runCreation === 'noRunCreated')
          ? { noRunsLaunched: true as const } : {}),
      };
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
  context?: ActionCompletionContextV1;
  resolveDeclaration: (actionId: string) => ActionCompletionDeclaration | undefined;
  observeRun?: (run: ActionCompletionRun) => Promise<ExecutionRunTerminalObservationWithTiming>;
  observeOperation?: (operation: ActionCompletionOperation) => Promise<unknown>;
  observeWorkflow?: (workflow: ActionCompletionWorkflow) => Promise<unknown>;
}>): Promise<ActionCompletionResult> {
  const uncertain = { kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' } as const;
  const contract = createStoredReadSchema(ActionCompletionContractV1Schema).safeParse(params.completion);
  const state = createStoredReadSchema(ActionCompletionStateV1Schema).safeParse(params.state);
  if (!contract.success || !state.success) return uncertain;
  if (state.data.awaitedWorkflows) {
    try {
      const declaration = params.resolveDeclaration(params.actionId);
      if (contract.data.awaits !== 'workflow_runs' || declaration?.awaits !== 'workflow_runs' || !params.observeWorkflow) return uncertain;
      const launched = ActionCompletionWorkflowLaunchesSchema.parse(declaration.launched(state.data.output, params.context));
      if (!sameStrictJsonValue(launched.workflows, state.data.awaitedWorkflows)) return uncertain;
      // Workflow contracts themselves depend on completion correspondence. Resolve
      // their observation schema only after the module graph has initialized.
      const { WorkflowRunWaitResultV1Schema } = await import('../workflows/actionsV1.js');
      const observed = await Promise.all(state.data.awaitedWorkflows.map(async target => {
        const workflow = WorkflowRunWaitResultV1Schema.parse(await params.observeWorkflow!(target));
        if (workflow.run.id !== target.runId || workflow.observation !== 'terminal' || !isTerminalAutomationRunStateV3(workflow.run.state)) {
          throw new Error('workflow_terminal_observation_unavailable');
        }
        return { ...target, workflow };
      }));
      const failed = observed.find(({ workflow }) => workflow.run.state !== 'succeeded' && workflow.run.state !== 'cancelled');
      if (failed) return failed.workflow.run.state === 'outcome_uncertain' ? uncertain
        : { kind: 'failed', errorCode: failed.workflow.run.errorCode ?? 'action_failed' };
      if (observed.some(({ workflow }) => workflow.run.state === 'cancelled')) return { kind: 'cancelled', errorCode: 'cancelled' };
      const value = StrictJsonValueSchema.safeParse(declaration.terminal(state.data.output, observed));
      if (!value.success) return { kind: 'failed', errorCode: 'invalid_action_output' };
      const validated = validateExecutionRunProfileResult(value.data, { kind: 'json', schema: contract.data.terminalOutputSchema });
      return validated.ok ? { kind: 'completed', value: validated.value } : { kind: 'failed', errorCode: 'invalid_action_output' };
    } catch { return uncertain; }
  }
  if (contract.data.awaits === 'action_operations') {
    try {
      const declaration = params.resolveDeclaration(params.actionId);
      if (declaration?.awaits !== 'action_operations' || !state.data.awaitedOperations || !params.observeOperation) return uncertain;
      const launched = ActionCompletionOperationLaunchesSchema.parse(declaration.launched(state.data.output,
        { ...params.context, serverId: state.data.awaitedOperations[0]?.serverId }));
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
      if (failure) return { kind: 'failed', errorCode: failure.error!.errorCode, error: failure.error!.error, value: validated.value,
        ...(failure.error!.failureCause === undefined ? {} : { failureCause: failure.error!.failureCause }) };
      if (observations.some(({ operation }) => operation.state === 'cancelled')) {
        return { kind: 'cancelled', errorCode: 'cancelled', value: validated.value };
      }
      return { kind: 'completed', value: validated.value };
    } catch { return uncertain; }
  }
  if (!state.data.awaitedRuns || !params.observeRun) return uncertain;
  const observeRun = params.observeRun;
  let declaration: ExecutionRunCompletionDeclaration | undefined;
  let hasUnknownLaunch = false;
  try {
    const current = params.resolveDeclaration(params.actionId);
    declaration = current?.awaits === 'workflow_runs' ? current.executionRuns : current?.awaits === 'execution_runs' ? current : undefined;
    if (!declaration || declaration.awaits !== 'execution_runs') return uncertain;
    const launches = ActionCompletionLaunchesSchema.parse(declaration.launched(state.data.output, 'stored'));
    if (!sameStrictJsonValue(launches.runs, state.data.awaitedRuns)) return uncertain;
    hasUnknownLaunch = launches.failed.some((failure) => failure.runCreation === 'outcomeUnknown');
  } catch {
    return uncertain;
  }
  // Await every launched run. A transport failure is unknown, not a failed/cancelled run fact.
  const observed = await Promise.allSettled(state.data.awaitedRuns.map(async (run) => ({
    ...run, outcome: await observeRun(run),
  })));
  const runs: Array<ActionCompletionRun & { outcome: ExecutionRunTerminalObservationWithTiming }> = [];
  for (const result of observed) {
    if (result.status === 'rejected' || result.value.outcome.kind === 'outcome_uncertain') return uncertain;
    runs.push(result.value);
  }
  let terminal: unknown;
  try {
    terminal = declaration.terminal(state.data.output, runs, 'stored');
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

export const ActionOperationCompletionOutputV1Schema = lazyZodSchema(() => z.strictObject({ operation: ActionOperationSnapshotV1Schema }));
export const ProjectCommandActionOutputV1Schema = ActionOperationCompletionOutputV1Schema;

/** One finite completion owner; preparation can also produce strict no-launch final facts. */
export function createProjectCommandActionCompletionV1(options: Readonly<{ immediateResultSchema?: z.ZodMiniType }> = {}): OperationCompletionDeclaration {
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

/** The accepted host operation, not a pending storage acknowledgement, completes this leaf. */
export function createDeploymentDeployActionCompletionV1(resultSchema: z.ZodMiniType<DeploymentReceiptResultV1>): OperationCompletionDeclaration {
  const completedResultSchema = lazyZodSchema(() => resultSchema.check(z.refine(
    value => !value.ok || 'deploymentId' in value && (value.state === 'succeeded' || value.state === 'running_unverified'),
    { message: 'A retained pending deployment is not terminal evidence.' },
  )));
  return {
    awaits: 'action_operations',
    immediateResultSchema: completedResultSchema,
    terminalOutputSchema: lazyZodSchema(() => z.union([completedResultSchema, ActionOperationCompletionOutputV1Schema])),
    launched: output => {
      const pending = resultSchema.parse(output);
      if (!pending.ok || !('kind' in pending) || pending.kind !== 'pending' || !pending.operation
        || pending.operation.operationId !== pending.actionOperationId) {
        throw new Error('deployment_operation_context_unavailable');
      }
      return { operations: [{ key: 'deployment', ...pending.operation }] };
    },
    terminal: (output, operations) => {
      const pending = resultSchema.parse(output);
      const observed = operations[0];
      const operation = observed?.operation;
      if (!pending.ok || !('kind' in pending) || pending.kind !== 'pending' || !pending.operation
        || operations.length !== 1 || !observed || !operation || operation.operationId !== pending.actionOperationId
        || observed.serverId !== pending.operation.serverId || observed.machineId !== pending.operation.machineId
        || observed.operationId !== pending.operation.operationId
        || operation.scope.machineId !== pending.operation.machineId || operation.actionId !== 'deployments.deploy') {
        throw new Error('deployment_operation_correspondence_mismatch');
      }
      if (operation.state !== 'succeeded') return { operation };
      const receipt = completedResultSchema.parse(operation.result);
      if (receipt.ok && receipt.environmentId !== pending.environmentId) {
        throw new Error('deployment_operation_correspondence_mismatch');
      }
      return receipt;
    },
  };
}
