import { z } from 'zod/mini';
import axios from 'axios';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DiscussionAgentPublisherRequestV1Schema as PublisherRequestV1Schema, DiscussionAgentPostRequestV1Schema, DiscussionDetailsResponseV1Schema, type DiscussionAgentPublisherRequestV1, type DiscussionAgentPublisherInputV1, type DiscussionAgentPublisherPublicationInputV1 } from '@happier-dev/protocol/discussions/api';
import { bindDiscussionActionHttpRequestV1 } from '@happier-dev/protocol/actions/discussionActionFamily';
import { DiscussionMessageContentV1Schema, type DiscussionMessageContentV1 } from '@happier-dev/protocol/discussions/content';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { SessionInputSourceSessionV1Schema, type SessionInputSourceSessionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import { AgentRuntimeDaemonServiceTurnWitnessV1Schema, projectAgentRuntimeDaemonServiceTurnWitnessV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';
import type { RpcAdmissionPredicate, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { RunnerMcpSessionWithContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { DiscussionAddressingV1 } from '@happier-dev/protocol/discussions/participants';
import type { StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { openResourceDataKey } from '@/api/encryption/resourceDataKey';
import { openSessionStoredContent } from '@/session/transport/encryption/sessionStoredContentCodec';
import { projectSessionMessageReplyOutcome, readSessionMessageReply } from '@/session/services/sessionMessageReply';
import { readApprovedDiscussionPublication, type ApprovedDiscussionSourceActionExecute } from './approvedDiscussionPublication';
import { WorkflowInvocationGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { projectWorkflowDiscussionResultContentV1 } from '@happier-dev/protocol/workflows/workflowDiscussionPublicationV1';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { uploadDiscussionAgentAttachments } from './uploadDiscussionAgentAttachments';
import { DiscussionAgentPublisherPublicationV1Schema } from '@happier-dev/protocol/discussions/api';

/** Host-owned causal root shared by the active Session RPC and bound MCP host. */
export function readDiscussionAgentPublisherSourceSession(
  session: RunnerMcpSessionWithContext<Pick<ApiSessionClient, 'sessionId'>>,
): SessionInputSourceSessionV1 | null {
  const current = session.getActiveTurnAdmissionWitness?.();
  if (!current?.inputId || session.getRuntimeLifetimeSignal?.()?.aborted || session.getHostTurnAbortSignal?.()?.aborted) return null;
  const source = SessionInputSourceSessionV1Schema.safeParse({ sourceSessionId: session.sessionId,
    sourceTurnId: current.turnId, sourceInputId: current.inputId, via: 'action' });
  return source.success ? source.data : null;
}

/** The host derives original-return authority; authored markers never survive an active invocation. */
export function prepareActiveDiscussionAgentPublication(params: Readonly<{
  session: RunnerMcpSessionWithContext<Pick<ApiSessionClient, 'sessionId'>>;
  serverIdentityId: string | null | undefined;
  request: DiscussionAgentPublisherRequestV1;
}>): DiscussionAgentPublisherInputV1 | null {
  if (params.request.sessionId !== params.session.sessionId) return null;
  const sourceSession = readDiscussionAgentPublisherSourceSession(params.session);
  return sourceSession ? prepareDiscussionAgentPublication({ sessionId: params.session.sessionId,
    serverIdentityId: params.serverIdentityId, request: params.request, sourceSession,
    discussionAddressing: params.session.getActiveTurnAdmissionWitness?.()?.discussionAddressing }) : null;
}

function prepareDiscussionAgentPublication(params: Readonly<{
  sessionId: string;
  serverIdentityId: string | null | undefined;
  request: DiscussionAgentPublisherRequestV1;
  sourceSession: SessionInputSourceSessionV1;
  discussionAddressing?: DiscussionAddressingV1;
}>): DiscussionAgentPublisherInputV1 | null {
  const sourceSession = params.sourceSession;
  if (!sourceSession?.sourceInputId || !sourceSession.sourceTurnId) return null;
  const { v: _version, sessionId: _sessionId, sourceSession: _authoredSource, attachmentSources: _sources, ...input } = params.request;
  if ('operation' in input) return { ...input, sourceSession };
  const { replyReturn: _authoredReturn, ...publication } = input;
  const addressing = params.discussionAddressing;
  if (addressing?.participantSessionId === params.sessionId
    && addressing.discussionId === publication.discussionId
    && publication.request.replyTarget?.kind === 'message'
    && publication.request.replyTarget.messageId === addressing.messageId) {
    if (!params.serverIdentityId) return null;
    return { ...publication, sourceSession,
      request: { ...publication.request, localId: deriveSessionMessageReplyReturnLocalIdV1({
        sessionId: params.sessionId, localId: sourceSession.sourceInputId, acceptedTurnId: sourceSession.sourceTurnId,
      }) },
      replyReturn: { serverId: params.serverIdentityId, requestLocalId: sourceSession.sourceInputId, acceptedTurnId: sourceSession.sourceTurnId },
    };
  }
  return { ...publication, sourceSession };
}

const approvedActionReplaySchema = z.strictObject({ artifactId: z.string().check(z.trim(), z.minLength(1)) });

/** Private payload on the incumbent owner-only Session RPC transport. */
export const DiscussionAgentPublisherRequestV1Schema = z.union([
  z.strictObject({
    request: asHostProtocolZod(PublisherRequestV1Schema),
    witness: AgentRuntimeDaemonServiceTurnWitnessV1Schema,
  }),
  z.strictObject({
    request: asHostProtocolZod(PublisherRequestV1Schema),
    approvedActionReplay: approvedActionReplaySchema,
  }),
  // Without an executing approval, only the server-validated original reply
  // can outlive its turn. Ordinary posts/create require the active witness.
  z.strictObject({
    request: asHostProtocolZod(DiscussionAgentPostRequestV1Schema).check(z.refine(request =>
      request.replyReturn !== undefined && request.request.replyTarget?.kind === 'message')),
  }),
]);
export type DiscussionAgentPublisherPrivateRequestV1 = z.infer<typeof DiscussionAgentPublisherRequestV1Schema>;

/** The private Session RPC carries recorded approvals, not other host replay context. */
export function prepareApprovedDiscussionAgentPublication(params: Readonly<{
  request: DiscussionAgentPublisherRequestV1;
  replay: NonNullable<ActionExecutorContext['approvedActionReplay']>;
}>): DiscussionAgentPublisherPrivateRequestV1 | null {
  const replay = approvedActionReplaySchema.safeParse({ artifactId: params.replay.artifactId });
  return replay.success ? { request: params.request, approvedActionReplay: replay.data } : null;
}

/** An Account RPC caller may name an original, but cannot author its terminal result. */
async function verifyTerminalDiscussionReturn(params: Readonly<{
  request: DiscussionAgentPublisherRequestV1;
  credentials: StoredCredentials;
  serverId: string;
  serverIdentityId: string;
  serverUrl: string;
  signal?: AbortSignal;
  executeSourceAction?: ApprovedDiscussionSourceActionExecute;
  reportStage?: (stage: 'discussion_reply_custody' | 'discussion_reply_result') => void;
}>): Promise<boolean | 'unavailable'> {
  const { request, credentials, signal } = params;
  if ('operation' in request) return false;
  const marker = request.replyReturn;
  if (!marker || marker.serverId !== params.serverIdentityId || request.request.replyTarget?.kind !== 'message'
    || request.request.localId !== deriveSessionMessageReplyReturnLocalIdV1({ sessionId: request.sessionId,
      localId: marker.requestLocalId, acceptedTurnId: marker.acceptedTurnId })
    || request.request.mentionedAccountIds.length > 0 || (request.request.mentionedSessionIds?.length ?? 0) > 0) return false;
  const parentMessageId = request.request.replyTarget.messageId;
  return await runWithServerHttpBaseUrl(params.serverUrl, async () => {
    params.reportStage?.('discussion_reply_custody');
    const original = await readSessionMessageReply({ credentials, sessionId: request.sessionId,
      localId: marker.requestLocalId, ...(signal ? { signal } : {}) });
    if (original.status !== 'available') return false;
    const progress = original.progress;
    const workflow = marker.workflow;
    if ((workflow ? progress.mode !== 'wait' || !progress.workflow
      || progress.workflow.runId !== workflow.runId || progress.workflow.invocationRecordId !== workflow.invocationRecordId
      || !['observing', 'inline', 'returned'].includes(progress.disposition)
      : progress.mode !== 'return' || !['return_pending', 'returned'].includes(progress.disposition))
      || progress.acceptedTurnId !== marker.acceptedTurnId || !progress.outcome
      || progress.discussion?.participantSessionId !== request.sessionId
      || progress.discussion.discussionId !== request.discussionId
      || progress.discussion.messageId !== parentMessageId
      // Ordinary explicit replies settle final fallback. Workflow publication
      // may rejoin its same accepted result after losing the append ACK.
      || !workflow && progress.outcome.kind === 'answer' && 'publicationRef' in progress.outcome) return false;
    if (workflow && progress.outcome.kind === 'answer' && 'publicationRef' in progress.outcome
      && (progress.outcome.publicationRef.kind !== 'discussion'
        || progress.outcome.publicationRef.discussion.serverId !== params.serverIdentityId
        || progress.outcome.publicationRef.discussion.discussionId !== request.discussionId)) return false;
    params.reportStage?.('discussion_reply_result');
    let expectedContent: DiscussionMessageContentV1;
    if (workflow) {
      // Open through the existing Workflow Action owner, including its current
      // Run access/key census. A C2 terminal answer alone is not accepted output.
      if (!params.executeSourceAction) return 'unavailable';
      const result = await params.executeSourceAction('workflow.run.invocations.get', { runId: workflow.runId,
        invocationId: workflow.invocationRecordId }, { surface: 'cli', authority: 'account_automation',
        serverId: params.serverId, ...(signal ? { signal } : {}) });
      // A failed read proves no denial unless its owner confirms access or
      // policy refusal. Missing keys/storage/wiring must retain reply custody.
      if (!result.ok) return ['run_access_denied', 'not_authenticated', 'run_not_found',
        'action_disabled', 'present_user_required', 'approval_stale'].includes(result.errorCode ?? '') ? false : 'unavailable';
      const opened = WorkflowInvocationGetResultV1Schema.safeParse(result.result);
      if (!opened.success) return 'unavailable';
      const { index, progress: invocation } = opened.data.invocation;
      if (invocation.review && index.lifecycle !== 'completed' && invocation.review.decision?.kind !== 'use_result') return false;
      const delivery = invocation.discussionReplyTo ?? opened.data.discussionResultDelivery;
      if (!delivery || !areServerProfileIdentifiersEquivalent(delivery.discussion.serverId, params.serverId,
        id => id === params.serverId || id === params.serverIdentityId ? params.serverIdentityId : null)
        || delivery.discussion.discussionId !== request.discussionId
        || delivery.messageId !== parentMessageId || delivery.throughSeq !== progress.discussion.throughSeq) return false;
      if (!['completed', 'failed', 'cancelled'].includes(index.lifecycle) || index.runId !== workflow.runId || index.id !== workflow.invocationRecordId
        || index.attempt !== workflow.invocationAttempt || invocation.attempt !== workflow.invocationAttempt
        || invocation.execution?.kind !== 'session' || invocation.execution.sessionId !== request.sessionId
        || invocation.execution.localInputId !== marker.requestLocalId || progress.outcome.kind === 'declined') return false;
      if (progress.outcome.kind !== 'answer') {
        const projected = await projectSessionMessageReplyOutcome({ credentials, serverId: params.serverId,
          sessionId: request.sessionId, localId: marker.requestLocalId, outcome: progress.outcome,
          ...(signal ? { signal } : {}) });
        if (!projected) return false;
        expectedContent = { v: 1, parts: [{ t: 'text', text: projected.message }] };
      } else expectedContent = projectWorkflowDiscussionResultContentV1({ ...workflow,
        lifecycle: index.lifecycle, ...(invocation.result !== undefined ? { result: invocation.result } : {}) });
    } else {
      const projected = await projectSessionMessageReplyOutcome({ credentials, serverId: params.serverId,
        sessionId: request.sessionId, localId: marker.requestLocalId, outcome: progress.outcome, ...(signal ? { signal } : {}) });
      if (!projected) return false;
      expectedContent = { v: 1, parts: [{ t: 'text', text: projected.message }] };
    }
    const bound = bindDiscussionActionHttpRequestV1('discussion.get', { discussionId: request.discussionId });
    const response = await axios.get(params.serverUrl.replace(/\/+$/, '') + bound.path,
      { headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${credentials.token}` }, validateStatus: () => true, signal });
    if (response.status !== 200) return false;
    const summary = DiscussionDetailsResponseV1Schema.parse(response.data).discussion;
    if (summary.id !== request.discussionId || !summary.keyReadiness) return false;
    const key = await openResourceDataKey({ credentials, mode: summary.encryptionMode, dataEncryptionKey: summary.dataEncryptionKey });
    const crypto = key.mode === 'plain' ? { mode: 'plain' as const, ctx: null }
      : { mode: 'e2ee' as const, ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' as const } };
    const content = DiscussionMessageContentV1Schema.parse(openSessionStoredContent({ ...crypto, content: request.request.content }));
    signal?.throwIfAborted();
    return sameStrictJsonValue(content, expectedContent);
  });
}

export function createDiscussionAgentPublisher(params: Readonly<{
  serverId: string;
  serverUrl: string;
  /** Machine captured by the owning Session's transport composition. */
  machineId?: string | null;
  /** Canonical Home of this exact Session transport; not its routing profile. */
  getServerIdentityId?: () => string | null | undefined;
  readOwnerAccountCredentials: () => Promise<StoredCredentials | null>;
  isApprovalExecutionOriginCurrent: NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>;
  executeSourceAction?: ApprovedDiscussionSourceActionExecute;
  session: RunnerMcpSessionWithContext<Pick<ApiSessionClient, 'sessionId' | 'postAgentDiscussionMessage'>>;
}>) {
  return async (raw: unknown, context?: RpcHandlerContext) => {
    let stage: RpcAdmissionPredicate = 'session_authorization';
    const refused = (error: 'discussion_post_denied' | 'discussions_unavailable') => {
      context?.reportAdmissionDenial?.(stage);
      return { v: 1 as const, ok: false as const, error };
    };
    const denied = () => refused('discussion_post_denied');
    const readFailed = (error: unknown) => {
      const { kind } = classifyServerEndpointError(error);
      return refused(kind === 'server_error' || kind === 'dependency_unavailable' || kind === 'network' || kind === 'timeout'
        ? 'discussions_unavailable' : 'discussion_post_denied');
    };
    const reportStage = (next: 'discussion_reply_custody' | 'discussion_reply_result') => { stage = next; };
    let publicationHomeId = params.getServerIdentityId?.();
    const publish = async (publication: DiscussionAgentPublisherPublicationInputV1, signal?: AbortSignal) => {
      stage = 'discussion_publication';
      // A thrown/lost append acknowledgement remains outcome-unknown to the caller.
      try {
        const sources = parsed.success ? parsed.data.request.attachmentSources : undefined;
        let result;
        if (sources?.length) {
          const credentials = await params.readOwnerAccountCredentials();
          const homeId = publicationHomeId;
          if (!credentials || !homeId || !params.machineId || signal?.aborted) return denied();
          result = await uploadDiscussionAgentAttachments({ publication: DiscussionAgentPublisherPublicationV1Schema.parse({
            ...publication, v: 1, sessionId: params.session.sessionId,
          }), sources, credentials, serverUrl: params.serverUrl, serverIdentityId: homeId, machineId: params.machineId,
            ...(signal ? { signal } : {}) });
        } else result = await params.session.postAgentDiscussionMessage(publication, signal ? { signal } : undefined);
        if (!result.ok) context?.reportAdmissionDenial?.(stage);
        return result;
      } catch (error) {
        context?.reportAdmissionDenial?.(stage);
        throw error;
      }
    };
    const parsed = DiscussionAgentPublisherRequestV1Schema.safeParse(raw);
    if (!parsed.success || parsed.data.request.sessionId !== params.session.sessionId) return denied();
    const activePublication = 'witness' in parsed.data;
    if ('witness' in parsed.data) {
      const current = params.session.getActiveTurnAdmissionWitness?.();
      if (!current) return denied();
      try {
        if (!sameStrictJsonValue(parsed.data.witness, projectAgentRuntimeDaemonServiceTurnWitnessV1(current))) return denied();
      } catch { return denied(); }
    }
    const signals = [context?.signal, params.session.getRuntimeLifetimeSignal?.(),
      ...(activePublication ? [params.session.getHostTurnAbortSignal?.()] : [])]
      .filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
    if (signal?.aborted) return denied();
    if ('approvedActionReplay' in parsed.data) {
      stage = 'discussion_approval';
      let publication: DiscussionAgentPublisherPublicationInputV1 | null;
      try {
        const credentials = await params.readOwnerAccountCredentials();
        if (!credentials) return denied();
        const approved = await readApprovedDiscussionPublication({
          artifactId: parsed.data.approvedActionReplay.artifactId, request: parsed.data.request,
          credentials, sessionId: params.session.sessionId, serverId: params.serverId, serverUrl: params.serverUrl,
          callerAuthority: context?.callerAuthority,
          requesterApprovalDecision: context?.requesterApprovalDecision,
          isApprovalExecutionOriginCurrent: params.isApprovalExecutionOriginCurrent, ...(signal ? { signal } : {}),
          ...(params.executeSourceAction ? { executeSourceAction: params.executeSourceAction } : {}),
        });
        if (!approved || (await params.readOwnerAccountCredentials())?.token !== credentials.token || signal?.aborted) return denied();
        const { terminalReturn, draftReview, serverIdentityId, ...reviewedOrigin } = approved;
        publicationHomeId = serverIdentityId;
        if (terminalReturn) {
          if (!serverIdentityId) return denied();
          const verified = await verifyTerminalDiscussionReturn({ request: parsed.data.request, credentials,
            serverId: params.serverId, serverIdentityId, serverUrl: params.serverUrl, ...(signal ? { signal } : {}),
            reportStage, ...(params.executeSourceAction ? { executeSourceAction: params.executeSourceAction } : {}) });
          if (verified === 'unavailable') return refused('discussions_unavailable');
          if (!verified) return denied();
        }
        const { runId: _authoredRun, toolCallId: _authoredTool, sourceSession: _authoredSource, attachmentSources: _sources, ...reviewedRequest } = parsed.data.request;
        if (approved.replyReturn) {
          if ('operation' in reviewedRequest) return denied();
          const { v: _version, sessionId: _sessionId, replyReturn: _return, ...input } = reviewedRequest;
          publication = { ...input, ...reviewedOrigin, ...(draftReview ? { draftReview } : {}),
            ...(terminalReturn ? { terminalReturn } : {}),
            request: { ...input.request, localId: deriveSessionMessageReplyReturnLocalIdV1({
              sessionId: params.session.sessionId, localId: approved.replyReturn.requestLocalId,
              ...(approved.replyReturn.acceptedTurnId ? { acceptedTurnId: approved.replyReturn.acceptedTurnId } : {}),
            }) } };
        } else {
          const prepared = approved.sourceSession ? prepareDiscussionAgentPublication({ sessionId: params.session.sessionId, serverIdentityId,
            request: { ...reviewedRequest, ...reviewedOrigin }, sourceSession: approved.sourceSession,
            discussionAddressing: approved.sourceSession.discussionAddressing }) : null;
          publication = prepared && !('operation' in prepared) && draftReview ? { ...prepared, draftReview } : prepared;
        }
      } catch (error) { return readFailed(error); }
      // Once publication begins, loss of its acknowledgement is not proof of
      // denial. Preserve the transport failure for normal outcome reconciliation.
      return publication ? await publish(publication, signal) : denied();
    }
    const { v: _version, sessionId: _sessionId, sourceSession: _authoredSource, attachmentSources: _sources, ...request } = parsed.data.request;
    if (!activePublication) {
      stage = 'discussion_reply_custody';
      const serverIdentityId = params.getServerIdentityId?.();
      if (!serverIdentityId || !('replyReturn' in request) || request.replyReturn?.serverId !== serverIdentityId) return denied();
      try {
        const credentials = await params.readOwnerAccountCredentials();
        if (!credentials) return denied();
        const verified = await verifyTerminalDiscussionReturn({ request: parsed.data.request, credentials,
          serverId: params.serverId, serverIdentityId, serverUrl: params.serverUrl, ...(signal ? { signal } : {}),
          reportStage,
          ...(params.executeSourceAction ? { executeSourceAction: params.executeSourceAction } : {}) });
        if ((await params.readOwnerAccountCredentials())?.token !== credentials.token || signal?.aborted) return denied();
        if (verified === 'unavailable') return refused('discussions_unavailable');
        if (!verified) return denied();
      } catch (error) { return readFailed(error); }
      // The append owner stamps factual original provenance. Raw Account
      // operands supply neither a different causal root nor Run attribution.
      const { runId: _authoredRun, toolCallId: _authoredTool, ...terminal } = request;
      return await publish({ ...terminal, terminalReturn: true }, signal);
    }
    const publication = prepareActiveDiscussionAgentPublication({ session: params.session,
      serverIdentityId: params.getServerIdentityId?.(), request: parsed.data.request });
    if (!publication) return denied();
    // Workflow replies are accepted by their invocation owner first. Refuse an
    // active explicit answer to that same parent until the durable result path
    // can publish it under C2's one original-input obligation.
    if (!('operation' in publication) && publication.replyReturn) {
      stage = 'discussion_reply_custody';
      const credentials = await params.readOwnerAccountCredentials();
      if (!credentials) return denied();
      const original = await readSessionMessageReply({ credentials, sessionId: params.session.sessionId,
        localId: publication.replyReturn.requestLocalId, ...(signal ? { signal } : {}) });
      if (original.status === 'available' && original.progress.workflow) return denied();
    }
    return await publish(publication, signal);
  };
}

export function registerDiscussionAgentPublisher(params: Parameters<typeof createDiscussionAgentPublisher>[0] & Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
}>): void {
  params.rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1, createDiscussionAgentPublisher(params));
}
