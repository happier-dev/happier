import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { SessionSpawnNewAgentAuthoringInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { AgentStartSessionCallerV1Schema, readAgentStartCallerWorkDepthV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { createActionExecutor, ActionExecuteResult, ActionExecutorContext, ExternalActionExecutionAuthorizationV1, ExternalActionTargetV1 } from '@happier-dev/protocol';
import { isSessionActionRpcMethodV1, type SessionActionRpcOriginV1 } from '@happier-dev/protocol/socketRpc';
import { sameStrictJsonValue, StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { resolveSessionRoleRpcOrigin } from '@/session/actions/sessionRoleRpcOrigin';
import { resolveActionOriginationPreferenceFailureV1 } from '@happier-dev/protocol/actions/executor/actionOriginationPreferences';
import { actionInputValidationFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { logger } from '@/ui/logger';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { resolveCliActionCallerWorkflowTarget } from '@/session/actions/resolveCliActionCallerSession';
import { WorkflowActionFailureV1Schema, WorkflowTargetUnavailableDetailsV1Schema, type WorkflowTargetUnavailableReasonV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { ActionStartDiagnosticV1, ActionStartPhaseV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ActionCurrentSessionScopeFailureDetailsV1Schema, type ActionCurrentSessionScopeFailureDetailsV1 } from '@happier-dev/protocol/actions/executor/sessionListAccess';
import { createExternalActionStartDiagnosticRecorder, runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { DiscussionAgentPublisherResponseV1Schema, type DiscussionAgentPublisherRequestV1 } from '@happier-dev/protocol/discussions/api';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import { bindDiscussionDraftReply } from '@/discussions/bindDiscussionDraftReply';
import { prepareDocDiscussionMutationV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { isDiscussionDocEditProposalContentV1, readDiscussionMentionedParticipantIdsV1 } from '@happier-dev/protocol/discussions/content';
import { readRequesterHomeWithinActionLifetime } from '@/daemon/sessionEncryption/requesterCurrentness';
import { bindScmActionToSessionWorkspace } from '@/scm/actions/placement';
import { requiresExplicitScmMachineTarget } from '@happier-dev/protocol/actions/actionSpecs';
import { readContributedActionExecutionPlacement } from '@/session/actions/readContributedActionExecutionPlacement';
import { readServerIdentityIdFromFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

type SessionActionOperation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;
type SessionActionAuthority = Readonly<{ sessionId: string; isCurrent(): Promise<boolean>; signal?: AbortSignal }>;
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
  serverId: string;
  serverHttpBaseUrl: string;
  token: string;
  credentials?: StoredCredentials;
  /** Existing observation of this daemon's bound Home, distinct from its local profile. */
  resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined | Promise<CliServerFeaturesSnapshot | undefined>;
  /** The installed daemon producer, independent of optional public-API proof. */
  machineId?: string;
  /** Content-free observations from the startup requester-runtime binding. */
  initialStartDiagnostic?: ActionStartDiagnosticV1;
  createExecutor: (getCurrentTurnWorkDepth: (turnId?: string) => number | undefined,
    isCallerCurrent: () => Promise<boolean>, postAgentDiscussionMessage?: DiscussionAgentPublisher,
    options?: Readonly<{ accountPluginActions: true }>) => Pick<ReturnType<typeof createActionExecutor>, 'execute'>;
  /** Existing Session RPC transport to the actual current client, with this operation's admitted witness. */
  postAgentDiscussionMessage?: (request: DiscussionAgentPublisherRequestV1, witness: SessionActionOperation['witness'],
    options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
  /** Host-only producer of original Home authority; author input cannot install this port. */
  prepareExternalActionAuthorization?: (input: SessionAccountActionAuthorizationPreparation) => Promise<Readonly<{
    authorization: ExternalActionExecutionAuthorizationV1; target: ExternalActionTargetV1;
  }> | null | undefined>;
}>) {
  const actionSettingsProvider = runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => createActionSettingsProvider({
    scopeKey: resolveAccountSettingsScopeKeyForToken(params.token),
  }));
  return async (operation: SessionActionOperation, authority: SessionActionAuthority): Promise<ActionExecuteResult> => {
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
    let executionPlacement = resolveActionExecutionPlacementForInput(getActionSpec(operation.actionId), operation.input);
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
    // Process/Session custody does not authorize borrowing the daemon Account.
    // The exact authenticated Home's owner projection proves same-account use;
    // a shared recipient requires its own admitted requester execution channel.
    const readCallerRefusal = (): Promise<SessionAccountActionRefusalReason | null> => runTracedExternalActionStage(
      operation.actionId, operation.requestId, 'session_action.caller_currentness', async (): Promise<SessionAccountActionRefusalReason | null> => {
      try {
        return await readRequesterHomeWithinActionLifetime(async (): Promise<SessionAccountActionRefusalReason | null> => {
          if (authority.signal?.aborted || !await authority.isCurrent()) return 'runtime_authority_unavailable';
          const session = await fetchSessionById({ reason: 'session-action',
            token: params.token, serverUrl: params.serverHttpBaseUrl, sessionId: authority.sessionId,
            ...(authority.signal ? { signal: authority.signal } : {}),
          });
          if (!session || session.id !== authority.sessionId) return 'session_owner_missing';
          if (readSessionAccessProjectionRoleV1(session) !== 'owner') return 'session_not_owner';
          return !authority.signal?.aborted && await authority.isCurrent() ? null : 'runtime_authority_unavailable';
        }, authority.signal);
      } catch {
        return 'session_owner_read_failed';
      }
    });
    const isCallerCurrent = async (): Promise<boolean> => {
      const reason = await readCallerRefusal();
      if (reason && !authority.signal?.aborted) logRefusal(reason);
      return reason === null;
    };
    const callerRefusal = await readCallerRefusal();
    if (callerRefusal) return refuse(callerRefusal, authority.signal?.aborted ? 'cancelled' : 'target_unavailable');
    const reviewCommentPrincipal = operation.reviewCommentPrincipal;
    if (reviewCommentPrincipal && (reviewCommentPrincipal.actor.kind !== 'agent'
      || reviewCommentPrincipal.actor.sessionId !== authority.sessionId
      || reviewCommentPrincipal.currentIntent !== undefined || reviewCommentPrincipal.proof !== undefined)) {
      return { ok: false, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' };
    }
    // Session spawn authoring retains inherited choices until the canonical
    // start owner resolves them. Malformed known fields still fail before Home proof.
    const inputSchema = operation.actionId === 'session.spawn_new'
      ? SessionSpawnNewAgentAuthoringInputV2Schema : getActionSpec(operation.actionId).inputSchema;
    const parsedInput = inputSchema.safeParse(operation.input ?? {});
    if (!parsedInput.success) return actionInputValidationFailure(parsedInput.error);
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
      actionCaller: caller.data,
      ...(operation.executionRun ? {
        runtimeRunId: operation.executionRun.runId,
        runtimeRunOccurrenceId: operation.executionRun.occurrenceId,
      } : {}),
      ...(reviewCommentPrincipal ? { reviewCommentPrincipal } : {}),
      ...(params.machineId ? { defaultSessionMachineId: params.machineId } : {}),
      defaultSessionId: authority.sessionId, actionRequestId: operation.requestId,
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
    let accountPluginActions = operation.actionId === 'action.spec.get';
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
      const reason = await readCallerRefusal();
      if (reason) return refuse(reason, authority.signal?.aborted ? 'cancelled' : 'target_unavailable');
    }
    // Origin-required Session RPCs retain the authenticated source Machine
    // channel. Wrapping them in an external root loses native Session authority
    // (notably the question owner's narrow manager-answer admission).
    const sessionOriginRpc = isSessionActionRpcMethodV1(getActionSpec(operation.actionId).bindings?.rpcMethod ?? operation.actionId);
    const requiresMachineAuthorization = executionPlacement !== 'account'
      && executionPlacement !== 'client'
      && !proposesPluginInstallApproval
      && !sessionOriginRpc;
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
    let sessionActionOrigin: SessionActionRpcOriginV1;
    try { sessionActionOrigin = resolveSessionRoleRpcOrigin(context); }
    catch { return refuse('session_action_origin_invalid'); }
    let external: Awaited<ReturnType<NonNullable<typeof params.prepareExternalActionAuthorization>>>;
    try {
      const credentials = params.credentials;
      const scmWorkspace = operation.actionId.startsWith('scm.') ? operation.scmWorkspace : undefined;
      const workflowTarget = scmWorkspace ? { kind: 'machine' as const,
        machineId: scmWorkspace.machineId, project: scmWorkspace }
        : operation.actionId === 'workflow.run.start' && credentials
        ? await readRequesterHomeWithinActionLifetime(async () => !await authority.isCurrent() ? undefined
          : await runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => resolveCliActionCallerWorkflowTarget({
          credentials, context,
          ...(params.machineId ? { target: { kind: 'machine', machineId: params.machineId } as const } : {}),
          resolveTransportForSession: (sessionId, signal) => resolveSessionTransportContext({ reason: 'session-action', credentials,
            idOrPrefix: sessionId, ...(signal ? { signal } : {}) }),
        })), authority.signal) : undefined;
      if (operation.actionId === 'workflow.run.start' && !workflowTarget) return refuse('external_authorization_preparation_failed');
      const prepare = params.prepareExternalActionAuthorization;
      external = prepare && !proposesPluginInstallApproval && !sessionOriginRpc
        && !(operation.actionId === 'action.invoke' && executionPlacement === 'account')
        ? await runTracedExternalActionStage(operation.actionId, operation.requestId, 'session_action.authorization',
          () => readRequesterHomeWithinActionLifetime(async () => !await authority.isCurrent() ? null
            : await prepare({ operation, authority, isCallerCurrent, sessionActionOrigin,
              ...(workflowTarget ? { workflowTarget } : {}) }), authority.signal)) : undefined;
    } catch (error) {
      logRefusal('external_authorization_preparation_failed');
      if (authority.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      if (isPluginError(error) && error.code === 'project_requester_home_unavailable')
        return { ok: false, errorCode: error.code, error: error.code };
      throw error;
    }
    if (external === null) return refuse('external_authorization_refused', authority.signal?.aborted ? 'cancelled' : 'target_unavailable');
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
    if (external) {
      const reason = await readCallerRefusal();
      if (reason) return refuse(reason, authority.signal?.aborted ? 'cancelled' : 'target_unavailable');
    }
    const docMutation = operation.actionId === 'doc.comment.reply' || operation.actionId === 'doc.edit.propose'
      ? prepareDocDiscussionMutationV1(operation.actionId, operation.input, params.serverId) : undefined;
    const publicationActionId = docMutation?.actionId ?? operation.actionId;
    const postAgentDiscussionMessage: DiscussionAgentPublisher | undefined = params.postAgentDiscussionMessage
      && (publicationActionId === 'discussion.post' || publicationActionId === 'discussion.reply' || publicationActionId === 'discussion.create')
      ? async (request, options) => {
          const input = docMutation?.input ?? operation.input;
          const isCreate = 'operation' in request && request.operation === 'create';
          const sameOperation = input && typeof input === 'object' && (isCreate
            ? publicationActionId === 'discussion.create'
              && (!('creationLocalId' in input) || input.creationLocalId === undefined || request.request.creationLocalId === input.creationLocalId)
              && 'firstMessage' in input && input.firstMessage && typeof input.firstMessage === 'object'
              && (!('localId' in input.firstMessage) || input.firstMessage.localId === undefined || request.request.firstMessage.localId === input.firstMessage.localId)
            : publicationActionId !== 'discussion.create' && 'discussionId' in input
              && !('operation' in request) && request.discussionId === input.discussionId);
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
    const outcome = await runTracedExternalActionStage(operation.actionId, operation.requestId, 'session_action.execute',
      () => executor.execute(operation.actionId, operation.input, {
      ...context,
      ...(source ? { defaultSessionMachineId: source.machineId } : {}),
      ...(external ? { externalActionExecutionAuthorization: external.authorization, externalActionTarget: external.target } : {}),
    }));
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
}
