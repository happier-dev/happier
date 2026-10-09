import { areWorkflowRetainedRuntimeSelectionsEqualV1, projectWorkflowRetainedRuntimeSelectionV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { assertNonEscalatingPermissionMode } from '@happier-dev/protocol/actions/permissionPrivilege';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ExecutionRunStartResponseSchema, readExecutionRunStartRunCreation } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { HappierStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import type { ExecutionRunResultContractV1, ExecutionRunResumeHandle, WorkflowAuthoredProducerRef, WorkflowProgressEnvelopeV1, WorkflowRetainedRuntimeSelectionV1 } from '@happier-dev/protocol';

type ExecutionRunResumeHandleProviderSessionV1 = Extract<
  ExecutionRunResumeHandle,
  Readonly<{ kind: 'provider_session.v1' }>
>;
import { areExecutionRunBackendTargetsEqual } from '@/agent/runtime/bridges/executionRun/backendTargets';
import type { ExecutionRunWorkflowObservation } from '@/agent/runtime/bridges/executionRun/executionRunWorkflowObservation';
import { deriveExecutionRunIdFromActionRequestId } from '@/agent/runtime/bridges/executionRun/startExecutionRun';

import type {
  RpcActionExecutor,
  RpcActionExecutorContext,
} from '@/rpc/handlers/_actionDispatchAdapter';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import {
  classifyWorkflowAbort,
  assertWorkflowAdmissionSignal,
  WorkflowRuntimeInterruption,
  type WorkflowStepExecutor,
  type WorkflowStepExecutionResult,
  type WorkflowStepPreparer,
} from './coordinator';
import {
  observeWorkflowDetachedExecutionRunInput,
  stopWorkflowPendingExecutionRunInput,
  type WorkflowDetachedExecutionRunObservation,
} from './stepExecution';
import { resolveWorkflowConversationSelection, type WorkflowConversationBinding } from './workflowConversation';
import type { WorkflowProducerBinding } from './workflowScopeBinding';
import { withWorkflowRoleInstructions } from './sessionStepExecutor';

type WorkflowExecutionRunConversation = Readonly<{
  runId: string;
  machineId: string;
  directory?: string;
  /** Exact effective selection admitted when this detached Run was created. */
  runtimeSelection?: WorkflowRetainedRuntimeSelectionV1;
  /** Private Workflow progress identity; public Run projections are not restart authority. */
  providerResumeIdentity?: Extract<ExecutionRunResumeHandle, { kind: 'provider_session.v1' }>;
}>;

type DetachedExecutionRunActionExecutor = Pick<RpcActionExecutor, 'execute'>;
type ExecutionRunObservationDeps = Readonly<{
  actionExecutor: DetachedExecutionRunActionExecutor;
}>;

export type WorkflowDetachedExecutionRunStepExecutorDeps = Readonly<{
  actionExecutor: DetachedExecutionRunActionExecutor;
  /** The accepted Run stamp, never an authored step or Action input. */
  workDepth: number;
  resolveRoleInstructions?: (params: Parameters<WorkflowStepExecutor>[0]) => string | undefined;
  resolveSharedRunConversation: (params: Readonly<{
    runId: string;
    invocation: WorkflowProgressEnvelopeV1;
    conversationBinding?: WorkflowConversationBinding;
  }>) => Promise<WorkflowExecutionRunConversation | null>;
  resolveProducerConversation: (params: Readonly<{
    runId: string;
    producer: WorkflowAuthoredProducerRef;
    invocation: WorkflowProgressEnvelopeV1;
    producerBinding?: WorkflowProducerBinding;
  }>) => Promise<WorkflowExecutionRunConversation | null>;
  /** Supplies accepted authority and, for new input, fresh host admission facts. */
  buildActionContext: (
    params: Parameters<WorkflowStepExecutor>[0] & Readonly<{ workDepth: number }>,
  ) => RpcActionExecutorContext | Promise<RpcActionExecutorContext>;
}>;

export class WorkflowExecutionRunCompositionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type PreparedWorkflowDetachedExecutionRun = Readonly<{
  kind: 'workflow_detached_execution_run';
  retainedConversation: WorkflowExecutionRunConversation | null;
  runtimeSelection: WorkflowRetainedRuntimeSelectionV1;
}>;

function isPreparedWorkflowDetachedExecutionRun(
  value: unknown,
): value is PreparedWorkflowDetachedExecutionRun {
  return typeof value === 'object' && value !== null
    && 'kind' in value && value.kind === 'workflow_detached_execution_run'
    && 'runtimeSelection' in value;
}

async function actionContextFor(
  deps: WorkflowDetachedExecutionRunStepExecutorDeps,
  params: Parameters<WorkflowStepExecutor>[0],
  observation?: Readonly<{
    localInputId: string;
    runtimeSelection: WorkflowRetainedRuntimeSelectionV1;
  }>,
): Promise<RpcActionExecutorContext> {
  const ownerContext = await deps.buildActionContext({ ...params, workDepth: deps.workDepth });
  return {
    ...ownerContext,
    actionCaller: {
      kind: 'workflowRun',
      runId: params.runId,
      authorization: params.authorization,
    },
    executionRunTargetMachineId: params.workspace.machineId,
    ...(observation
      ? {
          executionRunWorkflowObservationSink: {
            workflowRunId: params.runId,
            commit: async (value: ExecutionRunWorkflowObservation) => {
              if (value.localInputId !== observation.localInputId) {
                throw new Error('workflow_invocation_fact_conflict');
              }
              const execution = {
                kind: 'detached_run',
                runId: value.runId,
                localInputId: observation.localInputId,
                runtimeSelection: observation.runtimeSelection,
                ...(value.kind === 'provider_resume_identity'
                  ? { providerResumeIdentity: value.providerResumeIdentity }
                  : {}),
              } as const;
              if (value.kind === 'input_accepted') {
                await params.onInputAccepted(execution, value.acceptedAtMs);
                return;
              }
              await params.onExecutionObservation?.({
                execution,
                ...(value.kind === 'usage' ? { usage: value.usage } : {}),
              });
            },
          },
        }
      : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  };
}

function classifyActionFailure(
  result: Extract<Awaited<ReturnType<RpcActionExecutor['execute']>>, { ok: false }>,
  start: boolean,
  signal?: AbortSignal,
): WorkflowStepExecutionResult {
  if (start && readExecutionRunStartRunCreation(result.details) !== 'noRunCreated') {
    return { kind: 'outcome_uncertain', code: result.errorCode };
  }
  if (result.errorCode === 'execution_run_send_outcome_unknown') {
    return { kind: 'outcome_uncertain', code: result.errorCode };
  }
  if (result.errorCode === 'execution_run_initial_input_outcome_unknown') {
    return { kind: 'needs_attention', code: result.errorCode };
  }
  if (result.errorCode === 'cancelled') {
    if (classifyWorkflowAbort(signal) === 'interrupted') {
      // An owner-proven `noRunCreated` start left nothing behind: the row
      // stays re-enterable for the reclaim. A retained-conversation send
      // cannot prove whether its prompt was emitted, so it waits for an
      // explicit recovery choice instead of being resubmitted or relabeled
      // as user cancellation.
      if (start) throw new WorkflowRuntimeInterruption();
      return { kind: 'needs_attention', code: 'execution_run_input_admission_interrupted' };
    }
    return { kind: 'cancelled', code: result.errorCode };
  }
  if (
    result.errorCode === 'execution_run_not_found'
    || result.errorCode === 'execution_run_target_unavailable'
    || result.errorCode === 'execution_run_protocol_unsupported'
  ) {
    return { kind: 'needs_attention', code: 'continuation_unavailable' };
  }
  return { kind: 'failed', code: result.errorCode };
}

function projectObservation(
  observation: Exclude<WorkflowDetachedExecutionRunObservation, { kind: 'pending' }>,
): WorkflowStepExecutionResult {
  switch (observation.kind) {
    case 'completed': return { kind: 'completed', result: observation.result, resultEncoding: 'typed' };
    case 'failed': return { kind: 'failed', code: observation.code };
    case 'cancelled': return { kind: 'cancelled', ...(observation.code ? { code: observation.code } : {}) };
    case 'outcome_uncertain': return { kind: 'outcome_uncertain', code: observation.code };
  }
}

const MAX_SCHEDULABLE_OBSERVATION_DELAY_MS = 2_147_483_647;

type WorkflowObservationDeadline = Readonly<{
  signal: AbortSignal;
  expired: () => boolean;
  arm: (expiresAt: number) => void;
  dispose: () => void;
}>;

function createWorkflowObservationDeadline(initialExpiresAt: number | null): WorkflowObservationDeadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let expiresAt = initialExpiresAt;
  let disposed = false;
  const schedule = () => {
    if (expiresAt === null || disposed) return;
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      expired = true;
      controller.abort(new Error('Workflow observation deadline reached'));
      return;
    }
    // Host timers cannot represent longer waits. Re-arm against the same
    // persisted absolute deadline instead of narrowing the authored timeout.
    timer = setTimeout(schedule, Math.min(remainingMs, MAX_SCHEDULABLE_OBSERVATION_DELAY_MS));
  };
  schedule();
  return {
    signal: controller.signal,
    expired: () => expired,
    arm: (acceptedExpiresAt) => {
      // Rejoin and repeated evidence retain the first absolute deadline.
      if (expiresAt !== null || disposed) return;
      expiresAt = acceptedExpiresAt;
      schedule();
    },
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

async function observeExactRunInput(params: Readonly<{
  deps: ExecutionRunObservationDeps;
  executionParams: Parameters<WorkflowStepExecutor>[0];
  runId: string;
  localInputId: string;
  sessionId: null;
  context: RpcActionExecutorContext;
  deadline: WorkflowObservationDeadline | null;
}>): Promise<WorkflowStepExecutionResult> {
  const expiresAt = params.executionParams.invocation.observationDeadline?.kind === 'at'
    ? Date.parse(params.executionParams.invocation.observationDeadline.expiresAt)
    : null;
  if (params.executionParams.signal?.aborted) {
    return await settleOwnedRunInputAfterAbort(params);
  }
  if (params.deadline?.expired() || (expiresAt !== null && Date.now() >= expiresAt)) {
    return { kind: 'needs_attention', code: 'workflow_step_timeout' };
  }
  const deadline = params.deadline;
  const observationContext = deadline === null
    ? params.context
    : {
        ...params.context,
        signal: params.context.signal
          ? AbortSignal.any([params.context.signal, deadline.signal])
          : deadline.signal,
      };
  const actionFailure: { current: WorkflowStepExecutionResult | null } = { current: null };
  const observation = await observeWorkflowDetachedExecutionRunInput({
      runId: params.runId,
      localInputId: params.localInputId,
      get: async (request) => {
        const result = await params.deps.actionExecutor.execute(
          'execution.run.get',
          { sessionId: params.sessionId, ...request, waitForInputId: params.localInputId },
          observationContext,
        );
        if (!result.ok) {
          actionFailure.current = classifyActionFailure(result, false);
          return null;
        }
        return result.result;
      },
  }).catch((error: unknown) => {
      if (actionFailure.current) return null;
      if (deadline?.expired()) {
        actionFailure.current = { kind: 'needs_attention', code: 'workflow_step_timeout' };
        return null;
      }
      throw error;
  });
  if (actionFailure.current) {
    if (params.executionParams.signal?.aborted) return await settleOwnedRunInputAfterAbort(params);
    if (deadline?.expired()) return { kind: 'needs_attention', code: 'workflow_step_timeout' };
    return actionFailure.current.kind === 'cancelled'
      ? await settleOwnedRunInputAfterAbort(params)
      : actionFailure.current;
  }
  if (observation && observation.kind !== 'pending') return projectObservation(observation);
  if (params.executionParams.signal?.aborted) return await settleOwnedRunInputAfterAbort(params);
  return { kind: 'outcome_uncertain', code: 'execution_run_input_result_unavailable' };
}

/**
 * The observation ended because this attempt was aborted. Only an abort that
 * carries stop authority (cancel request, fail-stop closure, revoked
 * authority) stops the owned input; a bare claim interruption leaves the
 * surviving Run untouched for reclaim/reattach and unwinds without a fact.
 */
async function settleOwnedRunInputAfterAbort(params: Readonly<{
  deps: ExecutionRunObservationDeps;
  executionParams: Parameters<WorkflowStepExecutor>[0];
  runId: string;
  localInputId: string;
  sessionId: null;
  context: RpcActionExecutorContext;
}>): Promise<WorkflowStepExecutionResult> {
  if (classifyWorkflowAbort(params.executionParams.signal) === 'interrupted') {
    throw new WorkflowRuntimeInterruption();
  }
  const { signal: _abortedSignal, ...settlementContext } = params.context;
  const settled = await stopWorkflowPendingExecutionRunInput({
    runId: params.runId,
    localInputId: params.localInputId,
    stop: async () => await params.deps.actionExecutor.execute(
      'execution.run.stop',
      { sessionId: params.sessionId, runId: params.runId },
      settlementContext,
    ),
    get: async (request) => {
      const result = await params.deps.actionExecutor.execute(
        'execution.run.get',
        { sessionId: params.sessionId, ...request },
        settlementContext,
      );
      return result.ok ? result.result : null;
    },
  });
  return settled.kind === 'unresolved'
    ? { kind: 'outcome_uncertain', code: settled.code }
    : projectObservation(settled);
}

function validateConversation(
  conversation: Pick<WorkflowExecutionRunConversation, 'machineId' | 'directory'>,
  params: Parameters<WorkflowStepExecutor>[0],
): void {
  if (
    conversation.machineId !== params.workspace.machineId
    || (conversation.directory !== undefined
      && !canonicalAbsolutePathsEqual(conversation.directory, params.workspace.directory))
  ) {
    throw new WorkflowExecutionRunCompositionError('workflow_conversation_unavailable');
  }
}

function buildNativeAgentRunStartInput(params: Readonly<{
  executionParams: Parameters<WorkflowStepExecutor>[0];
  sessionId: null;
  localInputId: string;
  roleInstructions?: string;
  permissionMode: string;
}>): Record<string, unknown> {
  const { executionParams, sessionId, localInputId } = params;
  const selection = executionParams.execution;
  const modelSelection = selection.modelSelection?.ref;
  return {
    sessionId,
    intent: 'agent',
    backendTarget: selection.agentTarget,
    instructions: withWorkflowRoleInstructions(executionParams.input.text, params.roleInstructions),
    localInputId,
    resultContract: executionParams.step.result,
    permissionMode: params.permissionMode,
    retentionPolicy: 'resumable',
    runClass: 'long_lived',
    ioMode: 'request_response',
    cwd: executionParams.workspace.directory,
    ...(modelSelection ? { modelId: modelSelection.modelId, modelSelection } : {}),
    ...(selection.sessionConfigOptionOverrides
      ? { sessionConfigOptionOverrides: selection.sessionConfigOptionOverrides }
      : {}),
    ...(selection.mcpSelection !== undefined ? { mcpSelection: selection.mcpSelection } : {}),
    ...(selection.connectedServices !== undefined
      ? { connectedServices: selection.connectedServices }
      : {}),
    ...(selection.acpSessionModeId !== undefined
      ? { acpSessionModeId: selection.acpSessionModeId }
      : {}),
    ...(selection.runtimeDescriptorV1 !== undefined
      ? { runtimeDescriptorV1: selection.runtimeDescriptorV1 }
      : {}),
  };
}

function workflowExecutionRunStartContext(
  context: RpcActionExecutorContext,
  localInputId: string,
  workDepth: number,
): RpcActionExecutorContext {
  return {
    ...context,
    // This creates an already-admitted Workflow Agent leaf. The Action caller
    // still carries its accepted authorization and currentness checks; it is
    // not a new Agent request that would re-admit or increment the Run depth.
    surface: 'rpc',
    agentStartWorkDepth: workDepth + 1,
    actionRequestId: `${localInputId}:execution-run-start`,
  };
}

function resolveWorkflowExecutionPermissionMode(
  params: Pick<Parameters<WorkflowStepExecutor>[0], 'execution' | 'authorization'>,
): string | null {
  const decision = assertNonEscalatingPermissionMode({
    requestedMode: params.execution.permissionMode ?? 'default',
    callerMode: params.authorization.admittedPermissionCeiling,
  });
  return decision.ok ? decision.normalizedMode : null;
}

type DetachedRunPreparationParams = Omit<Parameters<WorkflowStepPreparer>[0], 'producerBinding'>
  & Pick<Parameters<WorkflowStepExecutor>[0], 'producerBinding'>;

async function resolveRetainedConversation(
  deps: WorkflowDetachedExecutionRunStepExecutorDeps,
  params: DetachedRunPreparationParams,
  requestedRuntimeSelection: WorkflowRetainedRuntimeSelectionV1,
): Promise<WorkflowExecutionRunConversation | null> {
  const resolution = resolveWorkflowConversationSelection(params);
  if (resolution.kind === 'unavailable') {
    throw new WorkflowExecutionRunCompositionError('workflow_conversation_unavailable');
  }
  if (resolution.kind === 'observe' || resolution.kind === 'retained') {
    if (resolution.execution.kind !== 'detached_run' || !params.recoveryPreviousWorkspace) {
      throw new WorkflowExecutionRunCompositionError('workflow_conversation_unavailable');
    }
    const execution = resolution.execution;
    if (!areWorkflowRetainedRuntimeSelectionsEqualV1(execution.runtimeSelection, requestedRuntimeSelection)) {
      throw new WorkflowExecutionRunCompositionError('workflow_conversation_unavailable');
    }
    return {
      runId: execution.runId,
      machineId: params.recoveryPreviousWorkspace.machineId,
      directory: params.recoveryPreviousWorkspace.directory,
      runtimeSelection: execution.runtimeSelection,
      ...(execution.providerResumeIdentity ? { providerResumeIdentity: execution.providerResumeIdentity } : {}),
    };
  }
  const selection = resolution.binding;
  if (selection.kind === 'fresh') return null;
  if (selection.kind === 'existing_session' || selection.kind === 'origin_session') {
    throw new WorkflowExecutionRunCompositionError('workflow_conversation_unavailable');
  }
  const conversation = selection.kind === 'shared'
    ? await deps.resolveSharedRunConversation({ runId: params.runId, invocation: params.invocation,
        conversationBinding: selection })
    : await deps.resolveProducerConversation({
        runId: params.runId,
        producer: selection.producer,
        invocation: params.invocation,
        ...(params.producerBinding ? { producerBinding: params.producerBinding } : {}),
      });
  if (!conversation && selection.kind === 'from_step') {
    throw new WorkflowExecutionRunCompositionError('workflow_conversation_unavailable');
  }
  if (conversation) {
    if (!areWorkflowRetainedRuntimeSelectionsEqualV1(
      conversation.runtimeSelection,
      requestedRuntimeSelection,
    )) {
      throw new WorkflowExecutionRunCompositionError('workflow_conversation_unavailable');
    }
  }
  return conversation;
}

const DETACHED_RUN_INAPPLICABLE_SELECTION_FIELDS = [
  'transcriptStorage',
  'terminal',
  'windowsRemoteSessionLaunchMode',
  'windowsRemoteSessionConsole',
  'windowsTerminalWindowName',
] as const;

function assertDetachedRunAuthoringSupported(
  params: DetachedRunPreparationParams,
): void {
  if (DETACHED_RUN_INAPPLICABLE_SELECTION_FIELDS.some((field) => Object.hasOwn(params.execution, field))) {
    throw new WorkflowExecutionRunCompositionError('target_unavailable');
  }
}

function buildWorkflowStructuredInput(
  input: Parameters<WorkflowStepExecutor>[0]['input'],
) {
  if (input.references.length === 0 && input.attachments.length === 0) return undefined;
  return HappierStructuredInputV1Schema.parse({
    v: 1,
    ...(input.references.length > 0 ? { mentions: input.references } : {}),
    ...(input.attachments.length > 0 ? { composerAttachments: input.attachments } : {}),
  });
}

export async function prepareWorkflowDetachedExecutionRunStep(
  deps: WorkflowDetachedExecutionRunStepExecutorDeps,
  params: DetachedRunPreparationParams,
): Promise<PreparedWorkflowDetachedExecutionRun> {
  if (params.invocation.execution) {
    if (params.invocation.execution.kind !== 'detached_run') {
      throw new WorkflowExecutionRunCompositionError('continuation_unavailable');
    }
    return {
      kind: 'workflow_detached_execution_run',
      retainedConversation: null,
      runtimeSelection: params.invocation.execution.runtimeSelection ?? {},
    };
  }
  assertDetachedRunAuthoringSupported(params);
  const permissionMode = resolveWorkflowExecutionPermissionMode(params);
  if (permissionMode === null) {
    throw new WorkflowExecutionRunCompositionError('workflow_permission_escalation_denied');
  }
  const runtimeSelection = projectWorkflowRetainedRuntimeSelectionV1({
    ...params.execution,
    permissionMode,
  });
  return {
    kind: 'workflow_detached_execution_run',
    retainedConversation: await resolveRetainedConversation(
      deps,
      params,
      runtimeSelection,
    ),
    runtimeSelection,
  };
}

/**
 * Native detached-Run workflow leaf. The Action/RPC/bridge owner retains all
 * Agent lifecycle, prompt admission, permission, result and resume semantics;
 * this adapter only binds workflow correspondence and caller-owned durability.
 */
export function createWorkflowDetachedExecutionRunStepExecutor(
  deps: WorkflowDetachedExecutionRunStepExecutorDeps,
): WorkflowStepExecutor {
  return async (params) => {
    const expiresAt = params.invocation.observationDeadline?.kind === 'at'
      ? Date.parse(params.invocation.observationDeadline.expiresAt) : null;
    const deadline = expiresAt !== null || params.step.timeoutMs !== undefined
      ? createWorkflowObservationDeadline(expiresAt) : null;
    try {
      return await execute({
        ...params,
        onInputAccepted: async (execution, acceptedAtMs) => {
          if (acceptedAtMs === undefined) await params.onInputAccepted(execution);
          else await params.onInputAccepted(execution, acceptedAtMs);
          if (acceptedAtMs !== undefined && params.step.timeoutMs !== undefined) {
            deadline?.arm(acceptedAtMs + params.step.timeoutMs);
          }
        },
      }, deadline);
    } finally {
      deadline?.dispose();
    }
  };

  async function execute(
    params: Parameters<WorkflowStepExecutor>[0],
    deadline: WorkflowObservationDeadline | null,
  ): Promise<WorkflowStepExecutionResult> {
    const existing = params.invocation.execution;
    if (existing) {
      if (existing.kind !== 'detached_run') {
        return { kind: 'needs_attention', code: 'continuation_unavailable' };
      }
      return await observeExactRunInput({
        deps, executionParams: params, runId: existing.runId, localInputId: existing.localInputId,
        sessionId: null, context: await actionContextFor(deps, params), deadline,
      });
    }
    const permissionMode = resolveWorkflowExecutionPermissionMode(params);
    if (permissionMode === null) {
      return { kind: 'failed', code: 'workflow_permission_escalation_denied' };
    }
    let prepared: PreparedWorkflowDetachedExecutionRun;
    try {
      prepared = isPreparedWorkflowDetachedExecutionRun(params.preparedStep)
        ? params.preparedStep
        : await prepareWorkflowDetachedExecutionRunStep(deps, params);
    } catch (error) {
      if (error instanceof WorkflowExecutionRunCompositionError) {
        return {
          kind: error.code === 'workflow_permission_escalation_denied' ? 'failed' : 'needs_attention',
          code: error.code,
        };
      }
      throw error;
    }
    const runtimeSelection = prepared.runtimeSelection;
    const retainedConversation = prepared.retainedConversation;
    try {
      // The coordinator holds the owner gate before preparation. Workspace
      // selection and input dispatch must consume that same exact identity.
      if (retainedConversation) validateConversation(retainedConversation, params);
    } catch (error) {
      if (error instanceof WorkflowExecutionRunCompositionError) {
        return { kind: 'needs_attention', code: error.code };
      }
      throw error;
    }
    const localInputId = deriveWorkflowSessionInputLocalIdV2({
      purpose: 'invocation',
      runId: params.runId,
      invocationRecordId: params.invocationRecordId ?? params.invocation.logicalInvocationRecordId,
    });
    const resultContract: ExecutionRunResultContractV1 = params.step.result;
    const structuredInput = buildWorkflowStructuredInput(params.input);
    const context = await actionContextFor(deps, params, { localInputId, runtimeSelection });
    let runId: string;
    let acceptedProviderResumeIdentity: ExecutionRunResumeHandleProviderSessionV1 | undefined;

    if (params.observationOnly) {
      runId = retainedConversation?.runId
        ?? deriveExecutionRunIdFromActionRequestId(`${localInputId}:execution-run-start`);
      return await observeExactRunInput({
        deps,
        executionParams: params,
        runId,
        localInputId,
        sessionId: null,
        context,
        deadline,
      });
    }

    if (retainedConversation) {
      await params.beforeInputAdmission();
      assertWorkflowAdmissionSignal(params.signal);
      const sent = await deps.actionExecutor.execute(
        'execution.run.send',
        {
          sessionId: null,
          runId: retainedConversation.runId,
          message: withWorkflowRoleInstructions(params.input.text, deps.resolveRoleInstructions?.(params)),
          delivery: 'prompt',
          resume: true,
          localInputId,
          resultContract,
          ...(structuredInput ? { structuredInput } : {}),
        },
        context,
      );
      if (sent.ok) {
        runId = retainedConversation.runId;
        acceptedProviderResumeIdentity = retainedConversation.providerResumeIdentity;
      } else {
        if (sent.errorCode !== 'execution_run_not_found') {
          return classifyActionFailure(sent, false, params.signal);
        }
        const selection = params.execution;
        const providerResumeIdentity = retainedConversation.providerResumeIdentity;
        if (!selection.agentTarget || !providerResumeIdentity
          || !areExecutionRunBackendTargetsEqual(
            providerResumeIdentity.backendTarget,
            selection.agentTarget,
          )) {
          return { kind: 'needs_attention', code: 'continuation_unavailable' };
        }
        await params.beforeInputAdmission();
        assertWorkflowAdmissionSignal(params.signal);
        const started = await deps.actionExecutor.execute(
          'execution.run.start',
          {
            ...buildNativeAgentRunStartInput({
              executionParams: params,
              sessionId: null,
              localInputId,
              roleInstructions: deps.resolveRoleInstructions?.(params),
              permissionMode,
            }),
            resumeHandle: providerResumeIdentity,
            ...(structuredInput ? { structuredInput } : {}),
          },
          workflowExecutionRunStartContext(context, localInputId, deps.workDepth),
        );
        if (!started.ok) return classifyActionFailure(started, true, params.signal);
        const payload = ExecutionRunStartResponseSchema.safeParse(started.result);
        if (!payload.success) {
          return { kind: 'outcome_uncertain', code: 'execution_run_start_ambiguous' };
        }
        runId = payload.data.runId;
        acceptedProviderResumeIdentity = providerResumeIdentity;
      }
    } else {
      const selection = params.execution;
      if (!selection.agentTarget) return { kind: 'failed', code: 'target_unavailable' };
      await params.beforeInputAdmission();
      assertWorkflowAdmissionSignal(params.signal);
      const started = await deps.actionExecutor.execute(
        'execution.run.start',
        {
          ...buildNativeAgentRunStartInput({
            executionParams: params,
            sessionId: null,
            localInputId,
            roleInstructions: deps.resolveRoleInstructions?.(params),
            permissionMode,
          }),
          ...(structuredInput ? { structuredInput } : {}),
        },
        workflowExecutionRunStartContext(context, localInputId, deps.workDepth),
      );
      if (!started.ok) return classifyActionFailure(started, true, params.signal);
      const payload = ExecutionRunStartResponseSchema.safeParse(started.result);
      if (!payload.success) {
        return { kind: 'outcome_uncertain', code: 'execution_run_start_ambiguous' };
      }
      runId = payload.data.runId;
    }

    try {
      await params.onInputAccepted({
        kind: 'detached_run', runId, localInputId, runtimeSelection,
        ...(acceptedProviderResumeIdentity ? { providerResumeIdentity: acceptedProviderResumeIdentity } : {}),
      });
    } catch (error) {
      if (params.signal?.aborted && classifyWorkflowAbort(params.signal) !== 'interrupted') {
        await settleOwnedRunInputAfterAbort({
          deps, executionParams: params, runId, localInputId, sessionId: null, context,
        });
      }
      throw error;
    }
    return await observeExactRunInput({
      deps,
      executionParams: params,
      runId,
      localInputId,
      sessionId: null,
      context,
      deadline,
    });
  }
}

/** One origin-neutral selector. Agent identity never decides execution placement. */
export function createWorkflowStepExecutorDispatcher(executors: Readonly<{
  session: WorkflowStepExecutor;
  detachedRun: WorkflowStepExecutor;
}>): WorkflowStepExecutor {
  return async (params) => {
    switch (params.executionTarget.kind) {
      case 'session': return await executors.session(params);
      case 'detached_run': return await executors.detachedRun(params);
    }
  };
}
