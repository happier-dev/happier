import type { StoredCredentials } from '@/persistence';
import { parsePermissionIntentAlias, resolveAgentExecutionTargetFromSessionMetadata } from '@happier-dev/agents';
import { buildExecutionRunResultContractPrompt } from '@happier-dev/protocol/execution/runs/resultContract';
import { WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS } from '@happier-dev/protocol/workflows/workflowV1';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { areSessionCapabilitySelectionsEquivalentV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { formatWorkflowStepSessionTitle } from '@happier-dev/protocol/workflows/workflowStepLabel';
import { cancelSessionInput } from '@/session/services/cancelSessionInput';
import { resolveSessionCreationAgentTarget } from '@/session/creation/resolveSessionCreationAgentTarget';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import { createSpawnedSession, type CreateSpawnedSessionParams } from '@/session/services/createSpawnedSession';
import { buildSessionCreationCorrespondence } from '@/session/shared/sessionCreationCorrespondence';
import { createSessionCreationSpawnNonce } from '@/session/shared/spawnNonce';
import { deriveWorkflowSessionCreationTag } from './workflowSessionStartup';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionCompletionOperation } from '@happier-dev/protocol/actions/actionCompletion';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { isDefiniteSpawnPreAdmissionRejection } from '@/session/services/spawnPreAdmissionRejection';
import { SPAWN_SESSION_ERROR_CODES, SessionLaunchRetiredV1Schema } from '@happier-dev/protocol/spawnSession';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import {
  mergeSessionTeamCredentialBindingIntents,
  resolveSessionSpawnConnectedServicesDefaultsPayload,
  type ResolveSpawnConnectedServicesTeamResourceCatalog,
} from '@/session/services/spawnConnectedServicesDefaults';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import type {
  WorkflowAuthoredProducerRef,
  WorkflowProgressEnvelopeV1,
  WorkflowSessionAuthoringSelection,
  WorkflowStepExecutionSelection,
  WorkflowWorkspaceDescriptorV1,
} from '@happier-dev/protocol/workflows';
import type { ResolvedRoleV1, SessionAwarenessOriginV1, SessionInitialAccessDraftV1, SessionOwnerModeCatalogV2, SessionRolesV1 } from '@happier-dev/protocol';
import { assertNonEscalatingPermissionMode } from '@happier-dev/protocol/actions/permissionPrivilege';
import {
  classifyWorkflowAbort,
  assertWorkflowAdmissionSignal,
  WorkflowRuntimeInterruption,
  type WorkflowStepExecutionResult,
  type WorkflowStepExecutor,
  type WorkflowStepPreparer,
  type WorkflowActionExecutor,
} from './coordinator';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readWorkflowActionApprovalSettlement } from './actionApproval';
import {
  classifyWorkflowSessionInputResult,
  enqueueWorkflowSessionInput,
  observeWorkflowSessionInputResult,
} from './stepExecution';
import { resolveWorkflowConversationSelection, WorkflowSessionCompositionError, type WorkflowConversationBinding } from './workflowConversation';
export { WorkflowSessionCompositionError } from './workflowConversation';
import type { WorkflowProducerBinding } from './workflowScopeBinding';
import { resolveSessionRuntimeSnapshot, type SessionRuntimeSnapshot } from '@/daemon/sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';
import { requestInactiveSessionResume } from '@/session/services/requestInactiveSessionResume';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { resolveWorkflowAuthorizedSession } from './invocationRecoveryObserver';
import { resolveSessionModeOverrideValue } from '@/agent/runtime/permissions/modeFromMetadata';
import { buildAcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import type { SessionSpawnNewSelectionV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewSelectionV2';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import { DiscussionInviteResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import type { WorkflowAcceptedOriginV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/selection/v1';
import { readSessionRolesV1, snapshotSessionRolesAtSpawnV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { WorkflowConversationUnavailableDetailsV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

function workflowSessionResumeOptions(selection: WorkflowStepExecutionSelection): NonNullable<Parameters<typeof requestInactiveSessionResume>[0]['incomingOptions']> {
  const terminal = selection.terminal ? {
    ...(selection.terminal.mode && selection.terminal.mode !== 'integrated' ? { mode: selection.terminal.mode } : {}),
    ...(selection.terminal.tmux ? { tmux: selection.terminal.tmux } : {}),
  } : undefined;
  return {
    ...(selection.launchEnvironment ? { environmentVariables: selection.launchEnvironment.values } : {}),
    ...(selection.providerSessionResume ? { resume: selection.providerSessionResume.providerSessionId } : {}),
    ...(selection.permissionMode ? { permissionMode: parsePermissionIntentAlias(selection.permissionMode) ?? undefined } : {}),
    ...(selection.permissionModeUpdatedAt === undefined ? {} : { permissionModeUpdatedAt: selection.permissionModeUpdatedAt }),
    ...(selection.modelSelection ? { modelSelection: selection.modelSelection } : {}),
    ...(selection.profileId ? { profileId: selection.profileId } : {}),
    ...(terminal ? { terminal } : {}),
    ...(selection.windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode: selection.windowsRemoteSessionLaunchMode } : {}),
    ...(selection.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: selection.windowsRemoteSessionConsole } : {}),
    ...(selection.windowsTerminalWindowName ? { windowsTerminalWindowName: selection.windowsTerminalWindowName } : {}),
    ...(selection.acpSessionModeId ? { agentModeId: selection.acpSessionModeId } : {}),
    ...(selection.capabilitySelection ? { capabilitySelection: selection.capabilitySelection } : {}),
    ...(selection.connectedServices ? { connectedServices: selection.connectedServices } : {}),
    ...(selection.transcriptStorage ? { transcriptStorage: selection.transcriptStorage } : {}),
    ...(selection.runtimeDescriptorV1 ? { runtimeDescriptorV1: selection.runtimeDescriptorV1 } : {}),
    ...(selection.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: selection.sessionConfigOptionOverrides } : {}),
  };
}

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
  /** Authenticated applied-mode catalog; desired launch intent is not evidence. */
  sessionModes?: SessionOwnerModeCatalogV2;
  /** Authenticated Session role configuration used by scoped trigger admission. */
  sessionRoles?: SessionRolesV1;
  runtimeSnapshot?: Pick<SessionRuntimeSnapshot, 'permissionMode' | 'modelSelection'>;
  /** Session-owned creation facts, retained across shared inputs and recovery. */
  origin?: SessionAwarenessOriginV1;
  workDepth?: number;
}>;

export type CreateFreshWorkflowSessionConversation = (params: Readonly<{
  selection: Omit<WorkflowStepExecutionSelection, 'conversation' | 'workspace'>;
  launch?: SessionSpawnNewSelectionV2;
  workspace: WorkflowWorkspaceDescriptorV1;
  creationKey: string;
  initialTitle?: string;
  /** The accepted selected Role, never re-resolved from mutable Settings. */
  frozenRole?: ResolvedRoleV1;
  observationOnly?: boolean;
  retainedStartupOperation?: ActionCompletionOperation;
  retainedStartupOperationSnapshot?: unknown;
  startupAuthorization?: Parameters<WorkflowStepExecutor>[0]['authorization'];
  origin?: WorkflowAcceptedOriginV1;
  retainedInvitationApproval?: Extract<NonNullable<WorkflowProgressEnvelopeV1['execution']>, { kind: 'action' }>;
  onInvitationApproval?: (execution: Extract<NonNullable<WorkflowProgressEnvelopeV1['execution']>, { kind: 'action' }>) => Promise<void>;
  onStartupObservation?: (operation: ActionOperationSnapshotV1, serverId: string) => Promise<void>;
  signal?: AbortSignal;
}>) => Promise<WorkflowSessionConversation>;

/** Installed original Session startup custody, never an alternate creator. */
export type WorkflowSessionStartup = (input: Readonly<{
  creationKey: string;
  request: CreateSpawnedSessionParams;
  retainedOperation?: ActionCompletionOperation;
  retainedOperationSnapshot?: unknown;
  authorization?: Parameters<WorkflowStepExecutor>[0]['authorization'];
  onObservation?: (operation: ActionOperationSnapshotV1) => Promise<void>;
}>) => Promise<Readonly<{ sessionId: string }>>;

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
  /** Accepted Session origin, when the Workflow was started under a lead. */
  originSessionId?: string;
  /** Only selected model participants acquire C3 slot ownership. */
  discussionOrigin?: WorkflowAcceptedOriginV1['discussion'];
  /** Frozen Run visibility, not the Workflow's mutable access document. */
  visibleTeamId?: string | null;
  machineAdmissionTransport: NonNullable<Parameters<typeof enqueueWorkflowSessionInput>[0]['machineAdmissionTransport']>;
  resolveTeamCredentialResourceCatalog?: ResolveSpawnConnectedServicesTeamResourceCatalog;
  sessionStartup?: WorkflowSessionStartup;
  /** The Run's canonical Action policy and approval/replay owner. */
  action?: WorkflowActionExecutor;
}>): CreateFreshWorkflowSessionConversation {
  return async ({ selection: authoredSelection, launch, workspace, creationKey, initialTitle, frozenRole, observationOnly, retainedStartupOperation, retainedStartupOperationSnapshot, startupAuthorization, origin: acceptedOrigin, retainedInvitationApproval, onInvitationApproval, onStartupObservation, signal }) => {
    signal?.throwIfAborted();
    if (workspace.machineId !== deps.machineId) {
      throw new WorkflowSessionCompositionError('target_unavailable');
    }
    if (launch) {
      const sameHome = launch.executionTarget.serverId === deps.serverId
        || await isServerProfileHomeIdentity(deps.serverId, launch.executionTarget.serverId);
      if (!sameHome || launch.executionTarget.machineId !== deps.machineId
        || launch.directory.kind !== 'path'
        || !canonicalAbsolutePathsEqual(launch.directory.path, workspace.directory)
        || launch.checkoutCreationDraft != null) {
        throw new WorkflowSessionCompositionError('target_unavailable');
      }
    }
    if (launch?.roleId && frozenRole?.roleId !== launch.roleId) {
      throw new WorkflowSessionCompositionError('role_target_unavailable');
    }
    if (launch?.primaryTeamId !== undefined && deps.visibleTeamId && launch.primaryTeamId !== deps.visibleTeamId) {
      throw new WorkflowSessionCompositionError('target_unavailable');
    }
    const launchConfiguration = launch?.configuration;
    const configuredModelSelection = launch && launchConfiguration?.model.value
      ? SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: launchConfiguration.model.updatedAtMs,
        ref: { agentTargetKey: buildBackendTargetKeyV2(launch.agentTarget), providerConnectionId: null,
          modelId: launchConfiguration.model.value } }) : undefined;
    const selection: Omit<WorkflowStepExecutionSelection, 'conversation' | 'workspace'> = launch ? {
      agentTarget: launch.agentTarget,
      ...(launch.modelSelection ?? configuredModelSelection
        ? { modelSelection: launch.modelSelection ?? configuredModelSelection } : {}),
      ...(launch.profileId ? { profileId: launch.profileId } : {}),
      ...(launch.permissionMode ?? launchConfiguration?.permissionIntent.value
        ? { permissionMode: launch.permissionMode ?? launchConfiguration?.permissionIntent.value ?? undefined }
        : {}),
      ...(launchConfiguration ? { permissionModeUpdatedAt: launchConfiguration.permissionIntent.updatedAtMs,
        sessionConfigOptionOverrides: buildAcpConfigOptionOverridesV1({
          updatedAt: Math.max(launchConfiguration.mode.updatedAtMs, launchConfiguration.model.updatedAtMs,
            launchConfiguration.permissionIntent.updatedAtMs,
            ...Object.values(launchConfiguration.options).map(option => option.updatedAtMs)),
          overrides: Object.fromEntries(Object.entries(launchConfiguration.options)
            .map(([id, option]) => [id, { value: option.value, updatedAt: option.updatedAtMs }])),
        }),
        ...(launchConfiguration.providerSessionResume ? { providerSessionResume: launchConfiguration.providerSessionResume } : {}),
      } : {}),
      ...(launch.agentModeId ?? launchConfiguration?.mode.value
        ? { acpSessionModeId: launch.agentModeId ?? launchConfiguration?.mode.value ?? undefined } : {}),
      ...(launch.connectedServices !== undefined ? { connectedServices: launch.connectedServices } : {}),
      ...(launch.capabilitySelection ? { capabilitySelection: launch.capabilitySelection } : {}),
      ...(launch.transcriptStorage ? { transcriptStorage: launch.transcriptStorage } : {}),
      ...(launch.terminal ? { terminal: launch.terminal } : {}),
      ...(launch.allowedTools ?? launchConfiguration?.allowedTools
        ? { allowedTools: launch.allowedTools ?? launchConfiguration?.allowedTools } : {}),
      ...(launch.unlistedTools ?? launchConfiguration?.unlistedTools
        ? { unlistedTools: launch.unlistedTools ?? launchConfiguration?.unlistedTools } : {}),
    } : authoredSelection;
    const discussionParticipant = deps.discussionOrigin && launch
      ? { discussionId: deps.discussionOrigin.discussion.discussionId, participantSlotId: creationKey }
      : undefined;
    const origin: SessionAwarenessOriginV1 = discussionParticipant
      ? { kind: 'discussion', discussionParticipant } : { kind: 'run_step', runId: deps.originRunId };
    const discussionAction = discussionParticipant ? createDiscussionActionDeps({ credentials: deps.credentials,
      serverId: deps.serverId, serverHttpBaseUrl: resolveServerHttpBaseUrl() }).discussionAction : undefined;
    if (discussionParticipant && deps.discussionOrigin) {
      const sameHome = deps.discussionOrigin.discussion.serverId === deps.serverId
        || await isServerProfileHomeIdentity(deps.serverId, deps.discussionOrigin.discussion.serverId);
      if (!sameHome) throw new WorkflowSessionCompositionError('target_unavailable');
    }
    if (discussionParticipant && launch && !retainedStartupOperation) {
      if (!deps.action || !startupAuthorization) throw new WorkflowSessionCompositionError('approval_context_unavailable');
      const context = await deps.action.buildContext({ runId: deps.originRunId, authorization: startupAuthorization,
        workDepth: deps.workDepth, workspace, ...(acceptedOrigin ? { origin: acceptedOrigin } : {}),
        ...(deps.originSessionId ? { originSessionId: deps.originSessionId } : {}), ...(signal ? { signal } : {}) });
      const actionRequestId = `${creationKey}:discussion.invite`;
      const policy = acceptedOrigin?.actionPolicy;
      const actionContext = { ...context,
        ...(policy?.actionsSettings ? { actionsSettings: policy.actionsSettings } : {}),
        // Starting a safe Run as a person is not invitation consent. C3's
        // confirmed Second opinion path already supplies invited Sessions.
        authority: 'account_automation' as const,
        actionRequestId, actionCaller: { kind: 'workflowRun' as const,
        runId: deps.originRunId, authorization: startupAuthorization, discussionModelReservation: {
          ...discussionParticipant, ...(policy?.surface ? { policySurface: policy.surface } : {}),
        } } };
      const input = { discussionId: discussionParticipant.discussionId,
        participant: { kind: 'model', participantSlotId: creationKey, launch: projectNativeJsonValueForTransport(launch) } };
      const execute = async (actionId: 'discussion.invite' | 'approval.request.get', input: unknown) => {
        const prepared = await deps.action!.executor.prepare(actionId, input, actionContext);
        return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
      };
      const settleApproval = async (execution: NonNullable<typeof retainedInvitationApproval>) => {
        const settled = await readWorkflowActionApprovalSettlement({ execution,
          read: async artifactId => { const observed = await execute('approval.request.get', { artifactId });
            return observed.ok ? observed.result : null; } });
        if (settled?.kind === 'completed') return settled.result;
        if (settled?.kind === 'unresolved' && settled.code === 'approval_required' && deps.action?.observeApproval) {
          const approval = ActionApprovalRequestCreatedResultSchema.parse(execution.output);
          const observed = await deps.action.observeApproval({ artifactId: approval.artifactId, actionRequestId,
            authorization: startupAuthorization, signal: signal ?? new AbortController().signal });
          if (!observed.ok) throw new WorkflowSessionCompositionError(observed.errorCode);
          return observed.result;
        }
        throw new WorkflowSessionCompositionError(settled?.code ?? 'approval_unavailable');
      };
      let result: unknown;
      if (retainedInvitationApproval) {
        if (retainedInvitationApproval.actionRequestId !== actionRequestId
          || createCanonicalJsonSigningInput(retainedInvitationApproval.input) !== createCanonicalJsonSigningInput(input)) {
          throw new WorkflowSessionCompositionError('approval_unavailable');
        }
        result = await settleApproval(retainedInvitationApproval);
      } else {
        const invoked = await execute('discussion.invite', input);
        if (!invoked.ok) throw new WorkflowSessionCompositionError(invoked.errorCode);
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(invoked.result);
        if (approval.success) {
          if (approval.data.actionId !== 'discussion.invite') throw new WorkflowSessionCompositionError('invalid_action_output');
          const execution = { kind: 'action' as const, actionId: 'discussion.invite', actionRequestId,
            localInputId: creationKey, input, output: approval.data };
          await onInvitationApproval?.(execution);
          result = await settleApproval(execution);
        } else result = invoked.result;
      }
      const reserved = DiscussionInviteResultV1Schema.safeParse(result);
      if (!reserved.success || reserved.data.discussionId !== discussionParticipant.discussionId
        || reserved.data.modelParticipant?.participant.participantSlotId !== creationKey) {
        throw new WorkflowSessionCompositionError(result && typeof result === 'object' && 'errorCode' in result
          && typeof result.errorCode === 'string' ? result.errorCode : 'discussion_subject_ineligible');
      }
      // An uncertain retry preserves a person's intervening policy decision;
      // reservation must never silently switch reads-only back to speaking.
      if (reserved.data.modelParticipant.answerPolicy !== 'when_addressed') {
        throw new WorkflowSessionCompositionError('discussion_answer_policy_denied');
      }
      signal?.throwIfAborted();
    }
    const confirmDiscussionBinding = async (sessionId: string) => {
      if (!discussionParticipant || !discussionAction) return;
      const result = await discussionAction({ actionId: 'discussion.participants.list',
        input: { discussionId: discussionParticipant.discussionId },
        context: { serverId: deps.serverId, surface: 'api', authority: 'account_automation' },
        ...(signal ? { signal } : {}),
      });
      const roster = DiscussionParticipantsListResponseV1Schema.safeParse(result);
      const participant = roster.success && roster.data.discussionId === discussionParticipant.discussionId
        ? roster.data.participants.find(row => row.participant.kind === 'model'
          && row.participant.participantSlotId === discussionParticipant.participantSlotId) : undefined;
      if (!participant || !('sessionId' in participant) || participant.sessionId !== sessionId) {
        throw new WorkflowSessionCompositionError('discussion_subject_ineligible');
      }
      if (participant.answerPolicy !== 'when_addressed') throw new WorkflowSessionCompositionError('discussion_answer_policy_denied');
      signal?.throwIfAborted();
    };
    if (retainedStartupOperation) {
      if (!deps.sessionStartup) throw new WorkflowSessionCompositionError('workflow_session_startup_observation_unavailable');
      const created = await deps.sessionStartup({ creationKey, retainedOperation: retainedStartupOperation,
        retainedOperationSnapshot: retainedStartupOperationSnapshot,
        ...(startupAuthorization ? { authorization: startupAuthorization } : {}),
        request: { credentials: deps.credentials, serverId: deps.serverId, machineId: deps.machineId,
          directory: workspace.directory, spawnNonce: creationKey, ...(signal ? { signal } : {}) },
        ...(onStartupObservation ? { onObservation: operation => onStartupObservation(operation, deps.serverId) } : {}) });
      await confirmDiscussionBinding(created.sessionId);
      return { sessionId: created.sessionId, machineId: deps.machineId, directory: workspace.directory,
        origin, workDepth: deps.workDepth + 1 };
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
          signal,
          ...(deps.resolveTeamCredentialResourceCatalog
            ? { resolveTeamCredentialResourceCatalog: deps.resolveTeamCredentialResourceCatalog }
            : {}),
        })
      : null;
    signal?.throwIfAborted();
    const connectedServices = selection.connectedServices ?? connectedServicesDefault?.connectedServices;
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
    let initialSessionRolesV1: SessionRolesV1 | undefined;
    if (deps.originSessionId) {
      const lead = await resolveWorkflowAuthorizedSession({ credentials: deps.credentials, sessionId: deps.originSessionId,
        ...(signal ? { signal } : {}) });
      if (!lead) throw new WorkflowSessionCompositionError('role_target_unavailable');
      await bootstrapAccountSettingsContext({ credentials: deps.credentials, mode: 'blocking' });
      const leadTarget = resolveAgentExecutionTargetFromSessionMetadata(lead.metadata);
      const leadAgent = leadTarget ? resolveSessionCreationAgentTarget(leadTarget) : null;
      // Use ordinary child admission's complete Role observation, including
      // Account/plugin sources and the lead's per-field Session overrides.
      const startContext = await createCliActionDeps({ token: deps.credentials.token, credentials: deps.credentials,
        sessionId: deps.originSessionId, serverId: deps.serverId, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
        rawSession: lead.target.rawSession,
        ...(lead.target.mode === 'plain' ? { mode: 'plain' as const, ctx: null } : { mode: 'e2ee' as const, ctx: lead.target.ctx }),
        getCurrentSessionMetadata: () => lead.metadata,
        getCurrentSessionBackendTarget: () => leadAgent?.backendTarget,
      }).resolveAgentStartContext!({ surface: 'agent', defaultSessionId: deps.originSessionId,
        callerPermissionMode: permissionMode ?? 'default', ...(signal ? { signal } : {}) });
      if (!startContext) throw new WorkflowSessionCompositionError('role_target_unavailable');
      initialSessionRolesV1 = snapshotSessionRolesAtSpawnV1({ leadSessionId: deps.originSessionId,
        roles: { ...startContext.roles, ...(frozenRole ? { [frozenRole.roleId]: frozenRole } : {}) },
        notes: readSessionRolesV1(lead.metadata)?.notes });
    }
    if (frozenRole) initialSessionRolesV1 = { ...(initialSessionRolesV1 ?? {
      overrides: {}, sessionRoles: { [frozenRole.roleId]: frozenRole }, notes: '',
    }), roleId: frozenRole.roleId };
    signal?.throwIfAborted();
    const request: CreateSpawnedSessionParams = {
      credentials: deps.credentials,
      serverId: deps.serverId,
      machineId: deps.machineId,
      directory: target.directory,
      approvedNewDirectoryCreation: false,
      spawnNonce: creationKey,
      ...(observationOnly ? { resumeOnly: true } : {}),
      ...(discussionParticipant ? { originKind: 'discussion', discussionParticipant, discussionParticipantLaunch: launch }
        : { originKind: 'run_step', originRunId: deps.originRunId,
          ...(deps.originSessionId ? { originSessionId: deps.originSessionId,
            manager: { sessionId: deps.originSessionId } } : {}) }),
      ...(team ? {
        initialAccess,
        // Ordinary Team visibility is view-only, not a primary-Team choice.
        // Required Teams use the existing server policy writer and edit floor.
        ...(team.policy.sessionCreationPolicy === 'team_required' ? { primaryTeamId: team.id } : {}),
      } : {}),
      ...(launch?.primaryTeamId !== undefined ? { primaryTeamId: launch.primaryTeamId } : {}),
      ...(launch?.organizationPlacement ? { organizationPlacement: launch.organizationPlacement } : {}),
      ...(launch?.placementOrigin ? { placementOrigin: launch.placementOrigin } : {}),
      ...(launch?.secretReferenceOverlay ? { secretReferenceOverlay: launch.secretReferenceOverlay } : {}),
      ...(launch?.memoryEnabled !== undefined ? { memoryEnabled: launch.memoryEnabled } : {}),
      workDepth: deps.workDepth + 1,
      ...(initialSessionRolesV1 ? { initialSessionRolesV1 } : {}),
      ...(launch?.title ? { initialTitle: launch.title } : initialTitle ? { initialTitle } : {}),
      backendTarget: resolvedAgent.backendTarget,
      agentTarget: selection.agentTarget ?? undefined,
      ...(selection.modelSelection ? { modelSelection: selection.modelSelection } : {}),
      ...(selection.profileId ? { profileId: selection.profileId } : {}),
      ...(selection.launchEnvironment ? { environmentVariables: selection.launchEnvironment.values } : {}),
      ...(selection.providerSessionResume ? { resume: selection.providerSessionResume.providerSessionId } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(launchConfiguration?.workspaceWrites !== undefined ? { workspaceWrites: launchConfiguration.workspaceWrites } : {}),
      ...(selection.allowedTools !== undefined ? { allowedTools: selection.allowedTools } : {}),
      ...(selection.unlistedTools !== undefined ? { unlistedTools: selection.unlistedTools } : {}),
      ...(selection.permissionModeUpdatedAt === undefined ? {} : { permissionModeUpdatedAt: selection.permissionModeUpdatedAt }),
      ...(selection.acpSessionModeId ? { agentModeId: selection.acpSessionModeId } : {}),
      ...(launchConfiguration ? { agentModeUpdatedAt: launchConfiguration.mode.updatedAtMs } : {}),
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
      ...(launch?.teamCredentialBindings !== undefined
        ? { teamCredentialBindings: mergeSessionTeamCredentialBindingIntents({
          explicit: launch.teamCredentialBindings, admitted: connectedServicesDefault?.teamCredentialBindings ?? null,
        }) } : {}),
      ...(selection.capabilitySelection ? { capabilitySelection: selection.capabilitySelection } : {}),
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
    };
    const configuration = launchConfiguration ?? (selection.sessionConfigOptionOverrides || selection.providerSessionResume ? {
      mode: { value: request.agentModeId ?? null, updatedAtMs: request.agentModeUpdatedAt ?? 0 },
      model: { value: request.modelSelection?.ref.modelId ?? null, updatedAtMs: request.modelSelection?.updatedAt ?? 0 },
      permissionIntent: { value: permissionMode ?? null, updatedAtMs: request.permissionModeUpdatedAt ?? 0 },
      options: Object.fromEntries(Object.entries(selection.sessionConfigOptionOverrides?.overrides ?? {})
        .map(([key, option]) => [key, { value: option.value, updatedAtMs: option.updatedAt }])),
      ...(selection.providerSessionResume ? { providerSessionResume: selection.providerSessionResume } : {}),
    } : null);
    const correspondence = buildSessionCreationCorrespondence({
      identity: { sessionCreationTag: deriveWorkflowSessionCreationTag(deps.serverId, deps.originRunId, creationKey) },
      recipe: { execution: { machineId: deps.machineId, directory: { kind: 'path', path: target.directory } },
        organization: request.organizationPlacement ?? { folderId: null, tagIds: [] }, agentTarget: selection.agentTarget!,
        modelSelection: request.modelSelection ?? null, profileId: request.profileId ?? null,
        requestedPermissionMode: permissionMode ?? null, agentModeId: request.agentModeId ?? null, configuration,
        connectedServices: connectedServices ?? null, capabilitySelection: request.capabilitySelection ?? null,
        transcriptStorage: request.transcriptStorage ?? null, terminal: selection.terminal ?? null,
        ...(discussionParticipant ? { discussionParticipant } : {}),
        ...(request.allowedTools !== undefined ? { allowedTools: request.allowedTools } : {}),
        ...(request.unlistedTools !== undefined ? { unlistedTools: request.unlistedTools } : {}),
        ...(request.agentSessionStartupInstructionsV1 ? { agentSessionStartupInstructionsMarkerV1: {
          v: request.agentSessionStartupInstructionsV1.v, id: request.agentSessionStartupInstructionsV1.id,
          revision: request.agentSessionStartupInstructionsV1.revision,
        } } : {}),
      },
    });
    const creationRequest = { ...request, sessionCreationTag: correspondence.sessionCreationTag,
      sessionCreationCorrespondence: correspondence };
    const created = await (deps.sessionStartup
      ? deps.sessionStartup({ creationKey, request: creationRequest, ...(startupAuthorization ? { authorization: startupAuthorization } : {}),
          ...(onStartupObservation ? { onObservation: operation => onStartupObservation(operation, deps.serverId) } : {}) })
      : createSpawnedSession(creationRequest)).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED
        && 'details' in error && error.details && typeof error.details === 'object') {
        // Direct rejection carries the daemon response; nonce settlement
        // carries its final errorDetail alongside the original pending response.
        const details = error.details;
        const response = 'spawnResponse' in details ? details.spawnResponse : undefined;
        const retired = SessionLaunchRetiredV1Schema.safeParse('errorDetail' in details ? details.errorDetail
          : response && typeof response === 'object' && 'errorDetail' in response ? response.errorDetail : undefined);
        if (retired?.success && retired.data.spawnNonce === createSessionCreationSpawnNonce(correspondence.sessionCreationTag)) {
          throw new WorkflowSessionCompositionError(error.code, error.message, undefined, retired.data);
        }
      }
      // Only the exact creator's typed private response proves no runner was
      // admitted. Transport loss and nonce observation remain unresolved.
      if (error instanceof Error && 'code' in error && 'details' in error
        && typeof error.code === 'string' && isDefiniteSpawnPreAdmissionRejection(error.code)) {
        const response = error.details;
        if (response && typeof response === 'object' && 'type' in response && response.type === 'error'
          && 'errorCode' in response && response.errorCode === error.code) {
          // The daemon judges the materialized child environment, not its
          // native inventory probe. A proven no-auth refusal belongs to the
          // Workflow's existing target failure contract, not a spawn-only code.
          throw new WorkflowSessionCompositionError(
            error.code === SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT ? 'target_unavailable' : error.code,
            error.message,
          );
        }
      }
      throw error;
    });
    signal?.throwIfAborted();
    await confirmDiscussionBinding(created.sessionId);
    return { sessionId: created.sessionId, machineId: deps.machineId, directory: target.directory,
      origin, workDepth: deps.workDepth + 1 };
  };
}

/** One refusal/log owner for the compatibility checker and authenticated reuse readers. */
export function workflowConversationUnavailable(
  reason: WorkflowConversationUnavailableDetailsV1['reason'],
  expected: WorkflowConversationUnavailableDetailsV1['expected'] = { kind: 'available' },
  observed: WorkflowConversationUnavailableDetailsV1['observed'] = { kind: 'unavailable' },
  code = 'workflow_conversation_unavailable',
): WorkflowSessionCompositionError {
  return new WorkflowSessionCompositionError(code, code, { code: 'workflow_conversation_unavailable', reason, expected, observed });
}

function workflowConversationFailure(...args: Parameters<typeof workflowConversationUnavailable>): Extract<WorkflowStepExecutionResult, { kind: 'failed' }> {
  const refusal = workflowConversationUnavailable(...args);
  return { kind: 'failed', code: refusal.code, reasonDetails: refusal.details };
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
      // The exact Session can outlive this coordinator, but its retained
      // Machine must still match before any Pending or turn mutation.
      try {
        const authorized = await resolveWorkflowAuthorizedSession({ credentials: deps.credentials,
          sessionId, machineId: params.workspace.machineId });
        if (!authorized) return { kind: 'needs_attention' as const, code: 'workflow_conversation_unavailable' };
      } catch {
        return { kind: 'needs_attention' as const, code: 'workflow_conversation_unavailable' };
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
            return settled.ok ? settleObservedInput(settled.result, settled.replyOutcome)
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
      replyOutcome?: Parameters<typeof classifyWorkflowSessionInputResult>[1],
    ): WorkflowStepExecutionResult => {
      const observed = classifyWorkflowSessionInputResult(result, replyOutcome);
      switch (observed.kind) {
        case 'completed':
        case 'needs_attention':
        case 'failed': return observed;
        case 'pending': return { kind: 'needs_attention', code: 'workflow_step_timeout' };
        case 'cancelled': return { ...observed, code: 'session_input_cancelled' };
      }
    };
    if (params.invocation.execution && !(params.invocation.execution.kind === 'action'
      && (params.invocation.execution.actionId === 'session.spawn_new' || params.invocation.execution.actionId === 'discussion.invite'))) {
      if (params.invocation.execution.kind === 'session_ready') {
        return params.step.inputMode === 'none' ? { kind: 'completed', result: '' }
          : { kind: 'failed', code: 'workflow_execution_target_mismatch' };
      }
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
          if (params.invocation.execution?.kind === 'session') await params.onInputAccepted(params.invocation.execution, acceptedAtMs);
        },
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (!observed.ok && 'withdrawn' in observed && observed.withdrawn) {
        return { kind: 'cancelled', code: 'workflow_origin_input_withdrawn' };
      }
      if (!observed.ok && originInput && observed.code === 'session_not_found') {
        return workflowConversationFailure('session_unavailable', { kind: 'session', ids: [params.invocation.execution.sessionId] },
          { kind: 'unavailable', ids: [observed.code] });
      }
      if (!observed.ok) return observed.code === 'cancelled'
        ? await settleAcceptedInputAfterAbort(params.invocation.execution.sessionId, params.invocation.execution.localInputId)
        : { kind: 'needs_attention', code: observed.code };
      return settleObservedInput(observed.result, 'replyOutcome' in observed ? observed.replyOutcome : undefined);
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
      if (error instanceof WorkflowSessionCompositionError && (error.code === 'approval_required' || error.code === 'approval_unavailable')) {
        return { kind: 'needs_attention', code: error.code };
      }
      if (error instanceof WorkflowSessionCompositionError) return { kind: 'failed', code: error.code,
        ...(error.details ? { reasonDetails: error.details } : {}),
        ...(error.message === error.code ? {} : { message: error.message }) };
      throw error;
    }
    const keepsStepSessionDepth = (prepared.existing?.origin?.kind === 'run_step'
      || prepared.existing?.origin?.kind === 'discussion' && params.participant?.kind === 'model'
        && prepared.existing.origin.discussionParticipant?.discussionId === params.origin?.discussion?.discussion.discussionId)
      && params.conversationBinding?.kind !== 'existing_session'
      && params.execution.conversation?.kind !== 'existing_session'
      && prepared.inputPath !== 'origin_session';
    if (keepsStepSessionDepth && prepared.existing?.workDepth === undefined) {
      return workflowConversationFailure('work_depth_unavailable', { kind: 'number' }, { kind: 'unset' });
    }
    const onOriginInputOffered = params.onOriginInputOffered;
    const inputDepth = keepsStepSessionDepth ? prepared.existing?.workDepth
      : deps.workDepth === undefined ? undefined : deps.workDepth + (prepared.existing ? 0 : 1);
    if (prepared.inputPath === 'origin_session') {
      if (!onOriginInputOffered) {
        return { kind: 'failed', code: 'workflow_origin_input_offer_unavailable' };
      }
      if (!prepared.existing || prepared.existing.sessionId !== params.originSessionId) {
        return workflowConversationFailure(prepared.existing ? 'session_identity_mismatch' : 'origin_session_missing',
          params.originSessionId ? { kind: 'session', ids: [params.originSessionId] } : { kind: 'unset' },
          prepared.existing ? { kind: 'session', ids: [prepared.existing.sessionId] } : { kind: 'unavailable' });
      }
      if (prepared.existing.machineId !== params.workspace.machineId
        || !canonicalAbsolutePathsEqual(prepared.existing.directory, params.workspace.directory)) {
        return workflowConversationFailure(prepared.existing.machineId !== params.workspace.machineId ? 'machine_mismatch' : 'workspace_mismatch',
          { kind: 'object' }, { kind: 'object' }, 'conversation_workspace_mismatch');
      }
    }
    let conversation: Awaited<ReturnType<typeof deps.materializeConversation>>;
    const explicitExisting = params.conversationBinding?.kind === 'existing_session'
      || params.execution.conversation?.kind === 'existing_session';
    if (params.step.inputMode === 'none' || (!params.observationOnly && prepared.existing
      && (explicitExisting || prepared.inputPath === 'origin_session'))) {
      if (params.step.inputMode === 'none' && !params.onSessionReady) return { kind: 'failed', code: 'workflow_session_creation_correspondence_unavailable' };
      if (!params.observationOnly || prepared.existing) await params.beforeInputAdmission();
      assertWorkflowAdmissionSignal(params.signal);
    }
    try {
      conversation = await deps.materializeConversation(prepared, params);
    } catch (error) {
      if (error instanceof WorkflowSessionCompositionError && error.launchFailure) {
        return { kind: 'failed', code: error.code, message: error.message };
      }
      if (params.signal?.aborted) return settleBeforeAdmissionAfterAbort();
      if (error instanceof WorkflowSessionCompositionError && (error.code === 'approval_required' || error.code === 'approval_unavailable')) {
        return { kind: 'needs_attention', code: error.code };
      }
      if (error instanceof WorkflowSessionCompositionError) return { kind: 'failed', code: error.code,
        ...(error.details ? { reasonDetails: error.details } : {}),
        ...(error.message === error.code ? {} : { message: error.message }) };
      throw error;
    }
    if (prepared.inputPath === 'origin_session' && prepared.existing && onOriginInputOffered) {
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
          await onOriginInputOffered({ kind: 'session', sessionId: prepared.existing.sessionId, localInputId: localId },
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
        return workflowConversationFailure('session_unavailable', { kind: 'session', ids: [prepared.existing.sessionId] },
          { kind: 'unavailable', ids: [observed.code] });
      }
      if (!observed.ok) return observed.code === 'cancelled'
        ? await settleAcceptedInputAfterAbort(prepared.existing.sessionId, localId)
        : { kind: 'needs_attention', code: observed.code };
      return settleObservedInput(observed.result);
    }
    if (params.step.inputMode === 'none') {
      await params.onSessionReady!({ kind: 'session_ready', sessionId: conversation.sessionId });
      return { kind: 'completed', result: '' };
    }
    const runtime = prepared.existing?.runtimeSnapshot;
    const selectedControls = runtime ? resolveSessionRuntimeSnapshot({
      incomingOptions: { directory: params.workspace.directory, permissionMode: parsePermissionIntentAlias(requestedPermissionCeiling ?? 'default') ?? undefined,
        permissionModeUpdatedAt: params.execution.permissionModeUpdatedAt, modelSelection: params.execution.modelSelection ?? undefined },
      trackedSpawnOptions: { directory: params.workspace.directory,
        ...(runtime.permissionMode ? { permissionMode: runtime.permissionMode.value, permissionModeUpdatedAt: runtime.permissionMode.updatedAt } : {}),
      },
      trackedModelSelection: runtime.modelSelection,
    }).snapshot : null;
    const text = renderWorkflowSessionStepInput({ input: params.input, result: params.step.result,
      roleInstructions: deps.resolveRoleInstructions?.(params) });
    if (params.observationOnly) {
      const localId = deriveWorkflowSessionInputLocalIdV2({
        purpose: 'invocation', runId: params.runId,
        invocationRecordId: params.invocationRecordId ?? params.invocation.logicalInvocationRecordId,
      });
      let materialized = false;
      const observe = (snapshot: boolean) => sessionInput.observe({
        credentials: deps.credentials, sessionId: conversation.sessionId, localId,
        ...(snapshot ? { deadlineMs: Date.now() } : params.invocation.observationDeadline?.kind === 'at'
          ? { deadlineMs: Date.parse(params.invocation.observationDeadline.expiresAt) }
          : params.step.timeoutMs === undefined ? {} : { timeoutAfterInputMs: params.step.timeoutMs }),
        onInputMaterialized: async (acceptedAtMs) => {
          materialized = true;
          await params.onInputAccepted({ kind: 'session', sessionId: conversation.sessionId, localInputId: localId }, acceptedAtMs);
        },
        ...(params.signal ? { signal: params.signal } : {}),
      });
      // An admitting row can survive interruption before the send. Snapshot
      // its exact input first: without materialization proof, waiting with no
      // authored deadline can never distinguish that gap from active work.
      let observed = await observe(!params.invocation.execution);
      if (observed.ok && observed.result.kind === 'pending' && !params.invocation.execution) {
        if (!materialized) return { kind: 'needs_attention', code: 'workflow_admission_ack_uncertain' };
        observed = await observe(false);
      }
      if (!observed.ok) return observed.code === 'cancelled'
        ? await settleAcceptedInputAfterAbort(conversation.sessionId, localId)
        : { kind: 'needs_attention', code: observed.code };
      return settleObservedInput(observed.result, observed.replyOutcome);
    }
    await params.beforeInputAdmission();
    assertWorkflowAdmissionSignal(params.signal);
    const discussionDestination = params.input.discussionReplyTo ?? params.origin?.discussion;
    const admission = await sessionInput.enqueue({
      credentials: deps.credentials,
      sessionId: conversation.sessionId,
      targetMachineId: params.workspace.machineId,
      // The step's visible number travels on its provenance, so the transcript shows the number the
      // step's heading and Session title show (stamped here, never recomputed by a reader).
      workflow: { purpose: 'invocation', runId: params.runId, invocationRecordId: params.invocationRecordId ?? params.invocation.logicalInvocationRecordId,
        ...(params.stepOrdinal === undefined ? {} : { stepOrdinal: params.stepOrdinal }) },
      ...(inputDepth === undefined ? {} : { workDepth: inputDepth }),
      text,
      ...(params.input.displayText === undefined ? {} : { displayText: params.input.displayText }),
      mentions: params.input.references,
      attachments: params.input.attachments,
      machineAdmissionTransport: conversation.machineAdmissionTransport,
      permissionMode: params.execution.permissionMode === null ? null : selectedControls?.permissionMode?.value ?? requestedPermissionCeiling,
      incomingResumeOptions: workflowSessionResumeOptions(params.execution),
      ...(params.authorization.sourceAuthority
        ? { sourceAuthority: params.authorization.sourceAuthority }
        : {}),
      ...(params.origin?.actionRequestAttributionV1
        ? { actionRequestAttributionV1: params.origin.actionRequestAttributionV1 }
        : {}),
      ...(discussionDestination ? { discussionAddressing: {
        discussionId: discussionDestination.discussion.discussionId,
        messageId: discussionDestination.messageId,
        throughSeq: discussionDestination.throughSeq,
        participantSessionId: conversation.sessionId,
      } } : {}),
      ...(params.execution.modelSelection === undefined
        ? {}
        : { modelSelectionInput: params.execution.modelSelection === null ? { modelId: null }
            : selectedControls?.modelSelection
              ? selectedControls.modelSelection.value ?? { modelId: null }
              : params.execution.modelSelection.ref ?? { modelId: null },
          ...(params.execution.modelSelection === null ? {} : { modelSelectionUpdatedAt: selectedControls?.modelSelection?.updatedAt ?? params.execution.modelSelection.updatedAt }) }),
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
    return settleObservedInput(observed.result, observed.replyOutcome);
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

function workflowSelectionDiagnostic(
  field: keyof WorkflowSessionAuthoringSelection,
  selection: WorkflowSessionAuthoringSelection,
): WorkflowConversationUnavailableDetailsV1['expected'] {
  const value = selection[field];
  if (value === undefined) return { kind: 'unset' };
  if (value === null) return { kind: 'null' };
  if (field === 'agentTarget' && selection.agentTarget?.kind === 'agent') {
    return { kind: 'agent', ids: [`${selection.agentTarget.identity.pluginId}/${selection.agentTarget.identity.localId}`] };
  }
  // Only these schema-owned identifiers are safe to disclose. In particular, configuration
  // option values, terminal names and runtime bags can contain arbitrary private content.
  if ((field === 'profileId' || field === 'acpSessionModeId' || field === 'transcriptStorage'
    || field === 'windowsRemoteSessionLaunchMode' || field === 'windowsRemoteSessionConsole')
    && typeof value === 'string') return { kind: 'string', ...(value ? { ids: [value] } : {}) };
  if (field === 'connectedServices' && selection.connectedServices) {
    return { kind: 'object', ids: Object.entries(selection.connectedServices.bindingsByServiceId).flatMap(([serviceId, binding]) => [
      serviceId, binding.source,
      ...(binding.source === 'connected' ? [binding.selection ?? 'profile',
        ...(binding.profileId ? [binding.profileId] : []), ...('groupId' in binding ? [binding.groupId] : [])] : []),
      ...(binding.source === 'team_resource' ? [binding.resourceId, binding.deliveryMode] : []),
    ]) };
  }
  if (field === 'sessionConfigOptionOverrides' && selection.sessionConfigOptionOverrides) {
    return { kind: 'object', ids: Object.keys(selection.sessionConfigOptionOverrides.overrides) };
  }
  if (Array.isArray(value)) return { kind: 'array' };
  return { kind: typeof value === 'object' ? 'object' : typeof value === 'boolean' ? 'boolean'
    : typeof value === 'number' ? 'number' : 'string' };
}

function assertWorkflowSessionReuseCompatible(
  requested: WorkflowSessionAuthoringSelection,
  actual: WorkflowSessionConversation,
  keepSessionAgent = false,
): void {
  // Explicit existing targets keep their Agent; the canonical resume snapshot
  // decides which authored launch controls can apply when the runner is offline.
  for (const field of WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS) {
    if (keepSessionAgent && field !== 'allowedTools' && field !== 'unlistedTools') continue;
    // These two supported next-input choices are applied by Session Pending.
    if (field === 'modelSelection' || field === 'permissionMode'
      || requested[field] === undefined) continue;
    const retained = field === 'agentTarget' ? actual.agentTarget : actual.runtimeSelection?.[field];
    const retainedSelection = field === 'agentTarget' ? { agentTarget: actual.agentTarget } : actual.runtimeSelection ?? {};
    if (field === 'capabilitySelection' && requested.capabilitySelection && actual.runtimeSelection?.capabilitySelection
      && areSessionCapabilitySelectionsEquivalentV1(requested.capabilitySelection, actual.runtimeSelection.capabilitySelection)) continue;
    let requestedValue: unknown = requested[field];
    let retainedValue: unknown = retained;
    // Native and pre-profile Session metadata omit the authored no-profile choice.
    if (field === 'profileId') retainedValue = retained ?? null;
    if (field === 'unlistedTools') retainedValue = retained ?? 'ask';
    if (field === 'acpSessionModeId') {
      requestedValue = resolveSessionModeOverrideValue(requested.acpSessionModeId, actual.sessionModes);
      retainedValue = resolveSessionModeOverrideValue(actual.runtimeSelection?.acpSessionModeId, actual.sessionModes);
    }
    if (field === 'sessionConfigOptionOverrides') {
      const requestedConfig = requested.sessionConfigOptionOverrides;
      const retainedConfig = actual.runtimeSelection?.sessionConfigOptionOverrides;
      if (requestedConfig && Object.keys(requestedConfig.overrides).some((id) => !retainedConfig?.overrides[id])) {
        throw workflowConversationUnavailable(field, workflowSelectionDiagnostic(field, requested), workflowSelectionDiagnostic(field, retainedSelection));
      }
      requestedValue = requestedConfig && Object.fromEntries(Object.entries(requestedConfig.overrides).map(([id, entry]) => [id, entry.value]));
      retainedValue = requestedConfig && retainedConfig && Object.fromEntries(Object.keys(requestedConfig.overrides)
        .map((id) => [id, retainedConfig.overrides[id]?.value]));
    }
    if (retainedValue === undefined
      || createCanonicalJsonSigningInput(requestedValue) !== createCanonicalJsonSigningInput(retainedValue)) {
      throw workflowConversationUnavailable(field, workflowSelectionDiagnostic(field, requested), workflowSelectionDiagnostic(field, retainedSelection));
    }
  }
}

/** Session identity stays exact; authored continuity is interpreted by the common binder. */
export function createProductionWorkflowConversationOwner(deps: Readonly<{
  credentials?: StoredCredentials;
  serverId?: string;
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
    onUnavailable?: (details: WorkflowConversationUnavailableDetailsV1) => void;
  }>) => Promise<WorkflowSessionConversation | null>;
}>): ProductionWorkflowConversationOwner {
  const readExisting = async (params: Parameters<typeof deps.resolveExistingSessionConversation>[0]) => {
    let refusal: WorkflowConversationUnavailableDetailsV1 | undefined;
    const actual = await deps.resolveExistingSessionConversation({ ...params, onUnavailable: (details) => { refusal = details; } });
    if (!actual && refusal) throw new WorkflowSessionCompositionError(refusal.code, refusal.code, refusal);
    return actual;
  };
  return {
    prepare: async (params): Promise<PreparedWorkflowSessionConversation> => {
      params.signal?.throwIfAborted();
      if (params.participant?.kind === 'session') {
        if (deps.serverId && params.participant.session.serverId !== deps.serverId
          && !await isServerProfileHomeIdentity(deps.serverId, params.participant.session.serverId)) {
          throw new WorkflowSessionCompositionError('target_unavailable');
        }
        if (params.conversationBinding?.kind !== 'existing_session'
          || params.conversationBinding.sessionId !== params.participant.session.sessionId
          || params.conversationBinding.machineId !== params.participant.machineId) {
          throw new WorkflowSessionCompositionError('workflow_execution_target_mismatch');
        }
      }
      if (params.invocation.execution?.kind === 'action'
        && (params.invocation.execution.actionId === 'session.spawn_new'
          || (params.invocation.execution.actionId === 'discussion.invite' && params.participant?.kind === 'model'))) {
        return { kind: 'workflow_session_conversation', existing: null };
      }
      const isOrigin = params.conversationBinding?.kind === 'origin_session'
        || params.execution.conversation?.kind === 'origin_session';
      if (!params.invocation.execution && isOrigin && params.invocation.recovery?.conversation === 'fresh_agent') {
        throw new WorkflowSessionCompositionError('workflow_recovery_conversation_unsupported');
      }
      const resolution = resolveWorkflowConversationSelection(params);
      if (resolution.kind === 'unavailable') throw workflowConversationUnavailable('recovery_execution_missing');
      if (resolution.kind === 'observe') {
        if (resolution.execution.kind !== 'session' && resolution.execution.kind !== 'session_ready') {
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
        throw workflowConversationUnavailable('workspace_mismatch', { kind: 'object', ids: ['new_worktree'] },
          { kind: 'object', ids: [selection?.kind ?? 'origin_session'] }, 'conversation_workspace_mismatch');
      }
      let existing: WorkflowSessionConversation | null = null;
      if (resolution.kind === 'retained') {
        if (resolution.execution.kind !== 'session' && resolution.execution.kind !== 'session_ready') {
          throw workflowConversationUnavailable('target_kind_mismatch', { kind: 'session' }, { kind: resolution.execution.kind });
        }
        const machineId = params.recoveryPreviousWorkspace?.machineId;
        if (!machineId) throw workflowConversationUnavailable('machine_mismatch', { kind: 'string' }, { kind: 'unset' });
        existing = await readExisting({
          sessionId: resolution.execution.sessionId, machineId,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (!existing) throw workflowConversationUnavailable('session_unavailable', { kind: 'session', ids: [resolution.execution.sessionId] });
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
        if (!existing) throw workflowConversationUnavailable('producer_conversation_missing', { kind: 'session', ids: [selection.producer.blockId] });
      } else if (selection?.kind === 'existing_session') {
        existing = await readExisting({
          sessionId: selection.sessionId,
          machineId: selection.machineId,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (!existing) throw workflowConversationUnavailable('session_unavailable', { kind: 'session', ids: [selection.sessionId] });
      } else if (selection?.kind === 'origin_session') {
        if (!params.originSessionId) throw workflowConversationUnavailable('origin_session_missing');
        existing = await readExisting({
          sessionId: params.originSessionId, machineId: deps.machineId,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (!existing || existing.sessionId !== params.originSessionId) {
          throw workflowConversationUnavailable(existing ? 'session_identity_mismatch' : 'session_unavailable',
            { kind: 'session', ids: [params.originSessionId] }, existing ? { kind: 'session', ids: [existing.sessionId] } : { kind: 'unavailable' });
        }
      }
      if (isOrigin && existing && existing.machineId !== deps.machineId) {
        throw workflowConversationUnavailable('machine_mismatch', { kind: 'string', ids: [deps.machineId] }, { kind: 'string', ids: [existing.machineId] });
      }
      if (isOrigin && (!existing || !params.originSessionId || existing.sessionId !== params.originSessionId)) {
        throw workflowConversationUnavailable(existing && params.originSessionId ? 'session_identity_mismatch' : 'origin_session_missing',
          params.originSessionId ? { kind: 'session', ids: [params.originSessionId] } : { kind: 'available' },
          existing ? { kind: 'session', ids: [existing.sessionId] } : { kind: 'unavailable' });
      }
      if (existing && selection?.kind !== 'existing_session' && !isOrigin) {
        const actual = resolution.kind === 'retained' ? existing : await readExisting({
          sessionId: existing.sessionId, machineId: existing.machineId,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (!actual) throw workflowConversationUnavailable('session_unavailable', { kind: 'session', ids: [existing.sessionId] });
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
        if (prepared.existing.machineId !== params.workspace.machineId) {
          throw workflowConversationUnavailable('machine_mismatch', { kind: 'string', ids: [prepared.existing.machineId] },
            { kind: 'string', ids: [params.workspace.machineId] }, 'conversation_workspace_mismatch');
        }
        if (!canonicalAbsolutePathsEqual(prepared.existing.directory, params.workspace.directory)) {
          throw workflowConversationUnavailable('workspace_mismatch', { kind: 'object' }, { kind: 'object' }, 'conversation_workspace_mismatch');
        }
        if (params.step.inputMode === 'none' || (!params.observationOnly && (
          params.conversationBinding?.kind === 'existing_session' || params.execution.conversation?.kind === 'existing_session'
          || prepared.inputPath === 'origin_session'
        ))) {
          const credentials = deps.credentials;
          if (!credentials) throw workflowConversationUnavailable('account_scope_unavailable');
          let refusal: WorkflowConversationUnavailableDetailsV1 | undefined;
          const authorized = await resolveWorkflowAuthorizedSession({ credentials,
            sessionId: prepared.existing.sessionId, machineId: prepared.existing.machineId,
            onUnavailable: (details) => { refusal = details; },
            ...(params.signal ? { signal: params.signal } : {}) });
          if (!authorized) throw refusal ? new WorkflowSessionCompositionError(refusal.code, refusal.code, refusal)
            : workflowConversationUnavailable('session_unavailable', { kind: 'session', ids: [prepared.existing.sessionId] });
          // A live origin receives context through its existing host input queue.
          // It needs neither native resume support nor another launch/configuration request.
          if (prepared.inputPath === 'origin_session' && authorized.target.rawSession.active === true) {
            return prepared.existing;
          }
          const resumed = await requestInactiveSessionResume({ credentials,
            sessionId: prepared.existing.sessionId, requestId: `workflow:${params.runId}:${params.invocationRecordId ?? params.invocation.logicalInvocationRecordId}:session-ready`,
            rawSession: authorized.target.rawSession, metadata: authorized.metadata,
            executionAuthority: 'account_automation',
            incomingOptions: workflowSessionResumeOptions(params.execution), waitForReady: true,
            machineRpcTransport: async (method, request, options) => await callExactMachineRpc({
              credentials, machineId: prepared.existing!.machineId, requireCurrentMachine: true,
              authorityCeiling: 'account_automation', method, request, ...options,
            }),
            ...(params.signal ? { signal: params.signal } : {}) });
          if (!resumed.ok) throw new WorkflowSessionCompositionError(resumed.code);
        }
        return prepared.existing;
      }
      params.signal?.throwIfAborted();
      if (!params.execution.agentTarget) throw new WorkflowSessionCompositionError('target_unavailable');
      const { conversation: _conversation, workspace: _workspace, ...selection } = params.execution;
      const frozenRole = deps.resolveFrozenRole?.(params);
      const initialTitle = params.stepOrdinal === undefined ? null : formatWorkflowStepSessionTitle({
        step: params.step, stepOrdinal: params.stepOrdinal,
        ...(params.item ? { item: params.item } : {}),
      });
      const conversation = await deps.createFreshConversation({
        selection,
        ...(params.participant?.kind === 'model' ? { launch: params.participant.launch } : {}),
        ...(frozenRole ? { frozenRole } : {}),
        ...(initialTitle === null ? {} : { initialTitle }),
        workspace: params.workspace,
        creationKey: `workflow:${params.runId}:${params.invocationRecordId ?? params.invocation.logicalInvocationRecordId}`,
        startupAuthorization: params.authorization,
        ...(params.origin ? { origin: params.origin } : {}),
        ...(params.invocation.execution?.kind === 'action' && params.invocation.execution.actionId === 'discussion.invite'
          ? { retainedInvitationApproval: params.invocation.execution } : {}),
        onInvitationApproval: async execution => await params.onExecutionObservation?.({ execution }),
        ...(params.invocation.execution?.kind === 'action' && params.invocation.execution.actionId === 'session.spawn_new'
          && params.invocation.execution.awaitedOperations?.[0]
          ? { retainedStartupOperation: params.invocation.execution.awaitedOperations[0],
            retainedStartupOperationSnapshot: params.invocation.execution.output
              && typeof params.invocation.execution.output === 'object' && !Array.isArray(params.invocation.execution.output)
              && 'operation' in params.invocation.execution.output
              ? params.invocation.execution.output.operation : undefined } : {}),
        onStartupObservation: async (operation, serverId) => {
          if (operation.actionId !== 'session.spawn_new' || operation.scope.machineId !== params.workspace.machineId) {
            throw new Error('workflow_invocation_fact_conflict');
          }
          const creationKey = `workflow:${params.runId}:${params.invocationRecordId ?? params.invocation.logicalInvocationRecordId}`;
          await params.onExecutionObservation?.({ execution: { kind: 'action', actionId: operation.actionId,
            actionRequestId: creationKey, localInputId: creationKey, input: { creationKey },
            output: projectNativeJsonValueForTransport({ operation }),
            awaitedOperations: [{ key: 'startup', serverId,
              machineId: params.workspace.machineId, operationId: operation.operationId }] },
            ...(operation.setupReview ? { setupConsentOutput: { operation } } : {}) });
        },
        ...(params.observationOnly ? { observationOnly: true } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      params.signal?.throwIfAborted();
      if (conversation.machineId !== deps.machineId
        || !canonicalAbsolutePathsEqual(conversation.directory, params.workspace.directory)) {
        throw conversation.machineId !== deps.machineId
          ? workflowConversationUnavailable('machine_mismatch', { kind: 'string', ids: [deps.machineId] }, { kind: 'string', ids: [conversation.machineId] })
          : workflowConversationUnavailable('workspace_mismatch', { kind: 'object' }, { kind: 'object' });
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
  resolveFrozenRole?: Parameters<typeof createProductionWorkflowConversationOwner>[0]['resolveFrozenRole'];
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
  resolveExistingSessionConversation: Parameters<typeof createProductionWorkflowConversationOwner>[0]['resolveExistingSessionConversation'];
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
