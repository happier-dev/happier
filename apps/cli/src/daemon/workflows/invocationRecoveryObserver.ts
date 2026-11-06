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
import { SessionContinuationInspectionV1Schema } from '@happier-dev/protocol/sessions/agentTransition';
import type { WorkflowAccountRunActionDeps, WorkflowProgressEnvelopeV1, WorkflowMaterializedLeafV1, WorkflowRunSummaryV1 } from '@happier-dev/protocol';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { resumeActionCompletionV1, readActionCompletionRunObservationV1, isActionCompletionRunObservationPendingV1 } from '@happier-dev/protocol/actions/actionCompletion';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { readProjectSetupConsentHoldV1 } from '@happier-dev/protocol/actions/projectActionFamily';
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
import { classifyWorkflowSessionInputResult, observeWorkflowDetachedExecutionRunInput, observeWorkflowSessionInputResult, resolveWorkflowDetachedExecutionRunInputTurn, stopWorkflowPendingExecutionRunInput } from './stepExecution';
import { readWorkflowActionApprovalSettlement } from './actionApproval';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { isSessionStopConfirmed } from '@happier-dev/protocol/sessions/control/contract';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import type { SessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { deriveWorkflowSessionCreationTag } from './workflowSessionStartup';
import { readRetainedWorkflowSessionStartupFailure } from './workflowSessionStartupFailure';

type WorkflowInvocationRecoveryEvidence = Awaited<ReturnType<NonNullable<WorkflowAccountRunActionDeps['observeRecovery']>>>;

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
  const { permissionMode, modelSelection } = resolveSessionRuntimeSnapshot({
    incomingOptions: { existingSessionId: target.sessionId, directory: metadata.path },
    persistedMetadata: metadata,
  }).snapshot;
  const sessionRoles = readSessionRolesV1(metadata);
  return {
    sessionId: target.sessionId, machineId: authorized.machineId, directory: metadata.path,
    ...(target.rawSession.origin ? { origin: target.rawSession.origin } : {}),
    ...(target.rawSession.workDepth === undefined ? {} : { workDepth: target.rawSession.workDepth }),
    ...(agentTarget ? { agentTarget } : {}),
    runtimeSelection: WorkflowSessionAuthoringSelectionSchema.parse(selection),
    ...(modes && modes.agentId === backend?.backendId ? { sessionModes: modes } : {}),
    ...(sessionRoles ? { sessionRoles } : {}),
    runtimeSnapshot: { permissionMode, modelSelection },
  };
}

/** Fresh exact native facts only; the Protocol owner decides which controls they permit. */
export async function observeWorkflowInvocationRecoveryEvidence(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  progress: WorkflowProgressEnvelopeV1;
  getRun: (request: Readonly<{ runId: string; includeStructured: false }>) => Promise<unknown>;
  getOperation?: (operation: ActionCompletionOperation) => Promise<unknown>;
  getApproval?: (artifactId: string) => Promise<unknown>;
  signal?: AbortSignal;
}>): Promise<WorkflowInvocationRecoveryEvidence> {
  const unavailable: WorkflowInvocationRecoveryEvidence = {
    activity: 'unknown', canReattach: false, canContinueConversation: false,
  };
  const execution = params.progress.execution;
  if (!execution) return unavailable;
  if (execution.kind === 'session_ready') return { activity: 'not_active', canReattach: true, canContinueConversation: false };
  try {
    if (execution.kind === 'action') {
      const approval = await readWorkflowActionApprovalSettlement({ execution,
        read: async artifactId => await params.getApproval?.(artifactId) });
      if (approval) return { activity: approval.kind === 'unresolved' ? 'unknown' : 'not_active',
        canReattach: approval.kind !== 'unresolved' || approval.code === 'approval_required', canContinueConversation: false };
      if (execution.awaitedOperations?.length && params.getOperation) {
        const snapshots = await Promise.all(execution.awaitedOperations.map(async (target) => {
          const parsed = ActionOperationGetV1ResponseSchema.safeParse(await params.getOperation!(target));
          return parsed.success && parsed.data.kind === 'found' && parsed.data.operation.operationId === target.operationId
            && parsed.data.operation.scope.machineId === target.machineId && parsed.data.operation.actionId === execution.actionId
            ? parsed.data.operation : undefined;
        }));
        if (snapshots.some(snapshot => snapshot === undefined)) return unavailable;
        return { activity: snapshots.some(snapshot => snapshot?.state === 'running') ? 'active'
          : snapshots.some(snapshot => snapshot?.state === 'accepted') ? 'unknown' : 'not_active',
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
      sessionId: execution.sessionId, localId: execution.localInputId, deadlineMs: Date.now(),
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
}>) {
  const now = params.now ?? Date.now;
  const observeSession = params.observeSession ?? observeWorkflowSessionInputResult;
  const cancelSession = params.cancelSession ?? cancelSessionInput;
  const observeRun = params.observeRun ?? observeWorkflowDetachedExecutionRunInput;
  return async function observe(input: Readonly<{
    progress: import('@happier-dev/protocol').WorkflowProgressEnvelopeV1;
    run?: Readonly<{ id: string; state?: WorkflowRunSummaryV1['state'] }>;
    index?: Readonly<{ id: string }>;
    terminalParent: boolean;
    cancellationRequested: boolean;
    observationOnly?: boolean;
    frozenActionContract?: WorkflowMaterializedLeafV1['actionContract'];
    signal?: AbortSignal;
  }>): Promise<WorkflowInvocationRecoveryObservation> {
    const execution = input.progress.execution;
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
      const approval = await readWorkflowActionApprovalSettlement({ execution, read: async artifactId => {
        const observed = await params.actionExecutor.execute('approval.request.get', { artifactId }, {
          surface: 'agent', authority: 'account_automation', executionRunTargetMachineId: params.machineId,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return observed.ok ? observed.result : null;
      } });
      if (approval) {
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
        && resolveActionExecutionPlacementForInput(getActionSpec(id.data), execution.input) === 'machine' && !execution.awaitedOperations?.length
        && !execution.awaitedRuns?.length && execution.output === undefined && params.nativeActionOperations?.findAction) {
        try {
          const found = await params.nativeActionOperations.findAction(execution, input.signal);
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
          const read = (raw: unknown, target: ActionCompletionOperation) => {
            const parsed = ActionOperationGetV1ResponseSchema.parse(raw);
            if (parsed.kind !== 'found' || parsed.operation.operationId !== target.operationId
              || parsed.operation.scope.machineId !== target.machineId || parsed.operation.actionId !== execution.actionId
              || (input.progress.blockKind === 'step' && execution.actionId === 'session.spawn_new'
                && parsed.operation.requestId !== execution.actionRequestId)) {
              throw new Error('action_operation_correspondence_mismatch');
            }
            return parsed.operation;
          };
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
            if (failed) return { kind: 'failed', code: failed.error?.errorCode ?? 'action_operation_failed',
              ...(failed.error?.failureCause ? { failureCause: failed.error.failureCause } : {}),
              ...(failed.error?.error ? { message: failed.error.error } : {}) };
            return await recoverAbsentStartup();
          }
          const observedOperations = snapshots.map(({ target, raw }) => ({ target, operation: read(raw, target) }));
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
                  if (operation.state === 'accepted' || operation.state === 'running') throw new Error('action_operation_pending');
                }));
              },
            } : {}) };
          }
          if (execution.output === undefined) {
            const failed = observedOperations.find(({ operation }) => operation.state === 'failed');
            if (failed) return { kind: 'failed', code: failed.operation.error?.errorCode ?? 'action_operation_failed',
              ...(failed.operation.error?.failureCause ? { failureCause: failed.operation.error.failureCause } : {}),
              ...(failed.operation.error?.error ? { message: failed.operation.error.error } : {}) };
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
            if (failed) return { kind: 'failed', code: failed.operation.error?.errorCode ?? 'action_operation_failed',
              ...(failed.operation.error?.failureCause ? { failureCause: failed.operation.error.failureCause } : {}),
              ...(failed.operation.error?.error ? { message: failed.operation.error.error } : {}) };
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
          }
          return completion.kind === 'completed' ? { kind: 'completed', result: completion.value }
            : { kind: completion.kind, code: completion.errorCode,
              ...(completion.kind === 'failed' && completion.failureCause ? { failureCause: completion.failureCause } : {}) };
        } catch { return { kind: 'unresolved', code: 'action_operation_observation_unavailable' }; }
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
          state: { output: execution.output, awaitedRuns: execution.awaitedRuns },
          resolveDeclaration: () => getActionSpec(id.data).completion,
          observeRun: async (run) => {
            const snapshot = snapshots.find((entry) => entry.runId === run.runId && entry.key === run.key);
            return snapshot ? readActionCompletionRunObservationV1(snapshot.native, run.observation)
              : { kind: 'outcome_uncertain', code: 'execution_run_correspondence_mismatch' };
          } });
        return completion.kind === 'completed' ? { kind: 'completed', result: completion.value }
          : { kind: completion.kind, code: completion.errorCode };
      } catch { return { kind: 'unresolved', code: 'execution_run_observation_unavailable' }; }
    }
    if (execution.kind === 'session') {
      let observed: Awaited<ReturnType<typeof observeSession>>;
      try {
        observed = await observeSession({
          credentials: params.credentials,
          sessionId: execution.sessionId,
          localId: execution.localInputId,
          deadlineMs: now(),
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
            ...(input.signal ? { signal: input.signal } : {}),
          });
          if (!settled.ok || settled.sessionId !== execution.sessionId || settled.localId !== execution.localInputId
            || classifyWorkflowSessionInputResult(settled.result, settled.replyOutcome).kind === 'pending') {
            throw new Error('session_input_terminal_observation_unavailable');
          }
        },
      };
      const result = classifyWorkflowSessionInputResult(observed.result, observed.replyOutcome);
      switch (result.kind) {
        case 'completed': return result;
        case 'failed': return result;
        case 'needs_attention': return result;
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

    const sessionId = null;
    let actionFailure: string | null = null;
    let retainedRun: ReturnType<typeof ExecutionRunGetResponseSchema.parse>['run'] | undefined;
    const stoppedCustody = () => {
      if (!input.terminalParent || input.observationOnly || !retainedRun
        || (retainedRun.status !== 'failed' && retainedRun.status !== 'succeeded' && retainedRun.status !== 'cancelled')
        || retainedRun.inputTurns?.current?.state === 'active'
        || resolveWorkflowDetachedExecutionRunInputTurn(retainedRun, execution.runId, execution.localInputId)) return null;
      // The exact Run owner proves inactivity, not this historical input's
      // outcome. Never copy its result or another turn's failure into the row.
      return { kind: 'stopped' as const, code: 'execution_run_input_not_observed' };
    };
    const actionContext = {
      surface: 'agent' as const,
      authority: 'account_automation' as const,
      executionRunTargetMachineId: params.machineId,
      ...(input.signal ? { signal: input.signal } : {}),
    };
    let observed: Awaited<ReturnType<typeof observeRun>>;
    try {
      observed = await observeRun({
        runId: execution.runId,
        localInputId: execution.localInputId,
        get: async (request) => {
          const result = await params.actionExecutor.execute(
            'execution.run.get',
            { sessionId, ...request },
            actionContext,
          );
          if (!result.ok) {
            actionFailure = result.errorCode;
            return null;
          }
          const parsed = ExecutionRunGetResponseSchema.safeParse(result.result);
          retainedRun = parsed.success && parsed.data.run.runId === execution.runId ? parsed.data.run : undefined;
          return result.result;
        },
      });
    } catch {
      return { kind: 'unresolved', code: actionFailure ?? 'execution_run_result_read_failed' };
    }
    if (actionFailure) return { kind: 'unresolved', code: actionFailure };
    if (observed.kind === 'outcome_uncertain' && observed.code === 'execution_run_input_not_observed') {
      return stoppedCustody() ?? observed;
    }
    if (observed.kind !== 'pending') return observed;
    if (input.observationOnly || (!input.terminalParent && !input.cancellationRequested)) {
      return { kind: 'unresolved', code: 'execution_run_input_pending' };
    }
    const { signal: _signal, ...stopContext } = actionContext;
    const stopped = await stopWorkflowPendingExecutionRunInput({
      runId: execution.runId,
      localInputId: execution.localInputId,
      stop: async () => {
        try {
          return await params.actionExecutor.execute(
            'execution.run.stop',
            { sessionId, runId: execution.runId },
            stopContext,
          );
        } catch {
          return { ok: false, errorCode: 'execution_run_stop_unavailable' };
        }
      },
      get: async (request) => {
        retainedRun = undefined;
        const result = await params.actionExecutor.execute(
          'execution.run.get',
          { sessionId, ...request },
          stopContext,
        );
        if (result.ok) {
          const parsed = ExecutionRunGetResponseSchema.safeParse(result.result);
          retainedRun = parsed.success && parsed.data.run.runId === execution.runId ? parsed.data.run : undefined;
        }
        return result.ok ? result.result : null;
      },
      observe: observeRun,
    });
    return stopped.kind === 'unresolved' ? stoppedCustody() ?? stopped : stopped;
  };
}
