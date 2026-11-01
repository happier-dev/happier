import axios from 'axios';
import { StoredApprovalRequestSchema, admitApprovalRequesterDecisionV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { requiresPresentUserDecisionForActionInputV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import type { DiscussionAgentPublisherRequestV1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionDetailsResponseV1Schema, buildDiscussionAttachmentBindingsV1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionCreateInputV1Schema, DiscussionPostInputV1Schema, DiscussionDetailsResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { readCommittedDiscussionMessage } from '@happier-dev/protocol/actions/executor/docCollaborationActions';
import { DiscussionMessageContentV1Schema, DiscussionTitleV1Schema, isDiscussionDocEditProposalContentV1, readDiscussionMentionedParticipantIdsV1 } from '@happier-dev/protocol/discussions/content';
import { serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import { bindDiscussionActionHttpRequestV1 } from '@happier-dev/protocol/actions/discussionActionFamily';
import { SessionInputSourceSessionV1Schema, type SessionInputSourceSessionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { SessionMessageDiscussionReplyReturnV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { openResourceDataKey, type ResourceDataKey } from '@/api/encryption/resourceDataKey';
import { openSessionStoredContent } from '@/session/transport/encryption/sessionStoredContentCodec';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { deriveApprovedDiscussionMutationLocalId } from './discussionPublicationIdentity';
import { prepareDocDiscussionMutationV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { DiscussionInitialParticipantsV1Schema, DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import type { DiscussionDraftReviewV1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionSecondOpinionStartInputV1Schema } from '@happier-dev/protocol/discussions/secondOpinionActions';
import { prepareAnchoredDiscussionCreateV1, prepareSecondOpinionQuestionV1, readDiscussionSecondOpinionSourceV1 } from '@happier-dev/protocol/actions/executor/discussionSecondOpinion';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createDiscussionActionDeps } from './discussionActionDeps';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { DiscussionReplyInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import type { DiscussionWorkflowPostPublicationV1, DiscussionPostRequestV1 } from '@happier-dev/protocol/discussions/api';
import type { DiscussionMessageContentV1 } from '@happier-dev/protocol/discussions/content';
import { WorkflowInvocationGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { projectWorkflowDiscussionProducerV1, projectWorkflowDiscussionResultContentV1 } from '@happier-dev/protocol/workflows/workflowDiscussionPublicationV1';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

export type ApprovedDiscussionSourceActionExecute = (actionId: ActionId, input: unknown,
  context: ActionExecutorContext) => Promise<ActionExecuteResult>;

async function readExecutingDiscussionApproval(params: Readonly<{
  artifactId: string; credentials: StoredCredentials; serverId: string; serverUrl: string;
}>) {
  const store = createCliApprovalsArtifactStore({ credentials: params.credentials, serverId: params.serverId, serverHttpBaseUrl: params.serverUrl });
  const parsed = StoredApprovalRequestSchema.safeParse(await store.approvalsGet({ artifactId: params.artifactId, serverId: null }));
  return parsed.success && parsed.data.v === 2 && parsed.data.status === 'executing'
    && parsed.data.decision?.kind === 'approve' && parsed.data.execution === undefined ? parsed.data : null;
}

/** Same approved Artifact and accepted-result owner, without inventing Session custody. */
export async function readApprovedWorkflowDiscussionPublication(params: Readonly<{
  artifactId: string;
  request: Readonly<{ discussionId: string; request: DiscussionPostRequestV1 }>;
  content: DiscussionMessageContentV1;
  credentials: StoredCredentials; machineId: string; serverId: string; serverUrl: string; signal?: AbortSignal;
  callerAuthority?: ActionExecutorContext['authority'];
  executeSourceAction: ApprovedDiscussionSourceActionExecute;
  isApprovalExecutionOriginCurrent: NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>;
}>): Promise<DiscussionWorkflowPostPublicationV1 | null> {
  if (params.callerAuthority !== 'present_user') return null;
  return await runWithServerHttpBaseUrl(params.serverUrl, async () => {
    const approval = await readExecutingDiscussionApproval(params);
    if (!approval || approval.actionId !== 'discussion.reply' || approval.decision?.authority !== 'present_user') return null;
    const origin = approval.executionOriginV1;
    const marker = origin.discussionReplyReturn;
    if (!marker || !('kind' in marker) || origin.caller.kind !== 'workflowRun' || origin.caller.runId !== marker.producer.runId || origin.serverId !== params.serverId
      || origin.machineId !== params.machineId || marker.serverId !== origin.serverIdentityId
      || origin.accountId !== readAccountIdFromToken(params.credentials.token)
      || !await params.isApprovalExecutionOriginCurrent({ origin, request: approval, ...(params.signal ? { signal: params.signal } : {}) })) return null;
    const approved = DiscussionReplyInputV1Schema.safeParse(approval.actionArgs);
    const localId = deriveWorkflowDiscussionReplyLocalIdV1(marker.producer);
    if (!approved.success || origin.requestId !== localId || approved.data.localId !== localId
      || params.request.request.localId !== localId || params.request.discussionId !== marker.origin.discussion.discussionId
      || approved.data.discussionId !== params.request.discussionId
      || approved.data.replyTarget.kind !== 'message' || approved.data.replyTarget.messageId !== marker.origin.messageId
      || !sameStrictJsonValue(params.request.request.replyTarget, approved.data.replyTarget)
      || !sameStrictJsonValue(params.content, approved.data.content)
      || params.request.request.mentionedAccountIds.length !== 0 || (params.request.request.mentionedSessionIds?.length ?? 0) !== 0) return null;
    const workflow = marker.producer;
    const result = await params.executeSourceAction('workflow.run.invocations.get', { runId: workflow.runId, invocationId: workflow.invocationRecordId },
      { surface: 'cli', authority: 'account_automation', serverId: params.serverId, ...(params.signal ? { signal: params.signal } : {}) });
    const opened = result.ok ? WorkflowInvocationGetResultV1Schema.safeParse(result.result) : null;
    if (!opened?.success) return null;
    const { index, progress } = opened.data.invocation;
    if (index.id !== workflow.invocationRecordId || index.runId !== workflow.runId
      || index.attempt !== workflow.invocationAttempt || progress.attempt !== workflow.invocationAttempt
      || progress.review && index.lifecycle !== 'completed' && progress.review.decision?.kind !== 'use_result') return null;
    const delivery = progress.discussionReplyTo ?? opened.data.discussionResultDelivery;
    if (!delivery || delivery.discussion.discussionId !== marker.origin.discussion.discussionId
      || delivery.messageId !== marker.origin.messageId || delivery.throughSeq !== marker.origin.throughSeq
      || !areServerProfileIdentifiersEquivalent(delivery.discussion.serverId, params.serverId,
        id => id === params.serverId || id === origin.serverIdentityId ? origin.serverIdentityId : null)) return null;
    const expectedProducer = projectWorkflowDiscussionProducerV1({ runId: index.runId, invocationRecordId: index.id,
      invocationAttempt: index.attempt, blockKind: progress.blockKind, lifecycle: index.lifecycle,
      ...(progress.execution ? { execution: progress.execution } : {}), ...(progress.result !== undefined ? { result: progress.result } : {}) });
    const expectedContent = projectWorkflowDiscussionResultContentV1({ runId: index.runId, invocationRecordId: index.id,
      invocationAttempt: index.attempt, lifecycle: index.lifecycle, ...(progress.result !== undefined ? { result: progress.result } : {}) });
    if (!expectedProducer || !sameStrictJsonValue(workflow, expectedProducer) || !sameStrictJsonValue(params.content, expectedContent)) return null;
    const response = await axios.get(params.serverUrl.replace(/\/+$/, '') + bindDiscussionActionHttpRequestV1('discussion.get', {
      discussionId: params.request.discussionId }).path, { headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${params.credentials.token}` }, validateStatus: () => true, ...(params.signal ? { signal: params.signal } : {}) });
    if (response.status !== 200) return null;
    const summary = DiscussionDetailsResponseV1Schema.parse(response.data).discussion;
    if (summary.id !== params.request.discussionId || !summary.keyReadiness) return null;
    const resourceKey = await openResourceDataKey({ credentials: params.credentials, mode: summary.encryptionMode, dataEncryptionKey: summary.dataEncryptionKey });
    let openedContent;
    try { openedContent = DiscussionMessageContentV1Schema.safeParse(openSessionStoredContent({ content: params.request.request.content,
      ...(resourceKey.mode === 'plain' ? { mode: 'plain', ctx: null } : { mode: 'e2ee',
        ctx: { encryptionKey: resourceKey.dataKey, encryptionVariant: 'dataKey' } }) })); }
    catch { return null; }
    if (!openedContent.success || !sameStrictJsonValue(openedContent.data, expectedContent)) return null;
    return { ...params.request, producer: expectedProducer, origin: marker.origin,
      ...(marker.expectedParentRevision !== undefined ? { expectedParentRevision: opened.data.invocation.parentRevision } : {}) };
  });
}

/** Reopens the existing approved Artifact; neither a reference nor caller metadata is authority. */
export async function readApprovedDiscussionPublication(params: Readonly<{
  artifactId: string;
  request: DiscussionAgentPublisherRequestV1;
  credentials: StoredCredentials;
  sessionId: string;
  serverId: string;
  serverUrl: string;
  signal?: AbortSignal;
  /** Verified Session RPC ingress, not a field in the private request or Artifact. */
  callerAuthority?: ActionExecutorContext['authority'];
  requesterApprovalDecision?: ActionExecutorContext['requesterApprovalDecision'];
  /** Canonical read Actions under this independently verified immutable origin. */
  executeSourceAction?: ApprovedDiscussionSourceActionExecute;
  isApprovalExecutionOriginCurrent: NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>;
}>): Promise<Readonly<{ serverIdentityId?: string; sourceSession?: SessionInputSourceSessionV1; replyReturn?: SessionMessageDiscussionReplyReturnV1;
  draftReview?: DiscussionDraftReviewV1; terminalReturn?: true; runId?: string; toolCallId: string }> | null> {
  return await runWithServerHttpBaseUrl(params.serverUrl, async () => {
    const approval = await readExecutingDiscussionApproval(params);
    if (!approval) return null;
    const docMutation = approval.actionId === 'doc.comment.reply' || approval.actionId === 'doc.edit.propose'
      ? prepareDocDiscussionMutationV1(approval.actionId, approval.actionArgs, params.serverId) : undefined;
    let actionId: string = docMutation?.actionId ?? approval.actionId;
    let actionInput: unknown = docMutation?.input ?? approval.actionArgs;
    if (actionId !== 'discussion.create' && actionId !== 'discussion.post' && actionId !== 'discussion.reply'
      && actionId !== 'discussion.second_opinion.start') return null;
    // The Artifact is Account-writable data. The replay owner requires actual
    // present-person ingress for human-mandated Actions; the effect port must
    // retain that same requirement rather than trusting its stored decision.
    if (requiresPresentUserDecisionForActionInputV1(getActionSpec(approval.actionId), approval.actionArgs)
      && params.callerAuthority !== 'present_user') return null;
    const origin = approval.executionOriginV1;
    if (origin.discussionReplyReturn && 'kind' in origin.discussionReplyReturn) return null;
    const terminalReturn = (origin.caller.kind === 'host' || origin.caller.kind === 'workflowRun'
      && origin.caller.runId === origin.discussionReplyReturn?.workflow?.runId) && origin.discussionReplyReturn !== undefined
      && origin.sessionId === params.sessionId && Boolean(origin.machineId);
    if (origin.serverId !== params.serverId || origin.accountId !== readAccountIdFromToken(params.credentials.token)
      || !(origin.caller.kind === 'session' && origin.caller.sessionId === params.sessionId || terminalReturn)
      || origin.sessionId !== undefined && origin.sessionId !== params.sessionId
      || params.request.sessionId !== params.sessionId
      || !await params.isApprovalExecutionOriginCurrent({ origin, request: approval,
        ...(params.signal ? { signal: params.signal } : {}) })) return null;
    const source = SessionInputSourceSessionV1Schema.safeParse(origin.sessionInputSource);
    const sourceIsExact = source.success && source.data.sourceSessionId === params.sessionId
      && Boolean(source.data.sourceInputId && source.data.sourceTurnId);
    const replyReturn = origin.discussionReplyReturn;
    if (replyReturn) {
      if (replyReturn.serverId !== origin.serverIdentityId || actionId !== 'discussion.reply' || 'operation' in params.request
        || !sameStrictJsonValue(params.request.replyReturn, replyReturn)) return null;
    } else if (!sourceIsExact) return null;

    const crypto = (key: ResourceDataKey) => key.mode === 'plain'
      ? { mode: 'plain' as const, ctx: null }
      : { mode: 'e2ee' as const, ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' as const } };
    const messageIntent = (input: Readonly<{ content: Parameters<typeof readDiscussionMentionedParticipantIdsV1>[0];
      mentionedAccountIds?: readonly string[]; mentionedSessionIds?: readonly string[];
      replyTarget?: import('@happier-dev/protocol/discussions/replyTargets').DiscussionReplyTargetV1 }>) => {
      const mentions = readDiscussionMentionedParticipantIdsV1(input.content);
      return { content: input.content, mentionedAccountIds: input.mentionedAccountIds ?? mentions.mentionedAccountIds,
        mentionedSessionIds: input.mentionedSessionIds ?? mentions.mentionedSessionIds,
        ...buildDiscussionAttachmentBindingsV1(input.content, 'operation' in params.request
          ? params.request.request.firstMessage.content.t : params.request.request.content.t),
        ...(input.replyTarget === undefined ? {} : { replyTarget: input.replyTarget }) };
    };
    if (actionId === 'discussion.second_opinion.start') {
      const root = DiscussionSecondOpinionStartInputV1Schema.safeParse(actionInput);
      if (!root.success || root.data.intent !== 'ask' || root.data.reviewers.length !== 1 || !params.executeSourceAction
        || root.data.publisherSessionId !== undefined && root.data.publisherSessionId !== params.sessionId) return null;
      const sourceContext: ActionExecutorContext = { serverId: params.serverId, surface: origin.surface,
        authority: origin.authority, defaultSessionId: params.sessionId, actionCaller: origin.caller,
        ...(source.success ? { sessionInputSource: source.data } : {}), ...(params.signal ? { signal: params.signal } : {}) };
      const sourceHome = root.data.source.kind === 'session'
        ? root.data.source.message.session.serverId : root.data.source.passage.ref.serverId;
      if (!sourceHome || !await isServerProfileHomeIdentity(params.serverId, sourceHome)) return null;
      const quote = await readDiscussionSecondOpinionSourceV1(root.data.source, params.executeSourceAction, sourceContext);
      const expectedCreate = prepareAnchoredDiscussionCreateV1({ source: root.data.source, title: root.data.title, quote,
        creationLocalId: root.data.retry.creationLocalId, quoteLocalId: root.data.retry.quoteLocalId,
        ...(root.data.participants ? { participants: root.data.participants } : {}) });
      if ('operation' in params.request) {
        actionId = 'discussion.create';
        actionInput = expectedCreate;
      } else {
        // Find the source quote in the resource this exact approved create
        // committed. Neither a caller's Discussion id nor copied text is proof.
        const reader = createDiscussionActionDeps({ credentials: params.credentials, serverId: params.serverId,
          serverHttpBaseUrl: params.serverUrl }).discussionAction!;
        const discussionId = params.request.discussionId;
        const opened = DiscussionDetailsResultV1Schema.safeParse(await reader({ actionId: 'discussion.get',
          input: { discussionId }, context: sourceContext, ...(params.signal ? { signal: params.signal } : {}) }));
        if (!opened.success || opened.data.discussion.id !== discussionId
          || opened.data.discussion.creationLocalId !== root.data.retry.creationLocalId
          || opened.data.discussion.ownerAccountId !== origin.accountId
          || !sameStrictJsonValue(opened.data.discussion.anchor, expectedCreate.anchor ?? null)) return null;
        const quoteRead = await readCommittedDiscussionMessage({ kind: 'discussion',
          discussion: { serverId: params.serverId, discussionId }, localId: root.data.retry.quoteLocalId }, sourceContext, reader);
        if (!quoteRead.ok) return null;
        const first = quoteRead.message;
        if (first.seq !== 1 || first.authorAccountId !== origin.accountId
          || first.producerV1?.kind !== 'agent' || first.producerV1.sessionId !== params.sessionId || !first.content
          || serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...messageIntent({ ...first, content: first.content }) })
            !== serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...messageIntent(expectedCreate.firstMessage) })) return null;
        const quoteMessageId = first.id;
        const selected = root.data.reviewers[0]!;
        let reviewerSessionId: string;
        if (selected.selection.kind === 'session') reviewerSessionId = selected.selection.session.sessionId;
        else {
          const roster = DiscussionParticipantsListResponseV1Schema.safeParse(await reader({ actionId: 'discussion.participants.list',
            input: { discussionId }, context: sourceContext, ...(params.signal ? { signal: params.signal } : {}) }));
          if (!roster.success) return null;
          const participant = roster.data.participants.find(row => row.participant.kind === 'model'
            && row.participant.participantSlotId === selected.participantSlotId);
          if (!participant || !('launch' in participant) || !participant.sessionId
            || !sameStrictJsonValue(participant.launch, selected.selection.launch)) return null;
          reviewerSessionId = participant.sessionId;
        }
        actionId = 'discussion.post';
        actionInput = prepareSecondOpinionQuestionV1({ discussionId, sessionId: reviewerSessionId, question: root.data.question,
          questionLocalId: root.data.retry.questionLocalId, quoteMessageId });
      }
    }
    if ('operation' in params.request) {
      if (actionId !== 'discussion.create') return null;
      const input = DiscussionCreateInputV1Schema.safeParse(actionInput);
      if (!input.success || !sameStrictJsonValue(input.data.attachmentSources ?? [], params.request.attachmentSources ?? [])) return null;
      const body = params.request.request;
      if ((input.data.creationLocalId ?? deriveApprovedDiscussionMutationLocalId({ requestId: origin.requestId, purpose: 'creation' })) !== body.creationLocalId
        || (input.data.firstMessage.localId ?? deriveApprovedDiscussionMutationLocalId({ requestId: origin.requestId, purpose: 'first_message' })) !== body.firstMessage.localId) return null;
      const currentness = await fetchAccountEncryptionCurrentness({ token: params.credentials.token,
        serverBaseUrl: params.serverUrl, allowCredentialRecovery: false, signal: params.signal });
      const key = await openResourceDataKey({ credentials: params.credentials, mode: currentness.mode,
        dataEncryptionKey: body.dataEncryptionKey ?? null });
      const title = DiscussionTitleV1Schema.parse(openSessionStoredContent({ ...crypto(key), content: body.titleContent }));
      const content = DiscussionMessageContentV1Schema.parse(openSessionStoredContent({ ...crypto(key), content: body.firstMessage.content }));
      if ((body.firstMessage.docEditProposal === true) !== isDiscussionDocEditProposalContentV1(content)) return null;
      const expected = serializeDiscussionMutationEqualityIntentV1({ kind: 'create',
        title: { v: 1, title: input.data.title }, anchor: input.data.anchor,
        participants: input.data.participants === undefined ? undefined : DiscussionInitialParticipantsV1Schema.parse(input.data.participants),
        firstMessage: { ...messageIntent(input.data.firstMessage), localId: body.firstMessage.localId } });
      const actual = serializeDiscussionMutationEqualityIntentV1({ kind: 'create', title,
        anchor: body.anchor, participants: body.participants, firstMessage: { ...body.firstMessage, content } });
      if (expected !== actual) return null;
    } else {
      if (actionId !== 'discussion.post' && actionId !== 'discussion.reply') return null;
      const input = DiscussionPostInputV1Schema.safeParse(actionInput);
      if (!input.success || input.data.discussionId !== params.request.discussionId
        || !sameStrictJsonValue(input.data.attachmentSources ?? [], params.request.attachmentSources ?? [])
        || (input.data.localId ?? deriveApprovedDiscussionMutationLocalId({ requestId: origin.requestId, purpose: 'post' })) !== params.request.request.localId) return null;
      const bound = bindDiscussionActionHttpRequestV1('discussion.get', { discussionId: input.data.discussionId });
      const response = await axios.get(params.serverUrl.replace(/\/+$/, '') + bound.path,
        { headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.credentials.token}` }, validateStatus: () => true, signal: params.signal });
      if (response.status !== 200) return null;
      const summary = DiscussionDetailsResponseV1Schema.parse(response.data).discussion;
      if (summary.id !== input.data.discussionId || !summary.keyReadiness) return null;
      const key = await openResourceDataKey({ credentials: params.credentials, mode: summary.encryptionMode,
        dataEncryptionKey: summary.dataEncryptionKey });
      const body = params.request.request;
      const content = DiscussionMessageContentV1Schema.parse(openSessionStoredContent({ ...crypto(key), content: body.content }));
      if ((body.docEditProposal === true) !== isDiscussionDocEditProposalContentV1(content)) return null;
      if (serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...messageIntent(input.data) })
        !== serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...body, content })) return null;
    }
    let draftReview: DiscussionDraftReviewV1 | undefined;
    if (!('operation' in params.request)) {
      const bound = bindDiscussionActionHttpRequestV1('discussion.participants.list', { discussionId: params.request.discussionId });
      const response = await axios.get(params.serverUrl.replace(/\/+$/, '') + bound.path,
        { headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.credentials.token}` }, validateStatus: () => true, signal: params.signal });
      if (response.status !== 200) return null;
      const roster = DiscussionParticipantsListResponseV1Schema.parse(response.data);
      const participant = roster.participants.find(row => row.participant.kind === 'session'
        ? row.participant.sessionId === params.sessionId : 'sessionId' in row && row.sessionId === params.sessionId);
      if (!participant || participant.answerPolicy === 'reads_only') return null;
      if (participant.answerPolicy === 'drafts_for_approval' || params.callerAuthority === 'present_user') {
        // The stored decision label alone is editable Account data. The exact
        // original executor must also receive authenticated human ingress.
        // Preserve its actual reviewer even if participant policy changed
        // after capture; transports must not infer a reviewer from credentials.
        if (params.callerAuthority !== 'present_user') return null;
        const requesterAdmission = await admitApprovalRequesterDecisionV1({ request: approval,
          context: { authority: params.callerAuthority, runtimeAccountId: origin.accountId,
            ...(params.requesterApprovalDecision ? { requesterApprovalDecision: params.requesterApprovalDecision } : {}),
            ...(params.signal ? { signal: params.signal } : {}) } });
        if (!requesterAdmission.ok) return null;
        const decidingAccountId = approval.requesterConfirmation
          ? params.requesterApprovalDecision?.actor.accountId : origin.accountId;
        if (!decidingAccountId) return null;
        draftReview = { artifactId: params.artifactId, decidingAccountId };
      }
    }
    params.signal?.throwIfAborted();
    return { serverIdentityId: origin.serverIdentityId, ...(source.success && sourceIsExact ? { sourceSession: source.data } : {}),
      ...(draftReview ? { draftReview } : {}), ...(terminalReturn ? { terminalReturn: true as const } : {}),
      ...(replyReturn ? { replyReturn } : {}), ...(origin.runId ? { runId: origin.runId } : {}),
      toolCallId: approval.origin?.toolCallId ?? origin.requestId };
  });
}
