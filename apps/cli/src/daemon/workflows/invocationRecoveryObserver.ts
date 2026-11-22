import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionRuntimeSnapshot } from '@/daemon/sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';
import { resolveSessionConfigOptionOverridesFromMetadataSnapshot } from '@/agent/runtime/sessionConfigOptionOverrideSync';
import { buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS, WorkflowSessionAuthoringSelectionSchema } from '@happier-dev/protocol/workflows/workflowV1';
import { SessionOwnerCompatibilityViewV1Schema, readSessionModesMetadata } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { readAppliedSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import type { WorkflowSessionConversation } from './sessionStepExecutor';
import { isAxiosError } from 'axios';
import { discardPendingQueueV2Messages } from '@/api/session/pendingQueueV2Transport';
import type { WorkflowConversationUnavailableDetailsV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { WorkflowRunGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationRunStateV3';
import { SessionContinuationInspectionV1Schema } from '@happier-dev/protocol/sessions/agentTransition';
import type { WorkflowAccountRunActionDeps, WorkflowProgressEnvelopeV1, WorkflowMaterializedLeafV1, WorkflowRunSummaryV1 } from '@happier-dev/protocol';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionErrorClassV1';
import { ActionOperationCompletionOutputV1Schema, resumeActionCompletionV1, readActionCompletionRunObservationV1, isActionCompletionRunObservationPendingV1 } from '@happier-dev/protocol/actions/actionCompletion';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readProjectSetupConsentHoldV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { DaemonAgentInstallStartResponseSchema, MachinesAgentsInstallInputSchema } from '@happier-dev/protocol/daemon/agentInstallJobs';
import { isMachineSetupOperationActionIdV1, SESSION_AGENT_READINESS_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionCompletionOperation, ActionCompletionRun } from '@happier-dev/protocol/actions/actionCompletion';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { cancelSessionInput } from '@/session/services/cancelSessionInput';
import { requestSessionStop } from '@/session/services/requestSessionStop';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { WorkflowInvocationRecoveryObservation } from './recovery';
import { classifyWorkflowSessionInputResult, observeWorkflowDetachedExecutionRunInput, observeWorkflowSessionInputResult, resolveWorkflowDetachedExecutionRunInputTurn } from './stepExecution';
import { observeWorkflowDetachedRunRecovery } from './detachedRunRecovery';
import { readWorkflowActionApprovalSettlement } from './actionApproval';
import { isWorkflowInlineAccountReadWithoutResult } from './actionReadRecovery';
import { WorkflowMachineCommandOutputV1Schema } from '@happier-dev/protocol/workflows/stepActionsV1';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { isSessionStopConfirmed } from '@happier-dev/protocol/sessions/control/contract';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import type { SessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { deriveWorkflowSessionCreationTag } from './workflowSessionStartup';
import { readRetainedWorkflowSessionStartupFailure, readWorkflowSessionStartupError } from './workflowSessionStartupFailure';
import { WorkflowSessionCompositionError } from './workflowConversation';
import { hasLostWorkflowActionOperation, LOST_ACTION_OPERATION_CODE, readWorkflowActionOperationSnapshot } from './actionOperationObservation';

type WorkflowInvocationRecoveryEvidence = Awaited<ReturnType<NonNullable<WorkflowAccountRunActionDeps['observeRecovery']>>>;

function failedOperationObservation(operation: ActionOperationSnapshotV1, sessionStartup: boolean): WorkflowInvocationRecoveryObservation {
  const startup = sessionStartup ? readWorkflowSessionStartupError(operation) : undefined;
  if (startup && !(startup instanceof WorkflowSessionCompositionError)) return { kind: 'unresolved', code: startup.code };
  return { kind: 'failed', code: startup?.code ?? operation.error?.errorCode ?? 'action_operation_failed',
    ...(startup?.failureCause ?? operation.error?.failureCause
      ? { failureCause: startup?.failureCause ?? operation.error?.failureCause } : {}),
    ...(startup?.runtimeIssueV1 ? { runtimeIssueV1: startup.runtimeIssueV1 } : {}),
    ...(operation.error?.error ? { message: operation.error.error } : {}) };
}

type RecoveryActionExecutor = Readonly<{
  execute: (
    actionId: 'execution.run.get' | 'execution.run.stop' | 'approval.request.get',
    input: Readonly<{ sessionId: null; runId: string; includeStructured?: false }> | Readonly<{ artifactId: string }>,
    context: Readonly<{ surface: 'agent'; authority: 'account_automation'; executionRunTargetMachineId: string; signal?: AbortSignal }>,
  ) => Promise<Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; errorCode: string }>>;
}>;

export async function resolveWorkflowAuthorizedSession(params: Readonly<{
  credentials: StoredCredentials; sessionId: string; machineId?: string; signal?: AbortSignal;
  sessionCreationTag?: SessionCreationTagV1;
  onUnavailable?: (details: WorkflowConversationUnavailableDetailsV1) => void;
}>) {
  const target = await resolveSessionTransportContext({ reason: 'session-control',
    credentials: params.credentials, idOrPrefix: params.sessionId,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!target.ok || target.sessionId !== params.sessionId || target.rawSession.id !== params.sessionId) {
    params.onUnavailable?.({ code: 'workflow_conversation_unavailable',
      reason: target.ok ? 'session_identity_mismatch' : target.code === 'encryption_material_unavailable' ? 'account_scope_unavailable' : 'session_unavailable',
      expected: { kind: 'session', ids: [params.sessionId] },
      observed: target.ok ? { kind: 'session', ids: [target.rawSession.id] } : { kind: 'unavailable', ids: [target.code] } });
    return null;
  }
  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    accountEncryptionMode: target.accountEncryptionCurrentness.mode,
    rawSession: target.rawSession,
  });
  if (!metadata || typeof metadata.machineId !== 'string' || !metadata.machineId.trim()
    || (params.machineId !== undefined && metadata.machineId !== params.machineId)) {
    params.onUnavailable?.({ code: 'workflow_conversation_unavailable', reason: metadata ? 'machine_mismatch' : 'owner_metadata_unavailable',
      expected: { kind: 'string', ...(params.machineId ? { ids: [params.machineId] } : {}) },
      observed: metadata && typeof metadata.machineId === 'string'
        ? { kind: 'string', ids: [metadata.machineId] } : { kind: 'unavailable' } });
    return null;
  }
  if (params.sessionCreationTag) {
    const correspondence = SessionCreationCorrespondenceV1ReadSchema.safeParse(metadata.sessionCreationCorrespondenceV1);
    if (!correspondence.success || correspondence.data.sessionCreationTag !== params.sessionCreationTag
      || correspondence.data.recipe.execution.machineId !== metadata.machineId) return null;
  }
  return { target, metadata, machineId: metadata.machineId };
}

/** Authorized owner metadata supplies identity and applied Session state, never list presentation. */
export async function resolveWorkflowSessionConversation(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  machineId?: string;
  signal?: AbortSignal;
  onUnavailable?: (details: WorkflowConversationUnavailableDetailsV1) => void;
}>): Promise<WorkflowSessionConversation | null> {
  const authorized = await resolveWorkflowAuthorizedSession(params);
  if (!authorized) return null;
  const { target, metadata } = authorized;
  if (typeof metadata.path !== 'string' || !metadata.path.trim()) {
    params.onUnavailable?.({ code: 'workflow_conversation_unavailable', reason: 'workspace_unavailable',
      expected: { kind: 'object' }, observed: { kind: 'unset' } });
    return null;
  }
  const directory = resolveSessionWorkspaceRootForMachine({
    metadata, machineId: authorized.machineId, candidatePath: metadata.path,
  }).machinePath;
  const backend = resolveBackendTargetFromSessionMetadata(metadata);
  const declaredTarget = backend ? parseBackendTargetKeyV2(buildBackendTargetKeyV2(backend)) : null;
  const agentTarget = declaredTarget?.kind === 'agent' ? declaredTarget : undefined;
  const selection: Record<string, unknown> = {};
  // Reuse the portable selection schema and field inventory. Metadata-only
  // fields and secrets never become a Workflow witness.
  for (const field of WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS) {
    if (metadata[field] === undefined) continue;
    const parsed = createStoredReadSchema(WorkflowSessionAuthoringSelectionSchema.shape[field]).safeParse(metadata[field]);
    if (parsed.success) selection[field] = parsed.data;
  }
  if (agentTarget) selection.agentTarget = agentTarget;
  const modes = readSessionModesMetadata(metadata);
  if (modes?.currentModeId && modes.agentId === backend?.backendId) {
    selection.acpSessionModeId = modes.currentModeId;
  } else {
    delete selection.acpSessionModeId;
  }
  const config = createStoredReadSchema(SessionOwnerCompatibilityViewV1Schema.shape.sessionConfigOptionsV1).safeParse(metadata.sessionConfigOptionsV1 ?? metadata.acpConfigOptionsV1);
  // Reuse compares the retained launch configuration that Session Pending will
  // carry into the next input. Native Agents may publish models without an ACP
  // config catalog; absence of that optional catalog must not erase this intent.
  const configIntent = resolveSessionConfigOptionOverridesFromMetadataSnapshot({ metadata });
  if (configIntent.length > 0) {
    selection.sessionConfigOptionOverrides = {
      v: 1, updatedAt: Math.max(...configIntent.map(option => option.updatedAt)),
      overrides: Object.fromEntries(configIntent.map(option => [option.configId, {
        updatedAt: option.updatedAt, value: option.valueId,
      }])),
    };
  }
  if (config.success && config.data && config.data.agentId === backend?.backendId) {
    selection.sessionConfigOptionOverrides = {
      v: 1, updatedAt: config.data.updatedAt,
      overrides: Object.fromEntries(config.data.configOptions.map((option) => [option.id, {
        updatedAt: config.data!.updatedAt, value: option.currentValue,
      }])),
    };
  }
  // Pending capability intent is not applied runtime state; its existing owner retains
  // the exact applied selection when a restart is required.
  selection.capabilitySelection = readAppliedSessionCapabilitySelectionFromMetadataV1(metadata);
  const { permissionMode, modelSelection, teamModelSelection } = resolveSessionRuntimeSnapshot({
    incomingOptions: { existingSessionId: target.sessionId, directory },
    persistedMetadata: metadata,
  }).snapshot;
  const sessionRoles = readSessionRolesV1(metadata);
  return {
    sessionId: target.sessionId, machineId: authorized.machineId, directory,
    ...(target.rawSession.origin ? { origin: target.rawSession.origin } : {}),
    ...(target.rawSession.workDepth === undefined ? {} : { workDepth: target.rawSession.workDepth }),
    ...(agentTarget ? { agentTarget } : {}),
    runtimeSelection: WorkflowSessionAuthoringSelectionSchema.parse(selection),
    ...(modes && modes.agentId === backend?.backendId ? { sessionModes: modes } : {}),
    ...(sessionRoles ? { sessionRoles } : {}),
    runtimeSnapshot: { permissionMode, modelSelection, teamModelSelection },
  };
}

/** Exact native facts; the Protocol owner decides which controls they permit. */
export async function observeWorkflowInvocationRecoveryEvidence(params: Readonly<{
  runId: string;
  credentials: StoredCredentials;
  machineId: string;
  progress: WorkflowProgressEnvelopeV1;
  getRun: (request: Readonly<{ runId: string; includeStructured: false }>) => Promise<unknown>;
  getOperation?: (operation: ActionCompletionOperation) => Promise<unknown>;
  getWorkflow?: (runId: string) => Promise<unknown>;
  getApproval?: (artifactId: string) => Promise<unknown>;
  signal?: AbortSignal;
}>): Promise<WorkflowInvocationRecoveryEvidence> {
  const unavailable: WorkflowInvocationRecoveryEvidence = {
    activity: 'unknown', canReattach: false, canContinueConversation: false,
  };
  const execution = params.progress.execution;
  if (!execution || hasLostWorkflowActionOperation(params.progress)) return unavailable;
  if (execution.kind === 'session_ready') return { activity: 'not_active', canReattach: true, canContinueConversation: false };
  try {
    if (execution.kind === 'action') {
      const approval = await readWorkflowActionApprovalSettlement({ runId: params.runId, execution,
        read: async artifactId => await params.getApproval?.(artifactId) });
      if (approval?.kind === 'outcome_uncertain') return unavailable;
      if (approval) return { activity: approval.kind === 'unresolved' ? 'unknown' : 'not_active',
        canReattach: approval.kind !== 'unresolved' || approval.code === 'approval_required', canContinueConversation: false };
      const reason = params.progress.reason;
      if (params.progress.blockKind === 'action' && execution.actionId === 'machines.command.run'
        && reason?.code === 'command_failed' && params.progress.timing?.finishedAt !== undefined) {
        const command = WorkflowMachineCommandOutputV1Schema.safeParse(params.progress.result);
        // A positive process exit is terminal. The -1 fallback also covers
        // refusals without a process result, so it cannot establish inactivity.
        if (command.success && command.data.exitCode > 0) {
          return { activity: 'not_active', canReattach: false, canContinueConversation: false };
        }
      }
      if (params.progress.blockKind === 'action' && reason?.code === 'action_failed'
        && isWorkflowInlineAccountReadWithoutResult(execution)) {
        return { activity: 'not_active', canReattach: false, canContinueConversation: false };
      }
      if (params.progress.blockKind === 'action'
        && execution.actionId === SESSION_AGENT_READINESS_CHILDREN_V1.acquire.action
        && reason?.code === 'native_effect_failed') {
        const install = MachinesAgentsInstallInputSchema.safeParse(execution.input);
        const receipt = DaemonAgentInstallStartResponseSchema.safeParse({
          ok: false, errorCode: reason.code, error: reason.message ?? reason.code, details: params.progress.result,
        });
        // A finite installer's retained terminal receipt proves the job stopped.
        if (install.success && install.data.waitForTerminal === true && receipt.success && !receipt.data.ok
          && receipt.data.errorCode === 'native_effect_failed' && receipt.data.details.outcome.kind === 'failed') {
          return { activity: 'not_active', canReattach: false, canContinueConversation: false };
        }
      }
      if (params.progress.blockKind === 'action' && isMachineSetupOperationActionIdV1(execution.actionId)
        && execution.awaitedOperations?.length === 1) {
        const [target] = execution.awaitedOperations;
        const receipt = ActionOperationCompletionOutputV1Schema.safeParse(params.progress.result);
        const operation = receipt.success ? receipt.data.operation : undefined;
        // The Workflow already retained this exact finite settlement. Another Machine read
        // cannot make the same failed operation active again.
        if (operation?.state === 'failed' && operation.operationId === target.operationId
          && operation.scope.machineId === target.machineId && operation.actionId === execution.actionId
          && operation.requestId === execution.actionRequestId && operation.error?.errorCode === reason?.code) {
          return { activity: 'not_active', canReattach: true, canContinueConversation: false };
        }
      }
      if (execution.awaitedOperations?.length && params.getOperation) {
        const snapshots = await Promise.all(execution.awaitedOperations.map(async (target) => {
          const parsed = ActionOperationGetV1ResponseSchema.safeParse(await params.getOperation!(target));
          if (parsed.success && parsed.data.kind === 'not_found' && params.progress.blockKind === 'step'
            && execution.actionId === 'session.spawn_new' && execution.awaitedOperations?.length === 1
            && target.machineId === params.machineId) {
            const output = execution.output;
            // The strict original startup fact survives its process-local
            // owner. Only authoritative absence permits using that fact;
            // live, malformed or unavailable observations never fall back.
            return readRetainedWorkflowSessionStartupFailure(output && typeof output === 'object' && !Array.isArray(output)
              && 'operation' in output ? output.operation : undefined, target, execution.actionRequestId);
          }
          return parsed.success && parsed.data.kind === 'found' && parsed.data.operation.operationId === target.operationId
            && parsed.data.operation.scope.machineId === target.machineId && parsed.data.operation.actionId === execution.actionId
            ? parsed.data.operation : undefined;
        }));
        if (snapshots.some(snapshot => snapshot === undefined)) return unavailable;
        return { activity: snapshots.some(snapshot => snapshot?.state === 'running') ? 'active'
          : snapshots.some(snapshot => snapshot?.state === 'accepted') ? 'unknown' : 'not_active',
          canReattach: true, canContinueConversation: false };
      }
      if (execution.awaitedWorkflows?.length) {
        if (!params.getWorkflow) return unavailable;
        const snapshots = await Promise.all(execution.awaitedWorkflows.map(async target => {
          const parsed = WorkflowRunGetResultV1Schema.safeParse(await params.getWorkflow!(target.runId));
          return parsed.success && parsed.data.run.id === target.runId ? parsed.data.run : undefined;
        }));
        if (snapshots.some(snapshot => snapshot === undefined)) return unavailable;
        return { activity: snapshots.some(snapshot => snapshot && !isTerminalAutomationRunStateV3(snapshot.state)) ? 'active' : 'not_active',
          canReattach: true, canContinueConversation: false };
      }
      if (!execution.awaitedRuns?.length) return unavailable;
      const snapshots = await Promise.all(execution.awaitedRuns.map(async (run) => {
        const parsed = ExecutionRunGetResponseSchema.safeParse(await params.getRun({ runId: run.runId, includeStructured: false }));
        return parsed.success && parsed.data.run.runId === run.runId ? parsed.data : undefined;
      }));
      if (snapshots.some((snapshot) => snapshot === undefined)) return unavailable;
      return { activity: snapshots.some((snapshot) => snapshot?.run.status === 'running') ? 'active' : 'not_active',
        canReattach: true, canContinueConversation: false };
    }
    if (execution.kind === 'detached_run') {
      const parsed = ExecutionRunGetResponseSchema.safeParse(await params.getRun({ runId: execution.runId, includeStructured: false }));
      if (!parsed.success || parsed.data.run.runId !== execution.runId) return unavailable;
      const nativeRun = parsed.data.run;
      const turn = resolveWorkflowDetachedExecutionRunInputTurn(nativeRun, execution.runId, execution.localInputId);
      return {
        activity: turn ? turn.state === 'active' ? 'active' : 'not_active' : 'unknown',
        canReattach: turn !== null,
        // This is the loaded retained runtime's declaration, not a saved resume
        // handle or a guess based on intent/status/Agent id.
        canContinueConversation: nativeRun.lifecycle?.state === 'current'
          && nativeRun.interaction?.capabilities.delivery.includes('newTurn') === true,
      };
    }
    const machineId = params.progress.workspace?.descriptor?.machineId;
    if (!machineId) return unavailable;
    const authorized = await resolveWorkflowAuthorizedSession({ credentials: params.credentials, machineId,
      sessionId: execution.sessionId, ...(params.signal ? { signal: params.signal } : {}) });
    if (!authorized) return unavailable;
    const observed = await observeWorkflowSessionInputResult({ credentials: params.credentials,
      sessionId: execution.sessionId, localId: execution.localInputId, snapshotAtMs: Date.now(),
      ...(params.signal ? { signal: params.signal } : {}) });
    if (!observed.ok || observed.sessionId !== execution.sessionId || observed.localId !== execution.localInputId) return unavailable;
    const result = classifyWorkflowSessionInputResult(observed.result, observed.replyOutcome);
    const evidence: WorkflowInvocationRecoveryEvidence = {
      // A settled input whose result is unavailable (needs attention) is not running; only a pending one is unobserved.
      activity: result.kind === 'pending' ? 'unknown' : 'not_active',
      canReattach: true, canContinueConversation: false,
    };
    try {
      const { target, metadata } = authorized;
      if (target.rawSession.archivedAt !== null && target.rawSession.archivedAt !== undefined) return evidence;
      const agentId = resolveAgentIdFromSessionMetadata(metadata);
      if (!agentId) return evidence;
      const request = { credentials: params.credentials, machineId, requireCurrentMachine: true,
        ...(params.signal ? { signal: params.signal } : {}) };
      const inspected = SessionContinuationInspectionV1Schema.safeParse(await callExactMachineRpc({ ...request,
        method: RPC_METHODS.SESSION_CONTINUATION_INSPECT,
        authorization: { kind: 'session.read', sessionId: execution.sessionId },
        request: { v: 1, sourceSessionId: execution.sessionId, selection: { v: 1, agentId } },
      }));
      if (!inspected.success || inspected.data.type !== 'available') return evidence;
      const described = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(await callExactMachineRpc({ ...request,
        method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, request: { machineId, selection: 'agents' },
      }));
      const capabilities = described.success ? described.data.projection.agentsById[agentId]?.capabilities?.sessions : undefined;
      if (!capabilities?.delivery.includes('newTurn')) return evidence;
      const canContinueConversation = target.rawSession.active === true
        || (capabilities.open.includes('resume') && Boolean(buildInactiveSessionResumeSpawnOptions({
          sessionId: execution.sessionId, rawSession: target.rawSession, metadata,
        })?.resume));
      return { ...evidence, canContinueConversation };
    } catch {
      // Losing capability inspection does not erase exact settled-input proof.
      return evidence;
    }
  } catch {
    return unavailable;
  }
}

/** Exact observation/stop adapter. It never sends, starts, or resolves a provider handle. */
export function createWorkflowInvocationRecoveryObserver(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  actionExecutor: RecoveryActionExecutor;
  /** Rejoin the existing push-driven receipt observer without replaying the Action. */
  observeApproval?: (input: Readonly<{ artifactId: string; actionRequestId: string; actionId: string;
    signal?: AbortSignal }>) => Promise<unknown>;
  now?: () => number;
  observeSession?: typeof observeWorkflowSessionInputResult;
  cancelSession?: typeof cancelSessionInput;
  observeRun?: typeof observeWorkflowDetachedExecutionRunInput;
  nativeActionOperations?: Readonly<{
    findAction?: (execution: Extract<NonNullable<WorkflowProgressEnvelopeV1['execution']>, { kind: 'action' }>,
      signal?: AbortSignal) => Promise<Readonly<{
        kind: 'found'; target: ActionCompletionOperation; operation: ActionOperationSnapshotV1;
      }> | Readonly<{ kind: 'absent' }> | null>;
    findStartup?: (creationKey: string, signal?: AbortSignal) => Promise<Readonly<{
      kind: 'found'; target: ActionCompletionOperation; operation: ActionOperationSnapshotV1;
    }> | Readonly<{ kind: 'absent' }> | null>;
    findSession?: (input: Readonly<{ runId: string; creationKey: string; signal?: AbortSignal }>) => Promise<string | null>;
    get: (operation: ActionCompletionOperation, signal?: AbortSignal) => Promise<unknown>;
    cancel: (operation: ActionCompletionOperation, signal?: AbortSignal) => Promise<unknown>;
    wait: (operation: ActionCompletionOperation, signal?: AbortSignal) => Promise<unknown>;
  }>;
  nativeActionRuns?: Readonly<{
    get: (runId: string, signal?: AbortSignal) => Promise<unknown>;
    stop: (runId: string, signal?: AbortSignal) => Promise<unknown>;
    wait: (runId: string, signal?: AbortSignal, observation?: ActionCompletionRun['observation']) => Promise<unknown>;
  }>;
  nativeActionWorkflows?: Readonly<{
    get: (runId: string, signal?: AbortSignal) => Promise<unknown>;
    cancel: (runId: string, expectedRevision: number, signal?: AbortSignal) => Promise<unknown>;
    wait: (runId: string, signal?: AbortSignal) => Promise<unknown>;
  }>;
}>) {
  const now = params.now ?? Date.now;
  const observeSession = params.observeSession ?? observeWorkflowSessionInputResult;
  const cancelSession = params.cancelSession ?? cancelSessionInput;
  return async function observe(input: Readonly<{
    progress: import('@happier-dev/protocol').WorkflowProgressEnvelopeV1;
    run?: Readonly<{ id: string; state?: WorkflowRunSummaryV1['state'] }>;
    index?: Readonly<Pick<import('@happier-dev/protocol').WorkflowRunInvocationIndexV1, 'id' | 'lifecycle'>>;
    terminalParent: boolean;
    cancellationRequested: boolean;
    observationOnly?: boolean;
    frozenActionContract?: WorkflowMaterializedLeafV1['actionContract'];
    signal?: AbortSignal;
  }>): Promise<WorkflowInvocationRecoveryObservation> {
    const execution = input.progress.execution;
    if (hasLostWorkflowActionOperation(input.progress)) return { kind: 'outcome_uncertain', code: LOST_ACTION_OPERATION_CODE };
    const stopCreatedSession = async (sessionId: string): Promise<WorkflowInvocationRecoveryObservation> => {
      if (!input.run || !input.index) return { kind: 'unresolved', code: 'workflow_execution_correspondence_missing' };
      // Physical Stop cannot retire a durable queued input: it could otherwise
      // be delivered when this Session resumes. Fence the exact admitted input
      // first, including when its admission acknowledgement was lost.
      try {
        await discardPendingQueueV2Messages({ token: params.credentials.token, sessionId,
          localIds: [deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation',
            runId: input.run.id, invocationRecordId: input.index.id })], reason: 'session_input_cancelled' });
      } catch (error) {
        // Only this exact Pending owner's absence permits physical custody to
        // decide settlement. Denied access and ambiguous delivery stay pending.
        const body: unknown = isAxiosError(error) ? error.response?.data : undefined;
        if (!isAxiosError(error) || error.response?.status !== 404 || !body || typeof body !== 'object'
          || !('error' in body) || body.error !== 'not-found') {
          return { kind: 'unresolved', code: 'session_input_cancel_unavailable' };
        }
      }
      // Stop owns both physical termination and the confirmed-already-stopped
      // receipt. Never use the interrupted claim's observation signal here.
      const stopped = await requestSessionStop({ credentials: params.credentials, idOrPrefix: sessionId,
        stopIntent: 'lifecycle_control' });
      if (!stopped.ok || stopped.sessionId !== sessionId || !isSessionStopConfirmed(stopped)) {
        return { kind: 'unresolved', code: 'workflow_startup_session_stop_unconfirmed' };
      }
      return { kind: 'cancelled', code: 'workflow_startup_session_stopped',
        execution: { kind: 'session_ready', sessionId } };
    };
    const recoverAbsentStartup = async (): Promise<WorkflowInvocationRecoveryObservation> => {
      if (!input.run || !input.index || !params.nativeActionOperations?.findSession) {
        return { kind: 'unresolved', code: 'workflow_execution_correspondence_missing' };
      }
      const creationKey = `workflow:${input.run.id}:${input.index.id}`;
      const sessionId = await params.nativeActionOperations.findSession({ runId: input.run.id, creationKey,
        ...(input.signal ? { signal: input.signal } : {}) });
      if (!sessionId) return { kind: 'outcome_uncertain', code: 'workflow_startup_owner_absent' };
      const learned = { kind: 'session' as const, sessionId, localInputId: deriveWorkflowSessionInputLocalIdV2({
        purpose: 'invocation', runId: input.run.id, invocationRecordId: input.index.id }) };
      const stopping = (input.terminalParent || input.cancellationRequested) && !input.observationOnly;
      const observed = await observe({ ...input, ...(stopping ? { observationOnly: true } : {}),
        progress: { ...input.progress, execution: learned } });
      if (observed.kind === 'unresolved' && stopping) {
        const stopped = await stopCreatedSession(sessionId);
        return stopped.kind === 'cancelled' ? { ...stopped, kind: 'stopped', code: 'workflow_startup_session_stopped' }
          : { ...stopped, execution: learned };
      }
      return { ...observed, execution: observed.execution ?? learned };
    };
    if (!execution) {
      // Action leaves commit correspondence before dispatch. If that CAS
      // fails without storing it, the coordinator never releases the effect.
      // Retire only terminal custody; preserve the recorded uncertain outcome.
      if (input.terminalParent && input.progress.blockKind === 'action' && input.index?.lifecycle === 'outcome_uncertain') {
        return { kind: 'outcome_uncertain', code: 'workflow_execution_correspondence_missing' };
      }
      // An in-flight startup can fail before the Workflow observes its
      // accepted reply. An absent original owner closes observation only after
      // Session discovery; it proves neither cancellation nor lack of effects.
      if ((input.terminalParent || input.cancellationRequested || input.run?.state === 'interrupted') && input.progress.blockKind === 'step'
        && input.run && input.index && params.nativeActionOperations?.findStartup) {
        const creationKey = `workflow:${input.run.id}:${input.index.id}`;
        try {
          const startup = await params.nativeActionOperations.findStartup(creationKey, input.signal);
          if (startup?.kind === 'absent') return input.terminalParent || input.cancellationRequested
            ? await recoverAbsentStartup() : { kind: 'unresolved', code: 'workflow_execution_correspondence_missing' };
          if (startup?.kind === 'found' && startup.operation.actionId === 'session.spawn_new' && startup.operation.requestId === creationKey
            && startup.operation.scope.machineId === params.machineId && startup.target.machineId === params.machineId
            && startup.target.operationId === startup.operation.operationId) {
            const learned = { kind: 'action' as const, actionId: 'session.spawn_new', actionRequestId: creationKey,
              localInputId: creationKey, input: { creationKey }, output: projectNativeJsonValueForTransport({ operation: startup.operation }),
              awaitedOperations: [startup.target] };
            const observed = await observe({ ...input, progress: { ...input.progress, execution: learned } });
            return { ...observed, execution: observed.execution ?? learned };
          }
        } catch { input.signal?.throwIfAborted(); }
      }
      return { kind: 'unresolved', code: 'workflow_execution_correspondence_missing' };
    }
    if (execution.kind === 'session_ready') return { kind: 'completed', result: '' };
    if (execution.kind === 'action') {
      const approval = input.run ? await readWorkflowActionApprovalSettlement({ runId: input.run.id, execution, read: async artifactId => {
        const observed = await params.actionExecutor.execute('approval.request.get', { artifactId }, {
          surface: 'agent', authority: 'account_automation', executionRunTargetMachineId: params.machineId,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return observed.ok ? observed.result : null;
      } }) : ActionApprovalRequestCreatedResultSchema.safeParse(execution.output).success
        ? { kind: 'unresolved' as const, code: 'approval_unavailable' } : null;
      if (approval) {
        if (approval.kind === 'unresolved' && approval.code === 'approval_required'
          && !input.observationOnly && params.observeApproval) {
          const receipt = ActionApprovalRequestCreatedResultSchema.parse(execution.output);
          return { ...approval, waitForCompletion: async () => {
            await params.observeApproval!({ artifactId: receipt.artifactId,
              actionRequestId: execution.actionRequestId, actionId: receipt.actionId,
              ...(input.signal ? { signal: input.signal } : {}) });
          } };
        }
        if (input.progress.blockKind === 'step' && execution.actionId === 'discussion.invite' && approval.kind === 'completed') {
          // A reserved slot is not a Session or a completed Workflow input.
          // Rejoin the original step's ordinary creation/admission owner.
          return input.terminalParent || input.cancellationRequested ? { kind: 'stopped', code: 'cancelled' }
            : { kind: 'unresolved', code: 'workflow_native_startup_ready' };
        }
        return approval;
      }
      const id = ActionIdSchema.safeParse(execution.actionId);
      // Native work can start before returning an acceptance/output envelope.
      // The durable Action request identity still names that original owner;
      // losing its observer never authorizes replay or unsolicited cancellation.
      if (input.progress.blockKind === 'action' && id.success && getActionSpec(id.data).operation
        && resolveActionExecutionPlacementForInput(getActionSpec(id.data), execution.input, { kind: 'workflowRun' }, 'agent') === 'machine' && !execution.awaitedOperations?.length
        && !execution.awaitedRuns?.length && !execution.awaitedWorkflows?.length && execution.output === undefined && params.nativeActionOperations?.findAction) {
        try {
          const found = await params.nativeActionOperations.findAction(execution, input.signal);
          // Positive absence retires observation custody, never proves what
          // historical effects occurred or authorizes replaying the Action.
          if (found?.kind === 'absent') return { kind: 'outcome_uncertain', code: LOST_ACTION_OPERATION_CODE };
          if (found?.kind === 'found' && found.operation.actionId === execution.actionId
            && found.operation.requestId === execution.actionRequestId
            && found.operation.scope.machineId === found.target.machineId
            && found.operation.operationId === found.target.operationId) {
            const learned = { ...execution, awaitedOperations: [found.target] };
            const observed = await observe({ ...input, progress: { ...input.progress, execution: learned } });
            return { ...observed, execution: observed.execution ?? learned };
          }
        } catch { input.signal?.throwIfAborted(); }
        // No exact receipt is not proof that an admitted effect stopped.
        return { kind: 'unresolved', code: 'action_operation_observation_unavailable' };
      }
      if (execution.awaitedOperations?.length) {
        if (!id.success) {
          return { kind: 'outcome_uncertain', code: 'outcome_uncertain' };
        }
        const transport = params.nativeActionOperations;
        if (!transport) return { kind: 'unresolved', code: 'action_operation_observation_unavailable' };
        try {
          const read = (raw: unknown, target: ActionCompletionOperation) => readWorkflowActionOperationSnapshot(raw, target,
            { actionId: execution.actionId, ...(input.progress.blockKind === 'step' && execution.actionId === 'session.spawn_new'
              ? { startupRequestId: execution.actionRequestId } : {}) });
          const snapshots = await Promise.all(execution.awaitedOperations.map(async (target) => ({ target,
            raw: await transport.get(target, input.signal) })));
          // Persisted startup correspondence can outlive the process-local
          // operation just as the pre-response row can. Only its exact local
          // owner may establish absence; foreign/misrouted evidence stays pending.
          if (input.progress.blockKind === 'step' && execution.actionId === 'session.spawn_new'
            && input.run && input.index && execution.actionRequestId === `workflow:${input.run.id}:${input.index.id}`
            && snapshots.length === 1 && snapshots[0]!.target.machineId === params.machineId
            && ActionOperationGetV1ResponseSchema.parse(snapshots[0]!.raw).kind === 'not_found') {
            const output = execution.output;
            const failed = readRetainedWorkflowSessionStartupFailure(output && typeof output === 'object' && !Array.isArray(output) && 'operation' in output
              ? output.operation : undefined, snapshots[0]!.target, execution.actionRequestId);
            if (failed) return failedOperationObservation(failed, true);
            return await recoverAbsentStartup();
          }
          const observedOperations = snapshots.flatMap(({ target, raw }) => {
            const operation = read(raw, target);
            return operation ? [{ target, operation }] : [];
          });
          const uncertain = observedOperations.find(({ operation }) => operation.observation?.kind === 'outcome_uncertain');
          if (uncertain) return { kind: 'outcome_uncertain', code: uncertain.operation.observation!.code };
          if (!input.terminalParent && !input.cancellationRequested) {
            for (const { operation } of observedOperations) {
              const consent = readProjectSetupConsentHoldV1(execution.actionId, { operation });
              if (consent) return { kind: 'unresolved', code: consent.code, setupConsentOutput: { operation } };
            }
          }
          const pending = observedOperations.filter(({ operation }) => (operation.state === 'accepted' || operation.state === 'running')
            && (!operation.setupReview || input.terminalParent || input.cancellationRequested));
          if (pending.length) {
            if (!input.observationOnly && (input.terminalParent || input.cancellationRequested)) {
              // A requested/refused/lost stop is never terminal process evidence.
              await Promise.allSettled(pending.map(({ target }) => transport.cancel(target, input.signal)));
            }
            return { kind: 'unresolved', code: 'action_operation_pending', ...(!input.observationOnly ? {
              waitForCompletion: async () => {
                await Promise.all(pending.map(async ({ target }) => {
                  const operation = read(await transport.wait(target, input.signal), target);
                  if (operation && (operation.state === 'accepted' || operation.state === 'running')) throw new Error('action_operation_pending');
                }));
              },
            } : {}) };
          }
          // Missing historical output cannot retire a still-live sibling. The
          // existing pending wait above drains its custody before recording loss.
          if (observedOperations.length !== snapshots.length) return { kind: 'outcome_uncertain', code: LOST_ACTION_OPERATION_CODE };
          if (execution.output === undefined) {
            const failed = observedOperations.find(({ operation }) => operation.state === 'failed');
            if (failed) return failedOperationObservation(failed.operation,
              input.progress.blockKind === 'step' && execution.actionId === 'session.spawn_new');
            if (observedOperations.some(({ operation }) => operation.state === 'cancelled')) return { kind: 'cancelled', code: 'cancelled' };
            // A projected native receipt proves settlement, but cannot recreate
            // a lost Action result/acceptance envelope for completion adapters.
            return { kind: 'outcome_uncertain', code: 'outcome_uncertain' };
          }
          // A step's cold-start operation owns startup, not its input result.
          // Open control still needs the retained executor's exact input;
          // closed control must first handle any Session created by startup.
          if (input.progress.blockKind === 'step') {
            const failed = observedOperations.find(({ operation }) => operation.state === 'failed');
            if (failed) return failedOperationObservation(failed.operation, execution.actionId === 'session.spawn_new');
            if (observedOperations.some(({ operation }) => operation.state === 'cancelled')) return { kind: 'cancelled', code: 'cancelled' };
            if (execution.actionId === 'session.spawn_new' && input.run && input.index
              && execution.actionRequestId === `workflow:${input.run.id}:${input.index.id}`
              && observedOperations.length === 1) {
              const { operation } = observedOperations[0]!;
              const result = operation.result;
              if (operation.requestId !== execution.actionRequestId || !result || typeof result !== 'object'
                || Array.isArray(result) || !('sessionId' in result) || typeof result.sessionId !== 'string' || !result.sessionId) {
                throw new Error('action_operation_correspondence_mismatch');
              }
              const authorized = await resolveWorkflowAuthorizedSession({ credentials: params.credentials,
                sessionId: result.sessionId, machineId: params.machineId,
                sessionCreationTag: deriveWorkflowSessionCreationTag(observedOperations[0]!.target.serverId,
                  input.run.id, execution.actionRequestId),
                ...(input.signal ? { signal: input.signal } : {}) });
              if (!authorized) return { kind: 'unresolved', code: 'workflow_startup_session_unavailable' };
              if (input.observationOnly || (!input.terminalParent && !input.cancellationRequested)) {
                // A lost admission acknowledgement can leave startup correspondence
                // even though the exact Workflow input reached this Session. Startup
                // success alone is never its result: reuse the exact input observer.
                const learned = { kind: 'session' as const, sessionId: result.sessionId,
                  localInputId: deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation',
                    runId: input.run.id, invocationRecordId: input.index.id }) };
                const observed = await observe({ ...input, progress: { ...input.progress, execution: learned } });
                return { ...observed, execution: observed.execution ?? learned };
              }
              // Startup may outlive Cancel without admitting the Workflow input.
              // Stop the exact newly-created Session through its physical-stop
              // owner; a requested or unconfirmed stop does not settle custody.
              return await stopCreatedSession(result.sessionId);
            }
            return { kind: 'unresolved', code: 'workflow_native_startup_ready' };
          }
          if (!input.frozenActionContract?.completion) return { kind: 'outcome_uncertain', code: 'outcome_uncertain' };
          const completion = await resumeActionCompletionV1({ actionId: execution.actionId,
            completion: input.frozenActionContract.completion,
            context: { input: execution.input },
            state: { output: execution.output, awaitedOperations: execution.awaitedOperations },
            resolveDeclaration: () => getActionSpec(id.data).completion,
            observeOperation: async (target) => observedOperations.find((entry) => entry.target.key === target.key
              && entry.target.operationId === target.operationId && entry.target.serverId === target.serverId
              && entry.target.machineId === target.machineId)?.operation,
          });
          if (completion.kind === 'failed') {
            const consent = readProjectSetupConsentHoldV1(execution.actionId, completion.value);
            const output = ProjectCommandActionOutputV1Schema.safeParse(completion.value);
            if (consent && output.success) return { kind: 'unresolved', code: consent.code, setupConsentOutput: output.data };
            return { kind: 'failed', code: completion.errorCode,
              ...(completion.value === undefined ? {} : { result: completion.value }),
              ...(completion.error === undefined ? {} : { message: completion.error }),
              ...(completion.failureCause ? { failureCause: completion.failureCause } : {}) };
          }
          return completion.kind === 'completed' ? { kind: 'completed', result: completion.value }
            : { kind: completion.kind, code: completion.errorCode };
        } catch { return { kind: 'unresolved', code: 'action_operation_observation_unavailable' }; }
      }
      if (execution.awaitedWorkflows?.length) {
        if (!id.success || execution.output === undefined || !input.frozenActionContract?.completion) {
          return { kind: 'outcome_uncertain', code: 'outcome_uncertain' };
        }
        const transport = params.nativeActionWorkflows;
        if (!transport) return { kind: 'unresolved', code: 'target_unavailable' };
        try {
          const snapshots = await Promise.all(execution.awaitedWorkflows.map(async target => {
            const native = WorkflowRunGetResultV1Schema.parse(await transport.get(target.runId, input.signal));
            if (native.run.id !== target.runId) throw new Error('workflow_correspondence_mismatch');
            return { ...target, native };
          }));
          const active = snapshots.filter(({ native }) => !isTerminalAutomationRunStateV3(native.run.state));
          if (active.length) {
            if (!input.observationOnly && (input.terminalParent || input.cancellationRequested)) {
              await Promise.allSettled(active.map(({ runId, native }) => transport.cancel(runId, native.run.revision, input.signal)));
            }
            return { kind: 'unresolved', code: 'workflow_outcome_unresolved', ...(!input.observationOnly ? { waitForCompletion: async () => {
              // The native wait wakes reconciliation; only the completion owner settles it.
              await Promise.all(active.map(target => transport.wait(target.runId, input.signal)));
            } } : {}) };
          }
          const completion = await resumeActionCompletionV1({ actionId: execution.actionId, completion: input.frozenActionContract.completion,
            context: { input: execution.input }, state: { output: execution.output, awaitedWorkflows: execution.awaitedWorkflows },
            resolveDeclaration: () => getActionSpec(id.data).completion, observeWorkflow: async target => {
              const observed = snapshots.find(snapshot => snapshot.key === target.key && snapshot.runId === target.runId);
              if (!observed) throw new Error('workflow_correspondence_mismatch');
              return { observation: 'terminal', matchedCondition: 'terminal', run: observed.native.run,
                ...(observed.native.result === undefined ? {} : { result: observed.native.result }) };
            } });
          return completion.kind === 'completed' ? { kind: 'completed', result: completion.value }
            : { kind: completion.kind, code: completion.errorCode };
        } catch (error) { input.signal?.throwIfAborted(); return { kind: 'unresolved', code: readActionErrorCodeV1(error) ?? 'action_failed' }; }
      }
      if (!id.success || !execution.awaitedRuns?.length || execution.output === undefined || !input.frozenActionContract?.completion) {
        return { kind: 'outcome_uncertain', code: 'outcome_uncertain' };
      }
      if (!params.nativeActionRuns) return { kind: 'unresolved', code: 'execution_run_observation_unavailable' };
      try {
        const snapshots = await Promise.all(execution.awaitedRuns.map(async (run) => {
          const parsed = ExecutionRunGetResponseSchema.safeParse(await params.nativeActionRuns!.get(run.runId, input.signal));
          if (!parsed.success || parsed.data.run.runId !== run.runId) throw new Error('execution_run_correspondence_mismatch');
          return { ...run, native: parsed.data };
        }));
        const active = snapshots.filter(({ native, observation }) => native.run.status === 'running'
          && (!observation || isActionCompletionRunObservationPendingV1(readActionCompletionRunObservationV1(native, observation))));
        if (active.length) {
          let stopUnavailable = false;
          if (!input.observationOnly && (input.terminalParent || input.cancellationRequested)) {
            const stopped = await Promise.allSettled(active.map(async ({ runId }) => await params.nativeActionRuns!.stop(runId, input.signal)));
            stopUnavailable = stopped.some((result) => result.status === 'rejected');
          }
          // Stop acceptance is not terminal proof. The indexed recovery owner
          // retains this exact native wait even if the Stop response was lost.
          return { kind: 'unresolved', code: stopUnavailable ? 'execution_run_observation_unavailable' : 'execution_run_input_pending',
            ...(!input.observationOnly ? { waitForCompletion: async () => {
              const waited = await Promise.allSettled(active.map(async ({ runId, observation }) => {
                const parsed = ExecutionRunGetResponseSchema.safeParse(await params.nativeActionRuns!.wait(runId, input.signal, observation));
                if (!parsed.success || parsed.data.run.runId !== runId
                  || isActionCompletionRunObservationPendingV1(readActionCompletionRunObservationV1(parsed.data, observation))) {
                  throw new Error('execution_run_terminal_observation_unavailable');
                }
              }));
              for (const result of waited) if (result.status === 'rejected') throw result.reason;
            } } : {}),
          };
        }
        const completion = await resumeActionCompletionV1({ actionId: execution.actionId, completion: input.frozenActionContract.completion,
          context: { input: execution.input },
          state: { output: execution.output, awaitedRuns: execution.awaitedRuns },
          resolveDeclaration: () => getActionSpec(id.data).completion,
          observeRun: async (run) => {
            const snapshot = snapshots.find((entry) => entry.runId === run.runId && entry.key === run.key);
            return snapshot ? readActionCompletionRunObservationV1(snapshot.native, run.observation)
              : { kind: 'outcome_uncertain', code: 'execution_run_correspondence_mismatch' };
          } });
        return completion.kind === 'completed' ? { kind: 'completed', result: completion.value }
          : { kind: completion.kind, code: completion.errorCode,
            ...(completion.kind === 'failed' && completion.error !== undefined ? { message: completion.error } : {}) };
      } catch { return { kind: 'unresolved', code: 'execution_run_observation_unavailable' }; }
    }
    if (execution.kind === 'session') {
      let observed: Awaited<ReturnType<typeof observeSession>>;
      try {
        observed = await observeSession({
          credentials: params.credentials,
          sessionId: execution.sessionId,
          localId: execution.localInputId,
          snapshotAtMs: now(),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch {
        return { kind: 'unresolved', code: 'session_input_result_read_failed' };
      }
      if (!observed.ok) return { kind: 'unresolved', code: observed.code };
      const completion = input.observationOnly ? {} : {
        // Stop acknowledgement/refusal is not a terminal fact. Keep the same
        // exact input reader attached to its existing event source so a later
        // terminal wakes indexed recovery, including a lost Stop response.
        waitForCompletion: async () => {
          const settled = await observeSession({ credentials: params.credentials,
            sessionId: execution.sessionId, localId: execution.localInputId,
            ...(input.run?.state === 'cancelled' ? { observeReply: false } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          if (!settled.ok || settled.sessionId !== execution.sessionId || settled.localId !== execution.localInputId
            || classifyWorkflowSessionInputResult(settled.result, settled.replyOutcome).kind === 'pending') {
            throw new Error('session_input_terminal_observation_unavailable');
          }
        },
      };
      const result = classifyWorkflowSessionInputResult(observed.result, observed.replyOutcome);
      if (result.kind === 'pending' && input.run?.state === 'cancelled' && !input.observationOnly) {
        // Original reply custody may be unknown after a Discussion participant
        // is archived. Read physical custody through the same exact-input owner;
        // this cannot settle publication or substitute an unbound final answer.
        try {
          const physical = await observeSession({ credentials: params.credentials,
            sessionId: execution.sessionId, localId: execution.localInputId,
            observeReply: false, snapshotAtMs: now(),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          if (physical.ok && physical.sessionId === execution.sessionId && physical.localId === execution.localInputId) {
            const custody = classifyWorkflowSessionInputResult(physical.result, physical.replyOutcome);
            if (custody.kind === 'needs_attention') return { ...custody, kind: 'stopped' };
          }
        } catch {
          input.signal?.throwIfAborted();
        }
      }
      switch (result.kind) {
        case 'completed': return result;
        case 'failed': return result;
        case 'needs_attention':
          // The exact input is terminal even when no result can be recovered.
          // Cancel ends that result obligation; preserve its missing-result
          // evidence while retiring physical custody through the stopped arm.
          return input.run?.state === 'cancelled' && !input.observationOnly
            ? { ...result, kind: 'stopped' } : result;
        case 'pending':
          if (input.observationOnly || (!input.terminalParent && !input.cancellationRequested)) {
            return { kind: 'unresolved', code: 'session_input_pending', ...completion };
          }
          break;
        case 'cancelled': return { ...result, code: 'session_input_cancelled' };
      }
      let cancelled: Awaited<ReturnType<typeof cancelSession>>;
      try {
        const machineId = input.progress.workspace?.descriptor?.machineId;
        if (!machineId || !await resolveWorkflowAuthorizedSession({ credentials: params.credentials,
          sessionId: execution.sessionId, machineId })) {
          return { kind: 'unresolved', code: 'workflow_conversation_unavailable', ...completion };
        }
        cancelled = await cancelSession({
          credentials: params.credentials,
          sessionId: execution.sessionId,
          localId: execution.localInputId,
        });
      } catch {
        return { kind: 'unresolved', code: 'session_input_cancel_unavailable', ...completion };
      }
      switch (cancelled.kind) {
        case 'pending_retired': return { kind: 'cancelled', code: 'session_input_pending_retired' };
        // Acknowledging a stop is not exact terminal evidence.
        case 'turn_cancel_requested': return { kind: 'unresolved', code: 'session_input_turn_cancel_requested', ...completion };
        case 'turn_cancel_refused':
        case 'turn_cancel_unavailable': return { kind: 'unresolved', code: cancelled.code, ...completion };
      }
    }

    return await observeWorkflowDetachedRunRecovery(params, { ...input, execution });
  };
}
