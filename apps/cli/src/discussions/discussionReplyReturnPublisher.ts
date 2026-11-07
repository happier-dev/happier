import { DiscussionAgentPostRequestV1Schema, DiscussionAgentPostResponseV1Schema,
  type DiscussionAgentPostResponseV1 } from '@happier-dev/protocol/discussions/api';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionInputSourceSessionV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { classifySessionMessageReplyPublicationFailureV1, deriveSessionMessageReplyReturnLocalIdV1,
  type SessionMessageReplyPublicationFailureV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { readSessionMessageReply, type DiscussionReplyReturnPublisher,
  type DiscussionReplyReturnPublicationResult } from '@/session/services/sessionMessageReply';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { logger } from '@/ui/logger';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { DiscussionAgentPostPublicationV1, DiscussionWorkflowPostPublicationV1 } from '@happier-dev/protocol/discussions/api';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';

/** Account composition supplies policy and resource crypto, never a second writer. */
export function createDiscussionReplyReturnPublisher(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  serverId: string;
  serverHttpBaseUrl: string;
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
  actionsSettingsProvider?: RuntimeActionSettingsProvider;
  workflowActionContext?: ActionExecutorContext;
  postWorkflowMessage?: (publication: DiscussionWorkflowPostPublicationV1 | DiscussionAgentPostPublicationV1,
    options?: Readonly<{ signal?: AbortSignal }>) => Promise<DiscussionAgentPostResponseV1>;
}>): DiscussionReplyReturnPublisher {
  const resolveCurrentOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl: params.serverHttpBaseUrl,
    resolveCurrentMachineId: () => params.machineId });
  const isCapturedHome = (serverId: string, identity: string) => areServerProfileIdentifiersEquivalent(serverId, params.serverId,
    id => id === params.serverId || id === identity ? identity : null);
  return async (original, options) => {
    const denied = (): DiscussionAgentPostResponseV1 => ({ v: 1, ok: false, error: 'discussion_post_denied' });
    const unavailable = (): DiscussionAgentPostResponseV1 => ({ v: 1, ok: false, error: 'discussions_unavailable' });
    const publicationResult = (result: DiscussionAgentPostResponseV1,
      phase: SessionMessageReplyPublicationFailureV1['phase']): DiscussionReplyReturnPublicationResult => {
      if (result.ok) return result;
      const failure = classifySessionMessageReplyPublicationFailureV1(result.error, phase);
      return failure ? { ...result, failure } : result;
    };
    const withoutReceipt = (result: ActionExecuteResult,
      phase: SessionMessageReplyPublicationFailureV1['phase']): DiscussionReplyReturnPublicationResult => {
      const correlation = 'kind' in original ? { discussionId: original.discussion.discussion.discussionId,
        addressingMessageId: original.discussion.messageId, runId: original.workflow.runId,
        invocationId: original.workflow.invocationRecordId } : { discussionId: original.discussion.discussionId,
        addressingMessageId: original.discussion.messageId, requestSessionId: original.requestSessionId,
        requestLocalId: original.requestLocalId, acceptedTurnId: original.acceptedTurnId,
        ...(original.workflow ? { runId: original.workflow.runId, invocationId: original.workflow.invocationRecordId } : {}) };
      if (result.ok) {
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (approval.success) {
          logger.infoFile('[Discussion reply return] Publication awaiting approval', { ...correlation, phase,
            artifactId: approval.data.artifactId });
          return { v: 1, ok: false, error: 'discussions_unavailable',
            pending: { kind: 'approval', artifactId: approval.data.artifactId } };
        }
      }
      const failure = classifySessionMessageReplyPublicationFailureV1(result.ok ? 'action_outcome_unknown' : result.errorCode, phase)
        ?? classifySessionMessageReplyPublicationFailureV1('action_outcome_unknown', phase);
      logger.warnLocalFile('[Discussion reply return] Action has no publication receipt', { ...correlation,
        errorCode: failure?.code ?? 'action_outcome_unknown', phase, retryable: failure?.retryable ?? true });
      const domain = !result.ok && DiscussionAgentPostResponseV1Schema.safeParse({ v: 1, ok: false, error: result.errorCode });
      const response = domain && domain.success ? domain.data : !result.ok && ['action_disabled', 'present_user_required',
        'run_access_denied', 'approval_stale'].includes(result.errorCode) ? denied() : unavailable();
      return failure ? { ...response, failure } : response;
    };
    const signal = options?.signal && options.signal !== params.signal
      ? AbortSignal.any([params.signal, options.signal]) : params.signal;
    const current = async () => !signal.aborted && await params.isCurrent() && !signal.aborted;
    const workflowContext = original.workflow ? params.workflowActionContext : undefined;
    if (original.workflow && (workflowContext?.actionCaller?.kind !== 'workflowRun'
      || workflowContext.actionCaller.runId !== original.workflow.runId)) return denied();
    if ('kind' in original) {
      if (!params.postWorkflowMessage) return unavailable();
      if (!await current()) return denied();
      const origin = await resolveCurrentOrigin(signal);
      const accountId = readAccountIdFromToken(params.credentials.token);
      if (!origin) return unavailable();
      if (!accountId || !isCapturedHome(original.serverId, origin.serverIdentityId)
        || !isCapturedHome(original.discussion.discussion.serverId, origin.serverIdentityId) || !await current()) return denied();
      const localId = deriveWorkflowDiscussionReplyLocalIdV1(original.workflow);
      const receipt: { value?: DiscussionAgentPostResponseV1; failure?: unknown } = {};
      const { createCliActionExecutor } = await import('@/session/actions/createCliActionExecutor');
      const executor = createCliActionExecutor({ token: params.credentials.token, credentials: params.credentials,
        sessionId: '', mode: 'plain', ctx: null, serverId: params.serverId, serverHttpBaseUrl: params.serverHttpBaseUrl,
        serverIdentityId: origin.serverIdentityId, isCredentialCurrent: current,
        ...(params.actionsSettingsProvider ? { actionsSettingsProvider: params.actionsSettingsProvider } : {}),
        postWorkflowDiscussionMessage: async request => {
          if (!await current() || request.discussionId !== original.discussion.discussion.discussionId
            || request.request.localId !== localId || request.request.replyTarget?.kind !== 'message'
            || request.request.replyTarget.messageId !== original.discussion.messageId) return denied();
          try { receipt.value = await params.postWorkflowMessage!({ ...request, producer: original.producer, origin: original.discussion,
            ...(original.expectedParentRevision !== undefined ? { expectedParentRevision: original.expectedParentRevision } : {}) }, { signal }); }
          catch (error) { receipt.failure = error; throw error; }
          return receipt.value;
        } });
      const result = await executor.execute('discussion.reply', { discussionId: original.discussion.discussion.discussionId, localId,
        replyTarget: { kind: 'message', messageId: original.discussion.messageId }, content: original.content }, {
        ...workflowContext, serverId: params.serverId, surface: 'agent', authority: 'account_automation',
        runtimeAccountId: accountId, defaultSessionMachineId: params.machineId,
        discussionReplyReturn: { kind: 'workflow_invocation', serverId: origin.serverIdentityId,
          producer: original.producer, origin: original.discussion,
          ...(original.expectedParentRevision !== undefined ? { expectedParentRevision: original.expectedParentRevision } : {}) },
        actionRequestId: localId, signal,
      });
      if (receipt.failure) {
        signal.throwIfAborted();
        return withoutReceipt({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }, 'workflow_publication');
      }
      return receipt.value ? publicationResult(receipt.value, 'workflow_publication') : withoutReceipt(result, 'workflow_publication');
    }
    if (!original.workflow && original.serverId !== params.serverId
      || original.discussion.participantSessionId !== original.requestSessionId || !await current()) return denied();
    const origin = await resolveCurrentOrigin(signal);
    if (!origin) return unavailable();
    if (original.workflow && !isCapturedHome(original.serverId, origin.serverIdentityId) || !await current()) return denied();
    const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: original.requestSessionId,
      localId: original.requestLocalId, acceptedTurnId: original.acceptedTurnId });
    if (!original.workflow) {
      // Recovery's result projection can await while an explicit answer commits.
      // Reconcile the same original before even preparing another Action approval;
      // the append owner's later dedupe alone cannot prevent a duplicate prompt.
      const latest = await runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => readSessionMessageReply({
        credentials: params.credentials, sessionId: original.requestSessionId, localId: original.requestLocalId, signal,
      }));
      const progress = latest.status === 'available' ? latest.progress : undefined;
      if (!await current() || progress?.mode !== 'return' || progress.disposition !== 'return_pending'
        || progress.acceptedTurnId !== original.acceptedTurnId || !progress.outcome
        || progress.outcome.kind === 'answer' && 'publicationRef' in progress.outcome
        || progress.discussion?.participantSessionId !== original.requestSessionId
        || progress.discussion.discussionId !== original.discussion.discussionId
        || progress.discussion.messageId !== original.discussion.messageId
        || progress.discussion.throughSeq !== original.discussion.throughSeq) return denied();
    }
    const { createCliActionExecutor } = await import('@/session/actions/createCliActionExecutor');
    if (!await current()) return denied();
    const receipt: { value?: DiscussionAgentPostResponseV1 } = {};
    const transportFailure: { value?: Readonly<{ error: unknown }> } = {};
    let phase: SessionMessageReplyPublicationFailureV1['phase'] = 'action_admission';
    const executor = createCliActionExecutor({ token: params.credentials.token, credentials: params.credentials,
      sessionId: '', mode: 'plain', ctx: null, serverId: params.serverId, serverHttpBaseUrl: params.serverHttpBaseUrl,
      serverIdentityId: origin.serverIdentityId,
      isCredentialCurrent: current,
      ...(params.actionsSettingsProvider ? { actionsSettingsProvider: params.actionsSettingsProvider } : {}),
      postAgentDiscussionMessage: async request => {
        phase = 'publisher_request';
        const parsed = DiscussionAgentPostRequestV1Schema.safeParse(request);
        if (!parsed.success || parsed.data.sessionId !== original.requestSessionId
          || parsed.data.discussionId !== original.discussion.discussionId || parsed.data.request.localId !== localId
          || parsed.data.request.replyTarget?.kind !== 'message'
          || parsed.data.request.replyTarget.messageId !== original.discussion.messageId || !await current()) return denied();
        phase = 'session_transport';
        const transport = await resolveSessionTransportContext({ reason: 'session-control', credentials: params.credentials,
          idOrPrefix: original.requestSessionId, signal });
        if (!transport.ok) return transport.code === 'session_not_found' ? denied() : unavailable();
        if (transport.sessionId !== original.requestSessionId || !await current()) return denied();
        const replyReturn = { serverId: origin.serverIdentityId, requestLocalId: original.requestLocalId,
          ...(original.workflow ? { workflow: original.workflow } : {}),
          ...(original.acceptedTurnId ? { acceptedTurnId: original.acceptedTurnId } : {}) };
        try {
          if (original.workflow) {
            phase = 'machine_publisher';
            // The accepted invocation owns this result after the native
            // receiver exits. Reuse the installed Machine's original-return
            // append; never resume or borrow a live Session publisher.
            if (!params.postWorkflowMessage) return unavailable();
            receipt.value = await params.postWorkflowMessage({ ...parsed.data, replyReturn, terminalReturn: true }, { signal });
          } else {
            phase = 'session_publisher';
            receipt.value = DiscussionAgentPostResponseV1Schema.parse(await callSessionRpc({
              token: params.credentials.token, sessionId: transport.sessionId,
              method: SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1,
              request: { request: { ...parsed.data, replyReturn } },
              authorityCeiling: 'account_automation', timeoutMs: null, signal,
              ...(transport.mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', ctx: transport.ctx }),
            }));
          }
        } catch (error) {
          transportFailure.value = { error };
          throw error;
        }
        return receipt.value;
      },
    });
    // These are retained original-input facts, not a fabricated active witness.
    const sessionInputSource = original.acceptedTurnId ? SessionInputSourceSessionV1Schema.parse({
      sourceSessionId: original.requestSessionId, sourceTurnId: original.acceptedTurnId,
      sourceInputId: original.requestLocalId, via: 'action', discussionAddressing: original.discussion,
    }) : undefined;
    const result = await executor.execute('discussion.reply', { discussionId: original.discussion.discussionId, localId,
      replyTarget: { kind: 'message', messageId: original.discussion.messageId },
      content: original.content ?? { v: 1, parts: [{ t: 'text', text: original.message }] },
    }, { ...workflowContext, serverId: params.serverId, surface: 'agent', authority: 'account_automation',
      defaultSessionId: original.requestSessionId, defaultSessionMachineId: params.machineId,
      actionCaller: workflowContext?.actionCaller ?? { kind: 'host' },
      discussionReplyReturn: { serverId: origin.serverIdentityId, requestLocalId: original.requestLocalId,
        ...(original.workflow ? { workflow: original.workflow } : {}),
        ...(original.acceptedTurnId ? { acceptedTurnId: original.acceptedTurnId } : {}) },
      actionRequestId: localId, signal, ...(sessionInputSource ? { sessionInputSource } : {}),
      ...(original.actionRequestAttributionV1 && !workflowContext?.actionRequestAttributionV1
        ? { actionRequestAttributionV1: original.actionRequestAttributionV1 } : {}),
    });
    // Action admission reports failures as values. Do not reinterpret a native
    // append whose acknowledgement was lost as an authoritative refusal.
    if (transportFailure.value) {
      signal.throwIfAborted();
      return withoutReceipt({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }, phase);
    }
    return receipt.value ? publicationResult(receipt.value, phase) : withoutReceipt(result, phase);
  };
}
