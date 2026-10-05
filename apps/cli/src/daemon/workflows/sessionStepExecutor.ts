import type { StoredCredentials } from '@/persistence';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import { buildExecutionRunResultContractPrompt, WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS, deriveWorkflowSessionInputLocalIdV2, areSessionMcpSelectionsEquivalent } from '@happier-dev/protocol';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { formatWorkflowStepSessionTitle } from '@happier-dev/protocol/workflows';
import { cancelSessionInput } from '@/session/services/cancelSessionInput';
import { resolveSessionCreationAgentTarget } from '@/session/creation/resolveSessionCreationAgentTarget';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams';
import {
  resolveSessionSpawnConnectedServicesDefaultsPayload,
  type ResolveSpawnConnectedServicesTeamResourceCatalog,
} from '@/session/services/spawnConnectedServicesDefaults';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import type {
  WorkflowAuthoredProducerRef,
  WorkflowProgressEnvelopeV1,
  WorkflowSessionAuthoringSelection,
  WorkflowWorkspaceDescriptorV1,
} from '@happier-dev/protocol/workflows';
import type { ResolvedRoleV1, SessionAwarenessOriginV1, SessionInitialAccessDraftV1 } from '@happier-dev/protocol';
import { assertNonEscalatingPermissionMode } from '@happier-dev/protocol';
import {
  classifyWorkflowAbort,
  assertWorkflowAdmissionSignal,
  WorkflowRuntimeInterruption,
  type WorkflowStepExecutionResult,
  type WorkflowStepExecutor,
  type WorkflowStepPreparer,
} from './coordinator';
import {
  classifyWorkflowSessionInputResult,
  enqueueWorkflowSessionInput,
  observeWorkflowSessionInputResult,
} from './stepExecution';
import { resolveWorkflowConversationSelection, type WorkflowConversationBinding } from './workflowConversation';
import type { WorkflowProducerBinding } from './workflowScopeBinding';

export type PreparedWorkflowSessionConversation = Readonly<{
  kind: 'workflow_session_conversation';
  existing: WorkflowSessionConversation | null;
  inputPath?: 'origin_session';
}>;

export type WorkflowSessionConversation = Readonly<{
  sessionId: string;
  machineId: string;
  directory: string;
  agentTarget?: WorkflowSessionAuthoringSelection['agentTarget'];
  runtimeSelection?: WorkflowSessionAuthoringSelection;
  /** Session-owned creation facts, retained across shared inputs and recovery. */
  origin?: SessionAwarenessOriginV1;
  workDepth?: number;
}>;

export type CreateFreshWorkflowSessionConversation = (params: Readonly<{
  selection: WorkflowSessionAuthoringSelection;
  workspace: WorkflowWorkspaceDescriptorV1;
  creationKey: string;
  initialTitle?: string;
  /** The accepted selected Role, never re-resolved from mutable Settings. */
  frozenRole?: ResolvedRoleV1;
  signal?: AbortSignal;
}>) => Promise<WorkflowSessionConversation>;

/**
 * Binds workflow fresh-conversation creation to the same target preparation,
 * Agent catalog, Connected Service defaulting, credential/currentness and
 * create-or-rejoin owners as ordinary authored Sessions.
 */
export function createProductionFreshWorkflowSessionConversation(deps: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  machineId: string;
  /** Accepted Run depth, shared by every retry and recovery. */
  workDepth: number;
  originRunId: string;
  /** Frozen Run visibility, not the Workflow's mutable access document. */
  visibleTeamId?: string | null;
  machineAdmissionTransport: NonNullable<Parameters<typeof enqueueWorkflowSessionInput>[0]['machineAdmissionTransport']>;
  resolveTeamCredentialResourceCatalog?: ResolveSpawnConnectedServicesTeamResourceCatalog;
}>): CreateFreshWorkflowSessionConversation {
  return async ({ selection, workspace, creationKey, initialTitle, frozenRole, signal }) => {
    signal?.throwIfAborted();
    if (workspace.machineId !== deps.machineId) {
      throw new WorkflowSessionCompositionError('target_unavailable');
    }
    const resolvedAgent = selection.agentTarget
      ? resolveSessionCreationAgentTarget(selection.agentTarget)
      : null;
    if (!resolvedAgent) throw new WorkflowSessionCompositionError('target_unavailable');

    const target = await prepareSessionCreationTarget({
      request: {
        directory: { kind: 'path', path: workspace.directory },
      },
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    if (!target.ok
      || target.directoryCreationRequired
      || !canonicalAbsolutePathsEqual(target.directory, workspace.directory)) {
      throw new WorkflowSessionCompositionError(
        target.ok ? 'conversation_workspace_mismatch' : target.code,
      );
    }

    const connectedServicesDefault = selection.connectedServices === undefined
      ? await resolveSessionSpawnConnectedServicesDefaultsPayload({
          agentId: resolvedAgent.agentId,
          credentials: deps.credentials,
          ...(deps.resolveTeamCredentialResourceCatalog
            ? { resolveTeamCredentialResourceCatalog: deps.resolveTeamCredentialResourceCatalog }
            : {}),
        })
      : null;
    signal?.throwIfAborted();
    const terminal = selection.terminal
      ? {
          ...(selection.terminal.mode && selection.terminal.mode !== 'integrated'
            ? { mode: selection.terminal.mode }
            : {}),
          ...(selection.terminal.tmux ? { tmux: selection.terminal.tmux } : {}),
        }
      : undefined;
    const permissionMode = selection.permissionMode
      ? parsePermissionIntentAlias(selection.permissionMode)
      : null;
    if (selection.permissionMode && !permissionMode) {
      throw new WorkflowSessionCompositionError('target_unavailable');
    }
    let team: ReturnType<typeof TeamSummaryV1Schema.parse> | null = null;
    if (deps.visibleTeamId) {
      const parsed = TeamSummaryV1Schema.safeParse(await createAccountServerActionDeps({
        token: deps.credentials.token,
        serverId: deps.serverId,
        serverHttpBaseUrl: resolveServerHttpBaseUrl(),
      }).homeDomainAction!({ actionId: 'teams.get', input: { v: 1, teamId: deps.visibleTeamId }, context: {}, ...(signal ? { signal } : {}) }));
      if (!parsed.success) throw new WorkflowSessionCompositionError('target_unavailable');
      team = parsed.data;
    }
    if (team && (team.id !== deps.visibleTeamId || team.archivedAt !== null)) {
      throw new WorkflowSessionCompositionError('target_unavailable');
    }
    const initialAccess: SessionInitialAccessDraftV1 | undefined = team
      ? { grants: [{ subject: { kind: 'team', teamId: team.id }, accessLevel: 'view', canApprovePermissions: false }] }
      : undefined;
    signal?.throwIfAborted();
    const created = await createSpawnedSession({
      credentials: deps.credentials,
      machineId: deps.machineId,
      directory: target.directory,
      approvedNewDirectoryCreation: false,
      spawnNonce: creationKey,
      originKind: 'run_step',
      originRunId: deps.originRunId,
      ...(team ? {
        initialAccess,
        // Ordinary Team visibility is view-only, not a primary-Team choice.
        // Required Teams use the existing server policy writer and edit floor.
        ...(team.policy.sessionCreationPolicy === 'team_required' ? { primaryTeamId: team.id } : {}),
      } : {}),
      workDepth: deps.workDepth + 1,
      ...(frozenRole ? { initialSessionRolesV1: {
        roleId: frozenRole.roleId, overrides: {}, sessionRoles: { [frozenRole.roleId]: frozenRole }, notes: '',
      } } : {}),
      ...(initialTitle ? { initialTitle } : {}),
      backendTarget: resolvedAgent.backendTarget,
      agentTarget: selection.agentTarget ?? undefined,
      ...(selection.modelSelection ? { modelSelection: selection.modelSelection } : {}),
      ...(selection.profileId ? { profileId: selection.profileId } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(selection.acpSessionModeId ? { agentModeId: selection.acpSessionModeId } : {}),
      ...(selection.sessionConfigOptionOverrides
        ? { sessionConfigOptionOverrides: selection.sessionConfigOptionOverrides }
        : {}),
      ...(selection.connectedServices
        ? { connectedServices: selection.connectedServices }
        : connectedServicesDefault
          ? {
              connectedServices: connectedServicesDefault.connectedServices,
              connectedServicesUpdatedAt: connectedServicesDefault.connectedServicesUpdatedAt,
              // Defaulted Team targets are admitted only through the Session's
              // own Team slot bindings, created with it.
              ...(connectedServicesDefault.teamCredentialBindings
                ? { teamCredentialBindings: connectedServicesDefault.teamCredentialBindings }
                : {}),
            }
          : {}),
      ...(selection.mcpSelection ? { mcpSelection: selection.mcpSelection } : {}),
      ...(selection.transcriptStorage ? { transcriptStorage: selection.transcriptStorage } : {}),
      ...(terminal && Object.keys(terminal).length > 0 ? { terminal } : {}),
      ...(selection.windowsRemoteSessionLaunchMode
        ? { windowsRemoteSessionLaunchMode: selection.windowsRemoteSessionLaunchMode }
        : selection.terminal?.windows?.launchMode
          ? { windowsRemoteSessionLaunchMode: selection.terminal.windows.launchMode }
          : {}),
      ...(selection.windowsRemoteSessionConsole
        ? { windowsRemoteSessionConsole: selection.windowsRemoteSessionConsole }
        : selection.terminal?.windows?.console
          ? { windowsRemoteSessionConsole: selection.terminal.windows.console }
          : {}),
      ...(selection.windowsTerminalWindowName
        ? { windowsTerminalWindowName: selection.windowsTerminalWindowName }
        : selection.terminal?.windows?.windowName
          ? { windowsTerminalWindowName: selection.terminal.windows.windowName }
          : {}),
      ...(selection.runtimeDescriptorV1 ? { runtimeDescriptorV1: selection.runtimeDescriptorV1 } : {}),
      machineAdmissionTransport: deps.machineAdmissionTransport,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    return { sessionId: created.sessionId, machineId: deps.machineId, directory: target.directory,
      origin: { kind: 'run_step', runId: deps.originRunId }, workDepth: deps.workDepth + 1 };
  };
}

export class WorkflowSessionCompositionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Both Session input paths render at the producer; the origin consumes frozen text. */
export function withWorkflowRoleInstructions(text: string, roleInstructions?: string): string {
  return roleInstructions ? `${roleInstructions}\n\n${text}` : text;
}

export function renderWorkflowSessionStepInput(params: Readonly<{
  input: Pick<Parameters<WorkflowStepExecutor>[0]['input'], 'text'>;
  result: Parameters<WorkflowStepExecutor>[0]['step']['result'];
  roleInstructions?: string;
}>): string {
  const instruction = buildExecutionRunResultContractPrompt(params.result);
  const text = withWorkflowRoleInstructions(params.input.text, params.roleInstructions);
  return instruction ? `${text}\n\n${instruction}` : text;
}

/** Session-first leaf adapter. Conversation selection/creation stays in its injected Session owner. */
export function createWorkflowSessionStepExecutor(deps: Readonly<{
  credentials: StoredCredentials;
  /** Frozen role block rendered by ORC's canonical role renderer. */
  resolveRoleInstructions?: (params: Parameters<WorkflowStepExecutor>[0]) => string | undefined;
  workDepth?: number;
  prepareConversation: (params: Parameters<WorkflowStepExecutor>[0]) => Promise<PreparedWorkflowSessionConversation>;
  materializeConversation: (
    prepared: PreparedWorkflowSessionConversation,
    params: Parameters<WorkflowStepExecutor>[0],
  ) => Promise<Readonly<{
    sessionId: string;
    machineAdmissionTransport: NonNullable<Parameters<typeof enqueueWorkflowSessionInput>[0]['machineAdmissionTransport']>;
  }>>;
  sessionInput?: Readonly<{
    enqueue: typeof enqueueWorkflowSessionInput;
    observe: typeof observeWorkflowSessionInputResult;
    cancel?: typeof cancelSessionInput;
  }>;
  originSessionInput?: Readonly<{
    withdraw: (input: Readonly<{ sessionId: string; localInputId: string }>) => Promise<'withdrawn' | 'dispatched'>;
    cancelDispatched: (input: Readonly<{ sessionId: string; localInputId: string }>) => Promise<void>;
  }>;
}>): WorkflowStepExecutor {
  const sessionInput = {
    enqueue: enqueueWorkflowSessionInput,
    observe: observeWorkflowSessionInputResult,
    cancel: cancelSessionInput,
    ...deps.sessionInput,
  };
  return async (params) => {
    const originInput = params.conversationBinding?.kind === 'origin_session'
      || params.execution.conversation?.kind === 'origin_session'
      || (isPreparedWorkflowSessionConversation(params.preparedStep) && params.preparedStep.inputPath === 'origin_session');
    const requestedPermissionCeiling = params.execution.permissionMode === undefined ? 'default' : params.execution.permissionMode;
    let originStopRequested = false;
    const observeOriginInput = async (sessionId: string, localId: string, signal: AbortSignal | undefined) => {
      const withdrawal = new AbortController();
      const observerSignal = signal ? AbortSignal.any([signal, withdrawal.signal]) : withdrawal.signal;
      const observed = await sessionInput.observe({
        credentials: deps.credentials, sessionId, localId,
        ...(params.invocation.observationDeadline?.kind === 'at'
          ? { deadlineMs: Date.parse(params.invocation.observationDeadline.expiresAt) }
          : params.step.timeoutMs === undefined ? {} : { timeoutAfterInputMs: params.step.timeoutMs }),
        signal: observerSignal,
        beforeInputObservation: async () => {
          const control = await params.readOriginInputControl?.() ?? 'running';
          if (control === 'running' || !deps.originSessionInput) return;
          // Missing/runtime-unavailable answers leave the offer intact. The
          // canonical observer keeps waiting on the same exact input.
          try {
            const answer = await deps.originSessionInput.withdraw({ sessionId, localInputId: localId });
            if (answer === 'withdrawn') withdrawal.abort('workflow_origin_input_withdrawn');
            else if (control === 'cancel_requested' && !originStopRequested) {
              await deps.originSessionInput.cancelDispatched({ sessionId, localInputId: localId });
              originStopRequested = true;
            }
          } catch { /* The origin's startup pull will answer when available. */ }
        },
        onInputMaterialized: async (acceptedAtMs) => {
          await params.onInputAccepted({ kind: 'session', sessionId, localInputId: localId }, acceptedAtMs);
        },
      });
      return withdrawal.signal.aborted
        ? { ok: false as const, code: 'cancelled' as const, withdrawn: true }
        : observed;
    };
    const cancelAcceptedInput = async (sessionId: string, localId: string) => {
      if (originInput) {
        if (!deps.originSessionInput) return { kind: 'needs_attention' as const, code: 'workflow_origin_input_withdrawal_unavailable' };
        try {
          const answer = await deps.originSessionInput.withdraw({ sessionId, localInputId: localId });
          if (answer === 'withdrawn') return { kind: 'cancelled' as const, code: 'workflow_origin_input_withdrawn' };
          if (!originStopRequested) {
            await deps.originSessionInput.cancelDispatched({ sessionId, localInputId: localId });
            originStopRequested = true;
          }
          // Stop acceptance is not terminal evidence. Rejoin the same host
          // turn after the authoritative stop request and observe settlement.
          const settled = await observeOriginInput(sessionId, localId, undefined);
          if (!settled.ok) return { kind: 'needs_attention' as const, code: 'workflow_origin_input_stop_pending' };
          const classified = classifyWorkflowSessionInputResult(settled.result);
          if (classified.kind === 'pending') return { kind: 'needs_attention' as const, code: 'workflow_origin_input_stop_pending' };
          return classified.kind === 'cancelled'
            ? { kind: 'cancelled' as const, code: 'session_input_cancelled', ...(classified.usage ? { usage: classified.usage } : {}) }
            : classified;
        } catch (error) {
          return { kind: 'needs_attention' as const, code: error instanceof WorkflowSessionCompositionError
            ? error.code : 'workflow_origin_input_withdrawal_unavailable' };
        }
      }
      const cancelled = await sessionInput.cancel({ credentials: deps.credentials, sessionId, localId });
      switch (cancelled.kind) {
        case 'pending_retired': return { kind: 'cancelled' as const, code: 'session_input_pending_retired' };
        case 'turn_cancel_requested':
        case 'turn_cancel_refused': {
          // The stop response is not settlement. Observe the same input without
          // the cancelled claim signal, using its existing observation deadline.
          try {
            const settled = await sessionInput.observe({
              credentials: deps.credentials, sessionId, localId,
              ...(params.invocation.observationDeadline?.kind === 'at'
                ? { deadlineMs: Date.parse(params.invocation.observationDeadline.expiresAt) }
                : params.step.timeoutMs === undefined ? {} : { timeoutAfterInputMs: params.step.timeoutMs }),
            });
            return settled.ok ? settleObservedInput(settled.result)
              : { kind: 'needs_attention' as const, code: settled.code };
          } catch {
            return { kind: 'needs_attention' as const, code: 'session_input_result_read_failed' };
          }
        }
        case 'turn_cancel_unavailable': return { kind: 'needs_attention' as const, code: cancelled.code };
      }
    };
    // Observation ended because this attempt was aborted. Only an abort with
    // stop authority retires/cancels the exact accepted input; a bare claim
    // interruption leaves the Session turn running for reclaim/reattach.
    const settleAcceptedInputAfterAbort = async (sessionId: string, localId: string) => {
      if (classifyWorkflowAbort(params.signal) === 'interrupted') throw new WorkflowRuntimeInterruption();
      return await cancelAcceptedInput(sessionId, localId);
    };
    const settleBeforeAdmissionAfterAbort = (): WorkflowStepExecutionResult => {
      if (classifyWorkflowAbort(params.signal) === 'interrupted') throw new WorkflowRuntimeInterruption();
      return { kind: 'cancelled', code: 'session_input_cancelled' };
    };
    const settleObservedInput = (
      result: Parameters<typeof classifyWorkflowSessionInputResult>[0],
    ): WorkflowStepExecutionResult => {
      const observed = classifyWorkflowSessionInputResult(result);
      switch (observed.kind) {
        case 'completed':
        case 'failed': return observed;
        case 'pending': return { kind: 'needs_attention', code: 'workflow_step_timeout' };
        case 'cancelled': return { ...observed, code: 'session_input_cancelled' };
      }
    };
    if (params.invocation.execution) {
      if (params.invocation.execution.kind !== 'session') {
        return { kind: 'failed', code: 'workflow_execution_target_mismatch' };
      }
      const observed = originInput ? await observeOriginInput(params.invocation.execution.sessionId, params.invocation.execution.localInputId, params.signal)
        : await sessionInput.observe({
        credentials: deps.credentials,
        sessionId: params.invocation.execution.sessionId,
        localId: params.invocation.execution.localInputId,
        ...(params.invocation.observationDeadline?.kind === 'at'
          ? { deadlineMs: Date.parse(params.invocation.observationDeadline.expiresAt) }
          : params.step.timeoutMs === undefined ? {} : { timeoutAfterInputMs: params.step.timeoutMs }),
        onInputMaterialized: async (acceptedAtMs) => {
          await params.onInputAccepted(params.invocation.execution!, acceptedAtMs);
        },
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (!observed.ok && 'withdrawn' in observed && observed.withdrawn) {
        return { kind: 'cancelled', code: 'workflow_origin_input_withdrawn' };
      }
      if (!observed.ok && originInput && observed.code === 'session_not_found') {
        return { kind: 'failed', code: 'workflow_conversation_unavailable' };
      }
      if (!observed.ok) return observed.code === 'cancelled'
        ? await settleAcceptedInputAfterAbort(params.invocation.execution.sessionId, params.invocation.execution.localInputId)
        : { kind: 'needs_attention', code: observed.code };
      return settleObservedInput(observed.result);
    }
    if (!assertNonEscalatingPermissionMode({
      requestedMode: requestedPermissionCeiling ?? 'default',
      callerMode: params.authorization.admittedPermissionCeiling,
    }).ok) {
      return { kind: 'failed', code: 'workflow_permission_escalation_denied' };
    }
    let prepared: PreparedWorkflowSessionConversation;
    try {
      prepared = isPreparedWorkflowSessionConversation(params.preparedStep)
        ? params.preparedStep
        : await deps.prepareConversation(params);
    } catch (error) {
      if (params.signal?.aborted) return settleBeforeAdmissionAfterAbort();
      if (error instanceof WorkflowSessionCompositionError) return { kind: 'failed', code: error.code };
      throw error;
    }
    const keepsStepSessionDepth = prepared.existing?.origin?.kind === 'run_step'
      && params.conversationBinding?.kind !== 'existing_session'
      && params.execution.conversation?.kind !== 'existing_session'
      && prepared.inputPath !== 'origin_session';
    if (keepsStepSessionDepth && prepared.existing?.workDepth === undefined) {
      return { kind: 'failed', code: 'workflow_conversation_unavailable' };
    }
    const inputDepth = keepsStepSessionDepth ? prepared.existing?.workDepth
      : deps.workDepth === undefined ? undefined : deps.workDepth + (prepared.existing ? 0 : 1);
    if (prepared.inputPath === 'origin_session') {
      if (!params.onOriginInputOffered) {
        return { kind: 'failed', code: 'workflow_origin_input_offer_unavailable' };
      }
      if (!prepared.existing || prepared.existing.sessionId !== params.originSessionId) {
        return { kind: 'failed', code: 'workflow_conversation_unavailable' };
      }
      if (prepared.existing.machineId !== params.workspace.machineId
        || !canonicalAbsolutePathsEqual(prepared.existing.directory, params.workspace.directory)) {
        return { kind: 'failed', code: 'conversation_workspace_mismatch' };
      }
      const localId = deriveWorkflowSessionInputLocalIdV2({
        purpose: 'invocation', runId: params.runId,
        invocationRecordId: params.invocationRecordId ?? params.invocation.logicalInvocationRecordId,
      });
      if (!params.observationOnly) {
        await params.beforeInputAdmission();
        params.signal?.throwIfAborted();
        // This row commit is the producer offer. ORC pulls it into the
        // origin's one input queue; no Session Pending item is written here.
        try {
          await params.onOriginInputOffered({ kind: 'session', sessionId: prepared.existing.sessionId, localInputId: localId },
            renderWorkflowSessionStepInput({ input: params.input, result: params.step.result,
              roleInstructions: deps.resolveRoleInstructions?.(params) }));
        } catch (error) {
          if (params.signal?.aborted && classifyWorkflowAbort(params.signal) !== 'interrupted') {
            await cancelAcceptedInput(prepared.existing.sessionId, localId);
          }
          throw error;
        }
      }
      if (params.signal?.aborted) return await settleAcceptedInputAfterAbort(prepared.existing.sessionId, localId);
      const observed = await observeOriginInput(prepared.existing.sessionId, localId, params.signal);
      if (!observed.ok && 'withdrawn' in observed && observed.withdrawn) {
        return { kind: 'cancelled', code: 'workflow_origin_input_withdrawn' };
      }
      if (!observed.ok && observed.code === 'session_not_found') {
        return { kind: 'failed', code: 'workflow_conversation_unavailable' };
      }
      if (!observed.ok) return observed.code === 'cancelled'
        ? await settleAcceptedInputAfterAbort(prepared.existing.sessionId, localId)
        : { kind: 'needs_attention', code: observed.code };
      return settleObservedInput(observed.result);
    }
    let conversation: Awaited<ReturnType<typeof deps.materializeConversation>>;
    try {
      conversation = await deps.materializeConversation(prepared, params);
    } catch (error) {
      if (params.signal?.aborted) return settleBeforeAdmissionAfterAbort();
      if (error instanceof WorkflowSessionCompositionError) return { kind: 'failed', code: error.code };
      throw error;
    }
    const text = renderWorkflowSessionStepInput({ input: params.input, result: params.step.result,
      roleInstructions: deps.resolveRoleInstructions?.(params) });
    if (params.observationOnly) {
      const localId = deriveWorkflowSessionInputLocalIdV2({
        purpose: 'invocation', runId: params.runId,
        invocationRecordId: params.invocationRecordId ?? params.invocation.logicalInvocationRecordId,
      });
      const observed = await sessionInput.observe({
        credentials: deps.credentials, sessionId: conversation.sessionId, localId,
        ...(params.invocation.observationDeadline?.kind === 'at'
          ? { deadlineMs: Date.parse(params.invocation.observationDeadline.expiresAt) }
          : params.step.timeoutMs === undefined ? {} : { timeoutAfterInputMs: params.step.timeoutMs }),
        onInputMaterialized: async (acceptedAtMs) => {
          await params.onInputAccepted({ kind: 'session', sessionId: conversation.sessionId, localInputId: localId }, acceptedAtMs);
        },
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (!observed.ok) return observed.code === 'cancelled'
        ? await settleAcceptedInputAfterAbort(conversation.sessionId, localId)
        : { kind: 'needs_attention', code: observed.code };
      return settleObservedInput(observed.result);
    }
    await params.beforeInputAdmission();
    assertWorkflowAdmissionSignal(params.signal);
    const admission = await sessionInput.enqueue({
      credentials: deps.credentials,
      sessionId: conversation.sessionId,
      workflow: { purpose: 'invocation', runId: params.runId, invocationRecordId: params.invocationRecordId ?? params.invocation.logicalInvocationRecordId },
      ...(inputDepth === undefined ? {} : { workDepth: inputDepth }),
      text,
      mentions: params.input.references,
      attachments: params.input.attachments,
      machineAdmissionTransport: conversation.machineAdmissionTransport,
      permissionMode: requestedPermissionCeiling,
      ...(params.authorization.sourceAuthority
        ? { sourceAuthority: params.authorization.sourceAuthority }
        : {}),
      ...(params.execution.modelSelection === undefined
        ? {}
        : { modelSelectionInput: params.execution.modelSelection?.ref ?? { modelId: null } }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (admission.status === 'rejected') return { kind: 'failed', code: admission.code };
    if (admission.status === 'outcomeUnknown') return { kind: 'outcome_uncertain', code: admission.code };
    try {
      await params.onInputAccepted({
        kind: 'session', sessionId: conversation.sessionId, localInputId: admission.localId,
      });
    } catch (error) {
      if (params.signal?.aborted && classifyWorkflowAbort(params.signal) !== 'interrupted') {
        await cancelAcceptedInput(conversation.sessionId, admission.localId);
      }
      throw error;
    }
    if (params.signal?.aborted) return await settleAcceptedInputAfterAbort(conversation.sessionId, admission.localId);
    const deadlineMs = params.invocation.observationDeadline?.kind === 'at'
      ? Date.parse(params.invocation.observationDeadline.expiresAt)
      : undefined;
    const observed = await sessionInput.observe({
      credentials: deps.credentials,
      sessionId: conversation.sessionId,
      localId: admission.localId,
      ...(deadlineMs === undefined ? params.step.timeoutMs === undefined ? {} : { timeoutAfterInputMs: params.step.timeoutMs } : { deadlineMs }),
      onInputMaterialized: async (acceptedAtMs) => {
        await params.onInputAccepted({ kind: 'session', sessionId: conversation.sessionId, localInputId: admission.localId }, acceptedAtMs);
      },
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!observed.ok) return observed.code === 'cancelled'
      ? await settleAcceptedInputAfterAbort(conversation.sessionId, admission.localId)
      : { kind: 'needs_attention', code: observed.code };
    return settleObservedInput(observed.result);
  };
}

export type ProductionWorkflowConversationOwner = Readonly<{
  prepare: (params: Omit<Parameters<WorkflowStepPreparer>[0], 'producerBinding'> & Readonly<{
    producerBinding?: WorkflowProducerBinding;
  }>) => Promise<PreparedWorkflowSessionConversation>;
  materialize: (
    prepared: PreparedWorkflowSessionConversation,
    params: Parameters<WorkflowStepExecutor>[0],
  ) => Promise<WorkflowSessionConversation>;
}>;

export function isPreparedWorkflowSessionConversation(
  value: unknown,
): value is PreparedWorkflowSessionConversation {
  return typeof value === 'object' && value !== null
    && 'kind' in value && value.kind === 'workflow_session_conversation'
    && 'existing' in value;
}

function assertWorkflowSessionReuseCompatible(
  requested: WorkflowSessionAuthoringSelection,
  actual: WorkflowSessionConversation,
  keepSessionAgent = false,
): void {
  for (const field of WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS) {
    // These two supported next-input choices are applied by Session Pending.
    if (field === 'modelSelection' || field === 'permissionMode'
      || (keepSessionAgent && field === 'agentTarget') || requested[field] === undefined) continue;
    const retained = field === 'agentTarget' ? actual.agentTarget : actual.runtimeSelection?.[field];
    if (field === 'mcpSelection' && requested.mcpSelection && actual.runtimeSelection?.mcpSelection
      && areSessionMcpSelectionsEquivalent(requested.mcpSelection, actual.runtimeSelection.mcpSelection)) continue;
    let requestedValue: unknown = requested[field];
    let retainedValue: unknown = retained;
    if (field === 'sessionConfigOptionOverrides') {
      const requestedConfig = requested.sessionConfigOptionOverrides;
      const retainedConfig = actual.runtimeSelection?.sessionConfigOptionOverrides;
      if (requestedConfig && Object.keys(requestedConfig.overrides).some((id) => !retainedConfig?.overrides[id])) {
        throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
      }
      requestedValue = requestedConfig && Object.fromEntries(Object.entries(requestedConfig.overrides).map(([id, entry]) => [id, entry.value]));
      retainedValue = requestedConfig && retainedConfig && Object.fromEntries(Object.keys(requestedConfig.overrides)
        .map((id) => [id, retainedConfig.overrides[id]?.value]));
    }
    if (retainedValue === undefined
      || createCanonicalJsonSigningInput(requestedValue) !== createCanonicalJsonSigningInput(retainedValue)) {
      throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
    }
  }
}

/** Session identity stays exact; authored continuity is interpreted by the common binder. */
export function createProductionWorkflowConversationOwner(deps: Readonly<{
  machineId: string;
  createFreshConversation: CreateFreshWorkflowSessionConversation;
  resolveFrozenRole?: (params: Pick<Parameters<WorkflowStepExecutor>[0], 'step' | 'invocation' | 'role'>) => ResolvedRoleV1 | undefined;
  resolveSharedRunConversation: (params: Readonly<{
    runId: string;
    invocation: WorkflowProgressEnvelopeV1;
    conversationBinding?: WorkflowConversationBinding;
  }>) => Promise<WorkflowSessionConversation | null>;
  resolveProducerConversation: (params: Readonly<{
    runId: string;
    producer: WorkflowAuthoredProducerRef;
    invocation: WorkflowProgressEnvelopeV1;
    producerBinding?: WorkflowProducerBinding;
  }>) => Promise<WorkflowSessionConversation | null>;
  resolveExistingSessionConversation: (params: Readonly<{
    sessionId: string;
    machineId: string;
    signal?: AbortSignal;
  }>) => Promise<WorkflowSessionConversation | null>;
}>): ProductionWorkflowConversationOwner {
  return {
    prepare: async (params): Promise<PreparedWorkflowSessionConversation> => {
      params.signal?.throwIfAborted();
      const isOrigin = params.conversationBinding?.kind === 'origin_session'
        || params.execution.conversation?.kind === 'origin_session';
      if (!params.invocation.execution && isOrigin && params.invocation.recovery?.conversation === 'fresh_agent') {
        throw new WorkflowSessionCompositionError('workflow_recovery_conversation_unsupported');
      }
      const resolution = resolveWorkflowConversationSelection(params);
      if (resolution.kind === 'unavailable') throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
      if (resolution.kind === 'observe') {
        if (resolution.execution.kind !== 'session') {
          throw new WorkflowSessionCompositionError('workflow_execution_target_mismatch');
        }
        // The executor rejoins this input directly. Neither fresh selection nor
        // a configuration/workspace read may replace or prevent its observation.
        return { kind: 'workflow_session_conversation', existing: null,
          ...(isOrigin ? { inputPath: 'origin_session' as const } : {}) };
      }
      if (isOrigin && !params.onOriginInputOffered) {
        throw new WorkflowSessionCompositionError('workflow_origin_input_offer_unavailable');
      }
      const selection = resolution.kind === 'select' ? resolution.binding : null;
      if ((selection?.kind === 'existing_session' || isOrigin) && params.execution.workspace?.kind === 'new_worktree') {
        throw new WorkflowSessionCompositionError('conversation_workspace_mismatch');
      }
      let existing: WorkflowSessionConversation | null = null;
      if (resolution.kind === 'retained') {
        if (resolution.execution.kind !== 'session') {
          throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
        }
        existing = await deps.resolveExistingSessionConversation({
          sessionId: resolution.execution.sessionId, machineId: deps.machineId,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (!existing) throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
      } else if (selection?.kind === 'shared') {
        existing = await deps.resolveSharedRunConversation({ runId: params.runId, invocation: params.invocation,
          conversationBinding: selection });
      } else if (selection?.kind === 'from_step') {
        existing = await deps.resolveProducerConversation({
          runId: params.runId,
          producer: selection.producer,
          invocation: params.invocation,
          ...(params.producerBinding ? { producerBinding: params.producerBinding } : {}),
        });
        if (!existing) throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
      } else if (selection?.kind === 'existing_session') {
        existing = await deps.resolveExistingSessionConversation({
          sessionId: selection.sessionId,
          machineId: selection.machineId,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (!existing) throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
      } else if (selection?.kind === 'origin_session') {
        if (!params.originSessionId) throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
        existing = await deps.resolveExistingSessionConversation({
          sessionId: params.originSessionId, machineId: deps.machineId,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (!existing || existing.sessionId !== params.originSessionId) {
          throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
        }
      }
      if (existing && existing.machineId !== deps.machineId) {
        throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
      }
      if (isOrigin && (!existing || !params.originSessionId || existing.sessionId !== params.originSessionId)) {
        throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
      }
      if (existing && selection?.kind !== 'existing_session' && !isOrigin) {
        const actual = resolution.kind === 'retained' ? existing : await deps.resolveExistingSessionConversation({
          sessionId: existing.sessionId, machineId: existing.machineId,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (!actual) throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
        existing = actual;
        assertWorkflowSessionReuseCompatible(params.execution, actual);
      } else if (existing && selection?.kind === 'existing_session') {
        assertWorkflowSessionReuseCompatible(params.execution, existing, true);
      }
      params.signal?.throwIfAborted();
      return {
        kind: 'workflow_session_conversation',
        existing,
        ...(isOrigin ? { inputPath: 'origin_session' as const } : {}),
      };
    },
    materialize: async (prepared, params) => {
      if (prepared.existing) {
        if (!canonicalAbsolutePathsEqual(prepared.existing.directory, params.workspace.directory)) {
          throw new WorkflowSessionCompositionError('conversation_workspace_mismatch');
        }
        return prepared.existing;
      }
      params.signal?.throwIfAborted();
      if (!params.execution.agentTarget) throw new WorkflowSessionCompositionError('target_unavailable');
      const { conversation: _conversation, workspace: _workspace, ...selection } = params.execution;
      const frozenRole = deps.resolveFrozenRole?.(params);
      const initialTitle = params.memberOrdinal === undefined ? null : formatWorkflowStepSessionTitle({
        step: params.step, memberOrdinal: params.memberOrdinal,
      });
      const conversation = await deps.createFreshConversation({
        selection,
        ...(frozenRole ? { frozenRole } : {}),
        ...(initialTitle === null ? {} : { initialTitle }),
        workspace: params.workspace,
        creationKey: `workflow:${params.runId}:${params.invocationRecordId ?? params.invocation.logicalInvocationRecordId}`,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      params.signal?.throwIfAborted();
      if (conversation.machineId !== deps.machineId
        || !canonicalAbsolutePathsEqual(conversation.directory, params.workspace.directory)) {
        throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
      }
      return conversation;
    },
  };
}

/**
 * Concrete daemon Session composition. Durable invocation rows remain the
 * only conversation correspondence store: these read callbacks project prior
 * exact Session ids and this adapter creates only genuinely fresh Sessions.
 */
export function createProductionWorkflowSessionStepExecutor(deps: Readonly<{
  credentials: StoredCredentials;
  workDepth?: number;
  resolveRoleInstructions?: (params: Parameters<WorkflowStepExecutor>[0]) => string | undefined;
  machineId: string;
  machineAdmissionTransport: NonNullable<Parameters<typeof enqueueWorkflowSessionInput>[0]['machineAdmissionTransport']>;
  /** Canonical prepared Session-creation owner; this adapter never authors raw spawn options. */
  createFreshConversation: CreateFreshWorkflowSessionConversation;
  resolveSharedRunConversation: (params: Readonly<{
    runId: string;
    invocation: WorkflowProgressEnvelopeV1;
    conversationBinding?: WorkflowConversationBinding;
  }>) => Promise<WorkflowSessionConversation | null>;
  resolveProducerConversation: (params: Readonly<{
    runId: string;
    producer: WorkflowAuthoredProducerRef;
    invocation: WorkflowProgressEnvelopeV1;
    producerBinding?: WorkflowProducerBinding;
  }>) => Promise<WorkflowSessionConversation | null>;
  resolveExistingSessionConversation: (params: Readonly<{
    sessionId: string;
    machineId: string;
    signal?: AbortSignal;
  }>) => Promise<WorkflowSessionConversation | null>;
  sessionInput?: Parameters<typeof createWorkflowSessionStepExecutor>[0]['sessionInput'];
  originSessionInput?: Parameters<typeof createWorkflowSessionStepExecutor>[0]['originSessionInput'];
}>): WorkflowStepExecutor {
  const conversations = createProductionWorkflowConversationOwner(deps);
  return createWorkflowSessionStepExecutor({
    credentials: deps.credentials,
    ...(deps.workDepth !== undefined ? { workDepth: deps.workDepth } : {}),
    ...(deps.resolveRoleInstructions ? { resolveRoleInstructions: deps.resolveRoleInstructions } : {}),
    ...(deps.sessionInput ? { sessionInput: deps.sessionInput } : {}),
    ...(deps.originSessionInput ? { originSessionInput: deps.originSessionInput } : {}),
    prepareConversation: async (params) => await conversations.prepare(params),
    materializeConversation: async (prepared, params) => {
      const conversation = await conversations.materialize(prepared, params);
      return { sessionId: conversation.sessionId, machineAdmissionTransport: deps.machineAdmissionTransport };
    },
  });
}
