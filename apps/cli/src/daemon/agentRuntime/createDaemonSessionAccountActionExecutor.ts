import { projectSessionActionIssuerRefusal } from '@/api/externalActionIssuerRefusal';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec, requiresRequesterAppReview, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { SessionSpawnNewAgentAuthoringInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { AgentStartSessionCallerV1Schema, readAgentStartCallerWorkDepthV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { createActionExecutor, ActionExecuteResult, ActionExecutorContext, ExternalActionExecutionAuthorizationV1, ExternalActionTargetV1 } from '@happier-dev/protocol';
import type { ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isSessionActionRpcMethodV1, type SessionActionRpcOriginV1 } from '@happier-dev/protocol/socketRpc';
import { readProjectExecutionOutputMachineAdmissionMethodV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { sameStrictJsonValue, StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { ActionIdSchema, ACTION_ID_FAMILIES_V1, ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { isWorkspaceSyncStopAction, prepareWorkspaceSyncStopPlacement } from '@/workspaces/sync/resolveWorkspaceSyncStopController';
import { TELEMETRY_COSTS_READ_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { USAGE_SOURCE_DISMISS_ACTION_ID, USAGE_SOURCE_GET_ACTION_ID } from '@happier-dev/protocol/usage/usageSources';
import { USAGE_QUERY_ACTION_ID_V1 } from '@happier-dev/protocol/usage/usageActionIdsV1';
import { MACHINE_ACTIVITY_LIST_ACTION_ID } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';
import { readPluginActionExecutionReference } from '@/session/actions/createDaemonPluginActionExecutor';
import { blocksPublicProviderComment, INTERNAL_DISCUSSION_REPLY_MESSAGE, INTERNAL_DISCUSSION_REPLY_REQUIRED }
  from '@/plugins/runtime/invocation/actions/internalDiscussionCommentPolicy';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { isWorkflowHostAdmittedChildActionIdV1, isWorkflowObservationSetupChildActionV1 } from '@happier-dev/protocol/actions/clientDispatchV1';
import { WORKFLOW_AUTHORING_ACTION_ID } from '@happier-dev/protocol/actions/workflowAuthoringActionIds';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { resolveSessionStoredContentEncryptionMode, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionApprovalProfileReferenceV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { resolveSessionRoleRpcOrigin } from '@/session/actions/sessionRoleRpcOrigin';
import { resolveActionOriginationPreferenceFailureV1 } from '@happier-dev/protocol/actions/executor/actionOriginationPreferences';
import { actionInputValidationFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import { bindCallerInput } from '@happier-dev/protocol/actions/executor/callerInput';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { logger } from '@/ui/logger';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { resolveCliActionCallerWorkflowTarget } from '@/session/actions/resolveCliActionCallerSession';
import { WorkflowActionFailureV1Schema, WorkflowTargetUnavailableDetailsV1Schema, type WorkflowTargetUnavailableReasonV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { ActionStartDiagnosticV1, ActionStartPhaseV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { isAgentStartActionInvocationV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ActionCurrentSessionScopeFailureDetailsV1Schema, type ActionCurrentSessionScopeFailureDetailsV1 } from '@happier-dev/protocol/actions/executor/sessionListAccess';
import { createExternalActionStartDiagnosticRecorder, runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';
import { DiscussionAgentPublisherResponseV1Schema, type DiscussionAgentPublisherRequestV1 } from '@happier-dev/protocol/discussions/api';
import { DISCUSSION_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/discussions/actions';
import { isDiscussionActionIdV1 } from '@happier-dev/protocol/discussions/actionIds';
import { matchesDiscussionTaskAnchorV1, projectDiscussionTaskFirstPostV1 } from '@happier-dev/protocol/actions/discussionActionFamily';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import { bindDiscussionDraftReply } from '@/discussions/bindDiscussionDraftReply';
import { prepareDocDiscussionMutationV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { prepareDocEditProposalInputV1 } from '@happier-dev/protocol/actions/executor/docCollaborationActions';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { isDiscussionDocEditProposalContentV1, readDiscussionMentionedParticipantIdsV1 } from '@happier-dev/protocol/discussions/content';
import { readRequesterHomeActionFailure, readRequesterHomeWithinActionLifetime } from '@/daemon/sessionEncryption/requesterCurrentness';
import { bindScmActionToSessionWorkspace } from '@/scm/actions/placement';
import { requiresExplicitScmMachineTarget } from '@happier-dev/protocol/actions/actionSpecs';
import { readContributedActionExecutionPlacement } from '@/session/actions/readContributedActionExecutionPlacement';
import { readServerIdentityIdFromFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createClientActionReverseDispatcher, type ClientActionMachineRpc } from '@/session/actions/clientActionReverseDispatch';
import { isManagedPresetAcquireInputV1, ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MANAGED_ACQUIRE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { readManagedMachinePreset } from '@/machines/managed/readManagedMachine';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';

type SessionActionOperation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;
type SessionActionAuthority = Readonly<{ sessionId: string; isCurrent(): Promise<boolean>; signal?: AbortSignal;
  actionInvocation?: import('@happier-dev/protocol/sessions/creation/externalActionRequesterInvocationBaseV1').ExternalActionRequesterInvocationBaseV1 }>;
type DiscussionAgentPublisher = NonNullable<Parameters<typeof createDiscussionActionDeps>[0]['postAgentMessage']>;
type SessionAccountActionRefusalReason =
  | 'runtime_authority_unavailable'
  | 'caller_witness_invalid'
  | 'session_owner_missing'
  | 'session_not_owner'
  | 'session_owner_read_failed'
  | 'session_action_origin_invalid'
  | 'external_authorization_refused'
  | 'external_authorization_missing'
  | 'external_authorization_binding_mismatch'
  | 'external_authorization_preparation_failed'
  | 'action_executor_refused';
/** The single content-free projection for the existing Session Action refusal line. */
export function logDaemonSessionAccountActionRefusalV1(operation: SessionActionOperation, sessionId: string,
  diagnostic: Readonly<{ reason: SessionAccountActionRefusalReason; errorCode?: 'target_unavailable' | 'unsupported_action';
    scopeFailureCause?: ActionCurrentSessionScopeFailureDetailsV1['cause'];
    refusalCode?: 'target_unavailable'; refusalReason?: WorkflowTargetUnavailableReasonV1;
    refusalPhase?: ActionStartPhaseV1; elapsedSubphasesMs?: Partial<Record<ActionStartPhaseV1, number>>;
    requesterRuntimeBound?: boolean }>) {
  logger.warnLocalFile('[Session Account Action] Refused', {
    actionId: operation.actionId, sessionId, requestId: operation.requestId, turnId: operation.witness.turnId,
    ...diagnostic,
  });
}
export type SessionAccountActionAuthorizationPreparation = Readonly<{
  operation: Pick<SessionActionOperation, 'actionId' | 'input' | 'requestId' | 'surface'>;
  authority: SessionActionAuthority;
  isCallerCurrent(): Promise<boolean>;
  sessionActionOrigin: SessionActionRpcOriginV1;
  /** Selected by the existing host target owner, never by an author-provided authority field. */
  targetMachineId?: string;
  /** Caller workspace resolved under authenticated Session custody, before Home minting. */
  workflowTarget?: Extract<ExternalActionTargetV1, { kind: 'machine' }>;
}>;

/** Adapts authenticated Session custody to the existing credentialed Account executor. */
export function createDaemonSessionAccountActionExecutor(params: Readonly<{
  getMachineClient?: () => ClientActionMachineRpc | null | undefined;
  serverId: string;
  serverHttpBaseUrl: string;
  token: string;
  credentials?: StoredCredentials;
  /** The admitted Account encryption mode of `credentials`; opens the admitted Session's owner metadata once. */
  readAccountEncryptionMode?: (signal?: AbortSignal) => Promise<import('@happier-dev/protocol').AccountEncryptionCurrentnessResponse['mode']>;
  /** Existing observation of this daemon's bound Home, distinct from its local profile. */
  resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined | Promise<CliServerFeaturesSnapshot | undefined>;
  /** The installed daemon producer, independent of optional public-API proof. */
  machineId?: string;
  /** Content-free observations from the startup requester-runtime binding. */
  initialStartDiagnostic?: ActionStartDiagnosticV1;
  createExecutor: (getCurrentTurnWorkDepth: (turnId?: string) => number | undefined,
    isCallerCurrent: () => Promise<boolean>, postAgentDiscussionMessage?: DiscussionAgentPublisher,
    options?: Readonly<{ accountPluginActions: true }>) => Pick<ReturnType<typeof createActionExecutor>, 'execute' | 'prepare'>;
  /** Existing Session RPC transport to the actual current client, with this operation's admitted witness. */
  postAgentDiscussionMessage?: (request: DiscussionAgentPublisherRequestV1, witness: SessionActionOperation['witness'],
    options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
  /** Host-only producer of original Home authority; author input cannot install this port. */
  prepareExternalActionAuthorization?: (input: SessionAccountActionAuthorizationPreparation) => Promise<Readonly<{
    authorization: ExternalActionExecutionAuthorizationV1; target: ExternalActionTargetV1;
    /** Exact V1/V2 envelope retained by the original Home authorization producer. */
    originalActionEnvelope?: ExternalActionRequestEnvelope;
    /** Home-observed version that must govern daemon-side Account policy admission. */
    accountSettingsVersion?: number;
    /** Local receiving ingress retained by the original installed Session issuer. */
    verifyMachineAdmissionCurrent?: ActionExecutorContext['verifyMachineAdmissionCurrent'];
  }> | ActionExecuteFailure | null | undefined>;
}>) {
  const actionSettingsProvider = runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => createActionSettingsProvider({
    scopeKey: resolveAccountSettingsScopeKeyForToken(params.token),
  }));
  const execute = async (operation: SessionActionOperation, authority: SessionActionAuthority, observationSetup?: true, targetMachineId?: string): Promise<ActionExecuteResult> => {
    const elapsedSubphasesMs: Partial<Record<ActionStartPhaseV1, number>> = {};
    const recordPhase = params.machineId
      ? createExternalActionStartDiagnosticRecorder(operation.actionId, operation.requestId, params.machineId)
      : undefined;
    let firstRefusal: Pick<ActionStartDiagnosticV1, 'phase' | 'refusalReason'> | undefined;
    let requesterRuntimeBound: boolean | undefined;
    const recordActionStartDiagnostic = (event: ActionStartDiagnosticV1) => {
      recordPhase?.(event);
      if (event.elapsedMs !== undefined && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0)
        elapsedSubphasesMs[event.phase] = (elapsedSubphasesMs[event.phase] ?? 0) + event.elapsedMs;
      if (event.refusalReason && !firstRefusal) firstRefusal = { phase: event.phase, refusalReason: event.refusalReason };
      if (event.requesterRuntimeBound !== undefined) requesterRuntimeBound = event.requesterRuntimeBound;
    };
    if (params.initialStartDiagnostic) recordActionStartDiagnostic(params.initialStartDiagnostic);
    const logRefusal = (reason: SessionAccountActionRefusalReason, failure?: Readonly<{
      errorCode: 'target_unavailable' | 'unsupported_action'; scopeFailureCause?: ActionCurrentSessionScopeFailureDetailsV1['cause'];
      refusalCode?: 'target_unavailable'; refusalReason?: WorkflowTargetUnavailableReasonV1;
    }>) => logDaemonSessionAccountActionRefusalV1(operation, authority.sessionId, {
      reason, ...failure,
      ...(firstRefusal ? { refusalPhase: firstRefusal.phase, refusalReason: firstRefusal.refusalReason } : {}),
      elapsedSubphasesMs,
      ...(requesterRuntimeBound !== undefined ? { requesterRuntimeBound } : {}),
    });
    const refuse = (reason: SessionAccountActionRefusalReason,
      errorCode: 'target_unavailable' | 'cancelled' = 'target_unavailable'): ActionExecuteResult => {
      if (errorCode === 'cancelled') return { ok: false, errorCode, error: errorCode };
      logRefusal(reason);
      return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable', details: { reason } };
    };
    if (authority.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    if (!await authority.isCurrent()) return refuse('runtime_authority_unavailable');
    // The active occurrence lookup supplies the accepted Account Voice fact.
    // Its owning App retains that admission and executes through its front door.
    if (authority.actionInvocation?.surface === 'voice' && authority.actionInvocation.caller.kind === 'host'
      && operation.executionRun) {
      const sessionAccountId = readAccountIdFromToken(params.token);
      return await createClientActionReverseDispatcher(params.getMachineClient ?? (() => null), {
        ...operation.executionRun, sessionId: authority.sessionId, turnId: operation.witness.turnId,
        actionRequestId: operation.requestId,
      })({ actionId: operation.actionId, input: operation.input, context: {
        // The Session's Account; the daemon socket reaches only its own Apps.
        ...(sessionAccountId ? { runtimeAccountId: sessionAccountId } : {}),
        ...(authority.signal ? { signal: authority.signal } : {}),
      } });
    }
    const operationSurface = operation.surface ?? 'agent';
    // An Ask-first plugin install only retains the daemon-evaluated candidate
    // in an ordinary Approval Artifact. The Machine effect is admitted later
    // by the present-user replay, so proposal creation must not require the
    // requester's external effect authorization. A waived/direct install still
    // reaches the Machine now and therefore keeps the existing requirement.
    const proposesPluginInstallApproval = operation.actionId === 'plugins.install'
      && isApprovalRequiredByActionsSettings(operation.actionId, actionSettingsProvider.getActionsSettings(), {
        surface: operationSurface,
        authority: 'account_automation',
      }, undefined, undefined, operation.input);
    const witness = operation.witness;
    const caller = AgentStartSessionCallerV1Schema.safeParse(witness.agentStartCaller);
    if (!caller.success || caller.data.sessionId !== authority.sessionId
      || witness.workDepth !== readAgentStartCallerWorkDepthV1(caller.data)) {
      return refuse('caller_witness_invalid');
    }
    const actionSpec = getActionSpec(operation.actionId);
    // Process/Session custody does not authorize borrowing the daemon Account.
    // The exact authenticated Home's owner projection proves same-account use
    // once, at this Action's admission; a shared recipient requires its own
    // admitted requester execution channel. Later steps of the admitted Action
    // use runtime custody and cancellation; a changed owner applies at the next
    // Action admission.
    // The same owner read admits the Session's approval profile once; the executor's
    // profile reader does not read the Session again for this Action.
    const admitted: {
      approvalProfile?: Readonly<{ approvalProfileId: string | null; approvalProfileTeamOrGroupDerived: boolean }> | null;
      sessionEncryptionMode?: ActionExecutorContext['sourceSessionEncryptionMode'];
    } = {};
    const callerRefusal = await runTracedExternalActionStage(
      operation.actionId, operation.requestId, 'session_action.caller_currentness', async (): Promise<SessionAccountActionRefusalReason | null> => {
      try {
        return await readRequesterHomeWithinActionLifetime(async (): Promise<SessionAccountActionRefusalReason | null> => {
          if (authority.signal?.aborted || !await authority.isCurrent()) return 'runtime_authority_unavailable';
          const credentials = params.credentials;
          const [session, accountEncryptionMode] = await Promise.all([fetchSessionById({ reason: 'session-action',
            token: params.token, serverUrl: params.serverHttpBaseUrl, sessionId: authority.sessionId,
            ...(authority.signal ? { signal: authority.signal } : {}),
          }), credentials && params.readAccountEncryptionMode ? params.readAccountEncryptionMode(authority.signal) : undefined]);
          if (!session || session.id !== authority.sessionId) return 'session_owner_missing';
          if (readSessionAccessProjectionRoleV1(session) !== 'owner') return 'session_not_owner';
          admitted.sessionEncryptionMode = session.encryptionMode === undefined
            ? 'unknown' : resolveSessionStoredContentEncryptionMode(session);
          if (credentials && accountEncryptionMode) {
            const metadata = tryDecryptSessionOwnerMetadataView({ credentials, accountEncryptionMode, rawSession: session });
            admitted.approvalProfile = metadata ? { approvalProfileId: resolveSessionApprovalProfileReferenceV1(metadata),
              approvalProfileTeamOrGroupDerived: metadata.approvalProfileTeamOrGroupDerived === true } : null;
          }
          return !authority.signal?.aborted && await authority.isCurrent() ? null : 'runtime_authority_unavailable';
        }, authority.signal);
      } catch {
        return 'session_owner_read_failed';
      }
    });
    const isCallerCurrent = async (): Promise<boolean> => !authority.signal?.aborted && await authority.isCurrent();
    if (callerRefusal) return refuse(callerRefusal, authority.signal?.aborted ? 'cancelled' : 'target_unavailable');
    if (admitted.approvalProfile === null) {
      return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
    }
    const reviewCommentPrincipal = operation.reviewCommentPrincipal;
    if (reviewCommentPrincipal && (reviewCommentPrincipal.actor.kind !== 'agent'
      || reviewCommentPrincipal.actor.sessionId !== authority.sessionId
      || reviewCommentPrincipal.currentIntent !== undefined || reviewCommentPrincipal.proof !== undefined)) {
      return { ok: false, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' };
    }
    // Agent authoring retains inherited choices until the canonical
    // start owner resolves them. Malformed known fields still fail before Home proof.
    if (operation.actionId === 'session.spawn_new') {
      const parsedInput = SessionSpawnNewAgentAuthoringInputV2Schema.safeParse(operation.input ?? {});
      if (!parsedInput.success) return actionInputValidationFailure(parsedInput.error);
    } else {
      const callerInput = await bindCallerInput(getActionSpec(operation.actionId), operation.input, { surface: operationSurface });
      if (!callerInput.ok) return callerInput;
    }
    // A Session Agent's acquire from a preset is placed on that preset's
    // controller, read once under the requester's own Account; a named
    // controller must be the preset's. An acquire starting no Agent keeps its input.
    if (operation.actionId === MANAGED_ACQUIRE_ACTION_ID_V1 && isAgentStartActionInvocationV1(operation.actionId, readRecord(operation.input))) {
      const acquire = ManagedAcquireInputV1Schema.parse(operation.input);
      if (isManagedPresetAcquireInputV1(acquire)) {
        const credentials = params.credentials;
        if (!credentials) return refuse('external_authorization_preparation_failed');
        let preset: Awaited<ReturnType<typeof readManagedMachinePreset>>;
        try {
          preset = await readRequesterHomeWithinActionLifetime(() => readManagedMachinePreset({ credentials,
            serverHttpBaseUrl: params.serverHttpBaseUrl, homeId: acquire.selection.homeId, id: acquire.selection.id,
            ...(authority.signal ? { signal: authority.signal } : {}) }), authority.signal);
        } catch (error) {
          if (authority.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
          if (error instanceof ManagedMachineControllerError) return { ok: false, errorCode: error.code, error: error.code };
          const homeFailure = readRequesterHomeActionFailure(error);
          if (homeFailure) return homeFailure;
          throw error;
        }
        if (preset.controller) {
          if (acquire.controller && !sameStrictJsonValue(acquire.controller, preset.controller)) {
            return projectSessionActionIssuerRefusal({ ok: false, phase: 'preparation',
              requiredFact: 'managed_controller_target' }, params.machineId, authority.signal);
          }
          // O-MACH 2026-11-25 01:03Z: a delegated Team preset whose controller runs on another
          // Machine stays this member's own local Action; its effect uses Home's acquire routing.
          if (preset.teamAcquireDelegated !== true || preset.controller.machineId === params.machineId) {
            operation = { ...operation, input: StrictJsonValueSchema.parse({ ...readRecord(operation.input), controller: preset.controller }) };
          }
        }
      }
    }
    const requesterAppReview = requiresRequesterAppReview(actionSpec, operation.input, caller.data, operationSurface);
    let executionPlacement = resolveActionExecutionPlacementForInput(actionSpec, operation.input, caller.data, operationSurface);
    if (operation.actionId.startsWith('scm.')) {
      if (requiresExplicitScmMachineTarget(operation.actionId)) {
        return { ok: false, errorCode: 'machine_not_selected', error: 'machine_not_selected' };
      }
      const workspace = operation.scmWorkspace;
      if (!workspace || workspace.machineId !== params.machineId) return refuse('external_authorization_preparation_failed');
      const input = operation.input;
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      // Sign and approve the same host-bound input that the Machine executes.
      operation = { ...operation, input: StrictJsonValueSchema.parse(bindScmActionToSessionWorkspace(
        operation.actionId, input as Readonly<Record<string, unknown>>, workspace.directory, authority.sessionId)) };
    }
    const preferenceFailure = resolveActionOriginationPreferenceFailureV1(operation.actionId, {
      managedMachineCreationEnabled: actionSettingsProvider.getAccountSettings()?.managedMachineCreationEnabled,
    });
    if (preferenceFailure) return preferenceFailure;
    let context: ActionExecutorContext = {
      recordActionStartDiagnostic,
      surface: operationSurface, authority: 'account_automation', serverId: params.serverId,
      runtimeAccountId: readAccountIdFromToken(params.token) ?? undefined,
      actionCaller: caller.data,
      sourceSessionEncryptionMode: admitted.sessionEncryptionMode,
      ...(witness.nativeRealtimeAdmission ? { nativeRealtimeInput: true as const } : {}),
      ...(operation.executionRun ? {
        runtimeRunId: operation.executionRun.runId,
        runtimeRunOccurrenceId: operation.executionRun.occurrenceId,
      } : {}),
      ...(reviewCommentPrincipal ? { reviewCommentPrincipal } : {}),
      ...(params.machineId ? { defaultSessionMachineId: params.machineId } : {}),
      defaultSessionId: authority.sessionId, actionRequestId: operation.requestId,
      // The same corpus the runner's Agent tool bridge declares for a credentialed
      // Agent: its own led subtree. Its approval origin records it for replay.
      ...(operationSurface === 'agent' ? { sessionListAccess: 'led_subtree' as const } : {}),
      ...admitted.approvalProfile,
      callerPermissionMode: witness.callerPermissionMode ?? null,
      causalPermissionAuthority: witness.causalPermissionAuthority ?? null,
      ...(witness.actionRequestAttributionV1 ? {
        actionRequestAttributionV1: materializeActionRequestAttributionV1(witness.actionRequestAttributionV1),
      } : {}),
      sessionInputSource: { sourceSessionId: authority.sessionId, sourceTurnId: witness.turnId,
        sourceInputId: witness.inputId, via: 'action', ...(witness.discussionAddressing ? { discussionAddressing: witness.discussionAddressing } : {}) },
      ...(operation.toolCallId ? { approvalOrigin: {
        kind: 'transcript_tool_call' as const, sessionId: authority.sessionId, toolCallId: operation.toolCallId,
      } } : {}),
      ...(authority.signal ? { signal: authority.signal } : {}),
    };
    const getCurrentTurnWorkDepth = (turnId?: string) =>
      !turnId || turnId === witness.turnId ? witness.workDepth : undefined;
    // The caller supplies no placement fact. Read the same current descriptor
    // under the actual captured requester Home before granting Machine effects.
    let accountPluginActions = operation.actionId === 'action.spec.get' || operation.actionId === 'action.spec.search';
    if (operation.actionId === 'action.invoke') {
      const reader = params.createExecutor(getCurrentTurnWorkDepth, isCallerCurrent, undefined, { accountPluginActions: true });
      const actual = await readContributedActionExecutionPlacement(operation.input,
        request => reader.execute('action.spec.get', request, context));
      if (!actual) return { ok: false, errorCode: 'invalid_action_input', error: 'invalid_action_input' };
      if (!actual.ok) return actual.failure;
      // Account custody is the sole new override. In particular, a client
      // contribution retains the wrapper's incumbent Machine authorization.
      if (actual.placement === 'account') executionPlacement = 'account';
      accountPluginActions = executionPlacement === 'account';
    }
    // Origin-required Session RPCs retain the authenticated source Machine
    // channel. Wrapping them in an external root loses native Session authority
    // (notably the question owner's narrow manager-answer admission).
    const sessionOriginRpc = isSessionActionRpcMethodV1(getActionSpec(operation.actionId).bindings?.rpcMethod ?? operation.actionId);
    const outputMachineId = readProjectExecutionOutputMachineAdmissionMethodV1(operation.actionId)
      ? readRecord(operation.input).machineId : undefined;
    // Remote retained output uses the same requester Account custody as the
    // exact operation lookup and terminal read it delegates to.
    const requesterOutputRead = params.credentials !== undefined && params.machineId !== undefined
      && typeof outputMachineId === 'string' && outputMachineId !== params.machineId;
    // Entry history already has an exact Machine read under the requester's
    // Account. Retain the Session host's workspace without minting an Action root.
    const requesterHistoryWorkspace = params.credentials && actionSpec.bindings?.rpcMethod === RPC_METHODS.SCM_HISTORY_ENTRIES
      ? operation.scmWorkspace : undefined;
    // Fleet Activity joins reads from the requester Home and its exact Machines.
    // No single Machine authorization can admit that Account-wide read.
    const requesterFleetActivityRead = params.credentials !== undefined && operation.actionId === MACHINE_ACTIVITY_LIST_ACTION_ID;
    const requesterAccountRead = requesterOutputRead || requesterHistoryWorkspace !== undefined || requesterFleetActivityRead;
    const requiresMachineAuthorization = executionPlacement !== 'account'
      && executionPlacement !== 'client'
      && !requesterAppReview
      && !proposesPluginInstallApproval
      && !sessionOriginRpc
      && !requesterAccountRead;
    // The Machine authorization binds the action but does not retain the Discussion
    // address. Refuse the external comment while the originating turn is still here.
    if (requiresMachineAuthorization && operation.actionId === ACTION_INVOKE_ACTION_ID_V1
      && witness.discussionAddressing && await blocksPublicProviderComment(witness.discussionAddressing.discussionId,
        readPluginActionExecutionReference(operation.actionId, operation.input))) {
      return { ok: false, errorCode: INTERNAL_DISCUSSION_REPLY_REQUIRED, error: INTERNAL_DISCUSSION_REPLY_MESSAGE,
        effectAttempted: false };
    }
    if (params.credentials && (operation.actionId === 'discussion.post' || operation.actionId === 'discussion.reply')) {
      context = { ...context, serverIdentityId: readServerIdentityIdFromFeaturesSnapshot(await params.resolveServerFeaturesSnapshot?.()) ?? undefined };
      const bound = await bindDiscussionDraftReply({ actionId: operation.actionId, input: operation.input, context,
        serverId: params.serverId, serverIdentityId: context.serverIdentityId,
        discussionAction: createDiscussionActionDeps({ credentials: params.credentials,
          serverId: params.serverId, serverIdentityId: context.serverIdentityId, serverHttpBaseUrl: params.serverHttpBaseUrl }).discussionAction,
        credentials: params.credentials, serverHttpBaseUrl: params.serverHttpBaseUrl });
      if ('failure' in bound) return bound.failure;
      if (bound.context.discussionReplyReturn && bound.context.actionRequestId) {
        // Sign the normalized Action and stable request identity. Altering an
        // already-signed post at the downstream executor would invalidate its proof.
        context = bound.context;
        operation = { ...operation, actionId: ActionIdSchema.parse(bound.actionId), input: StrictJsonValueSchema.parse(bound.input),
          requestId: bound.context.actionRequestId };
      }
    }
    const taskDiscussionInput = params.credentials && executionPlacement === 'account' && readRecord(operation.input).anchorTask !== undefined
      && (!targetMachineId || targetMachineId === params.machineId) && isDiscussionActionIdV1(operation.actionId)
      ? DISCUSSION_ACTION_INPUT_SCHEMAS_V1[operation.actionId].safeParse(operation.input) : undefined;
    const taskDiscussion = taskDiscussionInput?.success && 'anchorTask' in taskDiscussionInput.data
      ? taskDiscussionInput.data : undefined;
    if (operation.actionId === 'doc.edit.propose') {
      context = { ...context, serverIdentityId: readServerIdentityIdFromFeaturesSnapshot(await params.resolveServerFeaturesSnapshot?.()) ?? undefined };
      // Bind the passage once before signing and deriving the child publication
      // metadata. The executor retains this same reviewed basis on replay.
      const prepared = await prepareDocEditProposalInputV1(operation.input, context,
        { ...(params.credentials ? createDiscussionActionDeps({ credentials: params.credentials,
          serverId: params.serverId, serverIdentityId: context.serverIdentityId, serverHttpBaseUrl: params.serverHttpBaseUrl,
          resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot }) : {}),
          artifactAction: async ({ input, context }) => {
            const reader = params.createExecutor(getCurrentTurnWorkDepth, isCallerCurrent);
            const result = await reader.execute('artifact.get', input, context);
            return result.ok ? result.result : result;
          } },
        (left, right) => areServerProfileIdentifiersEquivalent(left, right,
          id => id === params.serverId || id === context.serverIdentityId ? context.serverIdentityId : undefined));
      if (!prepared.ok) return prepared;
      operation = { ...operation, input: StrictJsonValueSchema.parse(prepared.input) };
    }
    let sessionActionOrigin: SessionActionRpcOriginV1;
    try { sessionActionOrigin = resolveSessionRoleRpcOrigin(context); }
    catch { return refuse('session_action_origin_invalid'); }
    // The controller of a managed acquire or preset Session spawn holds no access
    // to this requester's private Agent-start policy. Admit here once, before Home
    // signs: the signed origin carries the stamp and the root signs the
    // Role-projected input, so this executor, the controller and the guest
    // consume it without re-admitting.
    const presetSessionStart = operation.actionId === 'session.spawn_new'
      && readRecord(readRecord(operation.input).sessionPlacement).kind === 'preset';
    if (requiresMachineAuthorization && (operation.actionId === 'machines.managed.acquire' || presetSessionStart)
      && isAgentStartActionInvocationV1(operation.actionId, readRecord(operation.input))) {
      const reviewer = params.createExecutor(getCurrentTurnWorkDepth, isCallerCurrent);
      const admitted = await runTracedExternalActionStage(operation.actionId, operation.requestId, 'session_action.agent_start_admission',
        () => reviewer.prepare(operation.actionId, operation.input, context, { reviewOnly: true }));
      if (admitted.kind === 'settled') return admitted.result;
      const agentStartAdmission = admitted.operation?.agentStartAdmission;
      if (!agentStartAdmission) return refuse('external_authorization_preparation_failed');
      operation = { ...operation, input: StrictJsonValueSchema.parse(admitted.operation!.normalizedInput) };
      sessionActionOrigin = { ...sessionActionOrigin, agentStartAdmission };
    }
    let external: Awaited<ReturnType<NonNullable<typeof params.prepareExternalActionAuthorization>>>;
    try {
      const credentials = params.credentials;
      if (credentials && isWorkspaceSyncStopAction(operation.actionId)) {
        const serverIdentityId = readServerIdentityIdFromFeaturesSnapshot(await params.resolveServerFeaturesSnapshot?.());
        const placement = await prepareWorkspaceSyncStopPlacement({
          rawInput: operation.input, credentials, serverId: serverIdentityId ?? params.serverId,
          serverHttpBaseUrl: params.serverHttpBaseUrl,
          target: targetMachineId ? { kind: 'machine', machineId: targetMachineId } : undefined,
          signal: authority.signal, readWithinActionLifetime: true,
        });
        if (placement) {
          if (!placement.ok) return placement;
          operation = { ...operation, input: placement.input };
          targetMachineId = placement.target.machineId;
        }
      }
      const scmWorkspace = operation.actionId.startsWith('scm.') ? operation.scmWorkspace : undefined;
      const needsCallerWorkspace = operation.actionId === 'workflow.run.start' || operation.actionId === 'machines.command.run';
      const workflowTarget = scmWorkspace ? { kind: 'machine' as const,
        machineId: scmWorkspace.machineId, project: scmWorkspace }
        : needsCallerWorkspace && credentials
        ? await readRequesterHomeWithinActionLifetime(async () => !await authority.isCurrent() ? undefined
          : await runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => resolveCliActionCallerWorkflowTarget({
          credentials, context,
          ...(params.machineId ? { target: { kind: 'machine', machineId: params.machineId } as const } : {}),
          resolveTransportForSession: (sessionId, signal) => resolveSessionTransportContext({ reason: 'session-action', credentials,
            idOrPrefix: sessionId, ...(signal ? { signal } : {}) }),
        })), authority.signal) : undefined;
      if (needsCallerWorkspace && !workflowTarget) return refuse('external_authorization_preparation_failed');
      const prepare = params.prepareExternalActionAuthorization;
      external = prepare && !proposesPluginInstallApproval && !sessionOriginRpc && !requesterAccountRead
        // The admitted owner uses the CLI's captured Account data provider.
        // Machine-purpose proofs are not credentials for private Task KV/resources.
        && !taskDiscussion?.anchorTask
        && !(executionPlacement === 'account' && (
          ACTION_ID_FAMILIES_V1.internal_tasks.some(id => id === operation.actionId)
          || ACTION_ID_FAMILIES_V1.todo_session_link.some(id => id === operation.actionId)
          || ACTION_ID_FAMILIES_V1.list_reorder.some(id => id === operation.actionId)))
        && !(operation.actionId === 'action.invoke' && executionPlacement === 'account')
        && !requesterAppReview
        ? await runTracedExternalActionStage(operation.actionId, operation.requestId, 'session_action.authorization',
          () => readRequesterHomeWithinActionLifetime(async () => !await authority.isCurrent() ? null
            : await prepare({ operation, authority, isCallerCurrent, sessionActionOrigin,
              ...(targetMachineId ? { targetMachineId } : {}),
              ...(workflowTarget ? { workflowTarget } : {}) }), authority.signal)) : undefined;
    } catch (error) {
      logRefusal('external_authorization_preparation_failed');
      if (authority.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      const homeFailure = readRequesterHomeActionFailure(error);
      if (homeFailure) return homeFailure;
      throw error;
    }
    if (external === null) {
      logRefusal('external_authorization_refused');
      return projectSessionActionIssuerRefusal({ ok: false, phase: 'preparation',
        requiredFact: 'session_authorization_preparation' }, params.machineId, authority.signal);
    }
    if (external && 'ok' in external) {
      logRefusal('external_authorization_refused');
      return authority.signal?.aborted ? { ok: false, errorCode: 'cancelled', error: 'cancelled' } : external;
    }
    if (operation.actionId.startsWith('scm.') && operation.scmWorkspace && external
      && (external.target.kind !== 'machine' || external.target.machineId !== operation.scmWorkspace.machineId
        || !sameStrictJsonValue(external.target.project, operation.scmWorkspace))) {
      return refuse('external_authorization_binding_mismatch');
    }
    if (requiresMachineAuthorization && !external) return refuse('external_authorization_missing', authority.signal?.aborted ? 'cancelled' : 'target_unavailable');
    if (requiresMachineAuthorization && external && (external.authorization.binding.actionId !== operation.actionId
      || external.authorization.binding.requestId !== operation.requestId
      || !sameStrictJsonValue(external.authorization.binding.sessionActionOrigin, sessionActionOrigin)
      || operation.actionId === 'session.board.item.upsert' && (
        external.target.kind !== 'session' || external.target.sessionId !== authority.sessionId
        || external.authorization.binding.target?.kind !== 'session'
        || external.authorization.binding.target.sessionId !== authority.sessionId
        || !external.authorization.binding.sessionActionSource
        || external.authorization.binding.machineId !== external.authorization.binding.sessionActionSource.machineId
        || params.machineId !== undefined && external.authorization.binding.sessionActionSource.machineId !== params.machineId))) {
      return refuse('external_authorization_binding_mismatch', authority.signal?.aborted ? 'cancelled' : 'target_unavailable');
    }
    if (external?.accountSettingsVersion !== undefined) {
      const credentials = params.credentials;
      const accountSettingsVersion = external.accountSettingsVersion;
      if (!credentials) return refuse('external_authorization_preparation_failed');
      try {
        await runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => refreshAccountSettingsForMinimumVersion({
          credentials,
          minSettingsVersion: accountSettingsVersion,
          mode: 'blocking',
        }));
      } catch {
        return refuse('external_authorization_preparation_failed',
          authority.signal?.aborted ? 'cancelled' : 'target_unavailable');
      }
    }
    const docMutation = operation.actionId === 'doc.comment.reply' || operation.actionId === 'doc.edit.propose'
      ? prepareDocDiscussionMutationV1(operation.actionId, operation.input, params.serverId) : undefined;
    const publicationActionId = docMutation?.actionId ?? operation.actionId;
    const postAgentDiscussionMessage: DiscussionAgentPublisher | undefined = params.postAgentDiscussionMessage
      && (publicationActionId === 'discussion.post' || publicationActionId === 'discussion.reply' || publicationActionId === 'discussion.create')
      ? async (request, options) => {
          const input = docMutation?.input ?? operation.input;
          const isCreate = 'operation' in request && request.operation === 'create';
          let sameOperation = input && typeof input === 'object' && (isCreate
            ? publicationActionId === 'discussion.create'
              && (!('creationLocalId' in input) || input.creationLocalId === undefined || request.request.creationLocalId === input.creationLocalId)
              && 'firstMessage' in input && input.firstMessage && typeof input.firstMessage === 'object'
              && (!('localId' in input.firstMessage) || input.firstMessage.localId === undefined || request.request.firstMessage.localId === input.firstMessage.localId)
            : publicationActionId !== 'discussion.create' && 'discussionId' in input
              && !('operation' in request) && request.discussionId === input.discussionId);
          if (taskDiscussion?.anchorTask) {
            const localId = isCreate ? request.request.firstMessage.localId : request.request.localId;
            const authoredLocalId = 'localId' in taskDiscussion ? taskDiscussion.localId : undefined;
            if (authoredLocalId !== undefined && localId !== authoredLocalId) sameOperation = false;
            else if (isCreate) {
              const first = publicationActionId === 'discussion.post' ? projectDiscussionTaskFirstPostV1(taskDiscussion, localId) : null;
              sameOperation = first !== null && request.request.creationLocalId === first.creationLocalId
                && sameStrictJsonValue(request.request.anchor ?? null, first.anchor);
            } else {
              const thread = options?.taskThread;
              sameOperation = thread?.id === request.discussionId && matchesDiscussionTaskAnchorV1(thread.anchor,
                taskDiscussion.anchorTask, context.runtimeAccountId ?? '');
            }
          }
          let sameDocMetadata = true;
          if (docMutation) {
            const expected = docMutation.actionId === 'discussion.create' ? docMutation.input.firstMessage : docMutation.input;
            const actual = 'operation' in request ? request.request.firstMessage : request.request;
            const mentions = readDiscussionMentionedParticipantIdsV1(expected.content);
            sameDocMetadata = actual.localId === expected.localId
              && (actual.docEditProposal === true) === isDiscussionDocEditProposalContentV1(expected.content)
              && sameStrictJsonValue(actual.replyTarget ?? null, expected.replyTarget ?? null)
              && sameStrictJsonValue(actual.mentionedAccountIds, expected.mentionedAccountIds ?? mentions.mentionedAccountIds)
              && sameStrictJsonValue(actual.mentionedSessionIds ?? [], expected.mentionedSessionIds ?? mentions.mentionedSessionIds);
          }
          if (request.sessionId !== authority.sessionId || !sameOperation || !sameDocMetadata
            || request.toolCallId !== (operation.toolCallId ?? operation.requestId)
            || !await isCallerCurrent()) return { v: 1, ok: false, error: 'discussion_post_denied' };
          const signals = [options?.signal, authority.signal].filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
          const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
          signal?.throwIfAborted();
          return DiscussionAgentPublisherResponseV1Schema.parse(await params.postAgentDiscussionMessage!(request, witness,
            signal ? { signal } : undefined));
        }
      : undefined;
    const executor = params.createExecutor(getCurrentTurnWorkDepth, isCallerCurrent, postAgentDiscussionMessage,
      accountPluginActions ? { accountPluginActions: true } : undefined);
    // The original Home preparer verified this protected source tuple against
    // the installed Session host's proof. It is not the selected receiver: a
    // remote controller must still sign its own approvals through that receiver.
    const source = external
      && external.authorization.binding.actionId === operation.actionId
      && external.authorization.binding.requestId === operation.requestId
      && sameStrictJsonValue(external.authorization.binding.sessionActionOrigin, sessionActionOrigin)
      ? external.authorization.binding.sessionActionSource : undefined;
    const executionContext: RpcActionExecutorContext = {
      ...context,
      ...(source ? { defaultSessionMachineId: source.machineId } : {}),
      ...(external ? { externalActionExecutionAuthorization: external.authorization, externalActionTarget: external.target } : {}),
      ...(requesterHistoryWorkspace ? { externalActionTarget: {
        kind: 'machine' as const, machineId: requesterHistoryWorkspace.machineId, project: requesterHistoryWorkspace,
      } } : {}),
      ...(observationSetup ? { requiredContributedActionDangerLevel: 'safe' } : {}),
      ...(operation.actionId === ACTION_INVOKE_ACTION_ID_V1 && accountPluginActions ? {
        executeOrdinaryChildAction: (actionId, input, options) => {
          const parsed = StrictJsonValueSchema.safeParse(input);
          const target = options?.externalActionTarget;
          if (actionId !== ACTION_INVOKE_ACTION_ID_V1 || !parsed.success || !options?.actionRequestId || target?.kind !== 'machine') {
            return Promise.resolve({ ok: false as const, errorCode: 'invalid_action_input', error: 'invalid_action_input' });
          }
          return execute({ kind: 'action.execute', actionId, input: parsed.data, requestId: options.actionRequestId,
            witness: operation.witness, ...(operation.surface ? { surface: operation.surface } : {}),
            ...(operation.executionRun ? { executionRun: operation.executionRun } : {}) }, authority, undefined, target.machineId);
        },
      } : {}),
      ...(operation.actionId === USAGE_SOURCE_DISMISS_ACTION_ID ? {
        executeOrdinaryChildAction: (actionId, input, options) => {
          const parsed = StrictJsonValueSchema.safeParse(input);
          const target = options?.externalActionTarget;
          if (actionId !== USAGE_SOURCE_GET_ACTION_ID || !parsed.success || !options?.actionRequestId || target?.kind !== 'machine') {
            return Promise.resolve({ ok: false as const, errorCode: 'invalid_action_input', error: 'invalid_action_input' });
          }
          // The private lookup uses its own exact Machine proof and the original Session witness.
          // The dismissal itself retains Account placement, including Restore with no Machine read.
          return execute({ kind: 'action.execute', actionId, input: parsed.data, requestId: options.actionRequestId,
            witness: operation.witness, ...(operation.surface ? { surface: operation.surface } : {}),
            ...(operation.executionRun ? { executionRun: operation.executionRun } : {}) },
          options.signal ? { ...authority, signal: options.signal } : authority, undefined, target.machineId);
        },
      } : {}),
      ...(operation.actionId === WORKFLOW_AUTHORING_ACTION_ID.draftSave || operation.actionId === USAGE_QUERY_ACTION_ID_V1 ? {
        executeOrdinaryChildAction: (actionId, input, options) => {
          const parsed = StrictJsonValueSchema.safeParse(input);
          const setupRead = isWorkflowObservationSetupChildActionV1(operation.actionId, actionId);
          const costsReference = operation.actionId === USAGE_QUERY_ACTION_ID_V1 && actionId === ACTION_INVOKE_ACTION_ID_V1
            ? readPluginActionExecutionReference(actionId, input) : null;
          const costsTarget = costsReference && formatQualifiedPluginActionId(costsReference) === TELEMETRY_COSTS_READ_ACTION_ID_V1
            && options?.externalActionTarget?.kind === 'machine' ? options.externalActionTarget.machineId : undefined;
          const allowed = operation.actionId === USAGE_QUERY_ACTION_ID_V1 ? costsTarget !== undefined
            : setupRead || isWorkflowHostAdmittedChildActionIdV1(actionId);
          if (!allowed || !options?.actionRequestId || !parsed.success) {
            return Promise.resolve({ ok: false, errorCode: 'invalid_action_input', error: 'invalid_action_input' });
          }
          // The child keeps the Session witness and receives its own exact Home proof.
          return execute({ kind: 'action.execute', actionId, input: parsed.data, requestId: options.actionRequestId,
            witness: operation.witness, ...(operation.surface ? { surface: operation.surface } : {}),
            ...(operation.executionRun ? { executionRun: operation.executionRun } : {}) },
          options.signal ? { ...authority, signal: options.signal } : authority, setupRead || costsTarget ? true : undefined, costsTarget);
        },
      } : {}),
      ...(external?.verifyMachineAdmissionCurrent ? {
        verifyMachineAdmissionCurrent: external.verifyMachineAdmissionCurrent,
        sessionActionOrigin,
      } : {}),
      ...(external?.originalActionEnvelope ? { originalActionEnvelope: external.originalActionEnvelope } : {}),
    };
    const outcome = await runTracedExternalActionStage(operation.actionId, operation.requestId, 'session_action.execute',
      () => executor.execute(operation.actionId, operation.input, executionContext));
    if (!outcome.ok && outcome.errorCode === 'target_unavailable') {
      const scopeFailure = ActionCurrentSessionScopeFailureDetailsV1Schema.safeParse(outcome.details);
      // Only closed Workflow codes/reasons enter the existing diagnostic.
      // Error text and arbitrary details can contain prompts or credentials.
      const workflowFailure = operation.actionId === 'workflow.run.start' ? WorkflowActionFailureV1Schema.safeParse(outcome) : null;
      const targetFailure = workflowFailure?.success && workflowFailure.data.errorCode === 'target_unavailable'
        ? WorkflowTargetUnavailableDetailsV1Schema.safeParse(workflowFailure.data.details) : null;
      logRefusal('action_executor_refused', {
        errorCode: 'target_unavailable',
        ...(scopeFailure.success ? { scopeFailureCause: scopeFailure.data.cause } : {}),
        ...(firstRefusal ? { refusalCode: 'target_unavailable' as const } : {}),
        ...(targetFailure?.success ? { refusalCode: targetFailure.data.code, refusalReason: targetFailure.data.reason } : {}),
      });
    }
    if (!outcome.ok && outcome.errorCode === 'unsupported_action') {
      const scopeFailure = ActionCurrentSessionScopeFailureDetailsV1Schema.safeParse(outcome.details);
      if (scopeFailure.success) logRefusal('action_executor_refused', {
        errorCode: 'unsupported_action', scopeFailureCause: scopeFailure.data.cause,
      });
    }
    return outcome;
  };
  return execute;
}
