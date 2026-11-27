import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DiscussionPublicationPolicy } from '@happier-dev/protocol/actions/executor/coreInvocation';
import { DISCUSSION_ACTION_INPUT_SCHEMAS_V1, DiscussionDetailsResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionParticipantsListResponseV1Schema, type DiscussionAnswerPolicyV1 } from '@happier-dev/protocol/discussions/participants';
import { SessionInputSourceSessionV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

/** Bind explicit and terminal drafts before the existing approval owner captures their operands. */
export async function bindDiscussionDraftReply(params: Readonly<{
  actionId: ActionId;
  input: unknown;
  context: ActionExecutorContext;
  serverId: string;
  serverIdentityId?: string;
  discussionAction: ActionExecutorDeps['discussionAction'];
  readAnswerPolicy?: () => Promise<DiscussionPublicationPolicy>;
  credentials?: Readonly<{ token: string }>;
  serverHttpBaseUrl?: string;
}>): Promise<Readonly<{ actionId: ActionId; input: unknown; context: ActionExecutorContext }>
  | Readonly<{ failure: ActionExecuteFailure }>> {
  const unchanged = { actionId: params.actionId, input: params.input, context: params.context };
  const unavailable = () => ({ ...unchanged, failure: { ok: false as const,
    errorCode: 'discussion_content_unavailable', error: 'discussion_content_unavailable' } });
  const { context } = params;
  if ((params.actionId !== 'discussion.post' && params.actionId !== 'discussion.reply')
    || context.discussionReplyReturn || context.approvedActionReplay || context.externalActionExecutionAuthorization || context.signal?.aborted
    || context.serverId !== undefined && !areServerProfileIdentifiersEquivalent(context.serverId, params.serverId,
      id => id === params.serverId || id === params.serverIdentityId ? params.serverIdentityId : null)
    || context.surface !== 'agent' && context.actionCaller?.kind !== 'session') return unchanged;
  const source = SessionInputSourceSessionV1Schema.safeParse(context.sessionInputSource);
  const parsed = DISCUSSION_ACTION_INPUT_SCHEMAS_V1[params.actionId].safeParse(params.input);
  if (!source.success || !parsed.success || !source.data.discussionAddressing || !source.data.sourceInputId) return unchanged;
  const addressing = source.data.discussionAddressing;
  const sourceInputId = source.data.sourceInputId;
  const publisherSessionId = context.actionCaller?.kind === 'session' ? context.actionCaller.sessionId : context.defaultSessionId;
  if (publisherSessionId !== addressing.participantSessionId
    || context.defaultSessionId !== undefined && context.defaultSessionId !== publisherSessionId
    || parsed.data.replyTarget && (parsed.data.replyTarget.kind !== 'message'
      || parsed.data.replyTarget.messageId !== addressing.messageId)
    || !params.discussionAction) return unchanged;
  const { discussionId: authoredDiscussionId, anchorTask, ...operands } = 'anchorTask' in parsed.data
    ? { ...parsed.data, discussionId: undefined } : { ...parsed.data, anchorTask: undefined };
  if (authoredDiscussionId !== undefined && authoredDiscussionId !== addressing.discussionId) return unchanged;
  // Capture persisted policy before the daemon signs this original. Approval
  // and publication retain their own request admission at the canonical owners.
  let answerPolicy: DiscussionAnswerPolicyV1 | null | undefined;
  if (params.readAnswerPolicy) {
    const policy = await params.readAnswerPolicy();
    if (!policy) return unchanged;
    if (!policy.ok) return { failure: policy };
    if (policy.discussionId !== addressing.discussionId) return unchanged;
    answerPolicy = policy.answerPolicy;
  } else {
    let rawRoster: unknown;
    try {
      if (anchorTask) {
        const raw = await params.discussionAction({ actionId: 'discussion.get', input: { anchorTask }, context,
          ...(context.signal ? { signal: context.signal } : {}) });
        const refused = ActionExecuteFailureSchema.safeParse(raw);
        if (refused.success) return refused.data.errorCode === 'discussion_not_found' ? unchanged : { failure: refused.data };
        const target = DiscussionDetailsResultV1Schema.safeParse(raw);
        if (!target.success || context.signal?.aborted) return unavailable();
        if (target.data.discussion.id !== addressing.discussionId) return unchanged;
      }
      rawRoster = await params.discussionAction({ actionId: 'discussion.participants.list',
        input: { discussionId: addressing.discussionId }, context, ...(context.signal ? { signal: context.signal } : {}) });
    } catch { return unavailable(); }
    const roster = DiscussionParticipantsListResponseV1Schema.safeParse(rawRoster);
    if (!roster.success || roster.data.discussionId !== addressing.discussionId || context.signal?.aborted) return unavailable();
    const participant = roster.data.participants.find(entry => entry.participant.kind === 'session'
      ? entry.participant.sessionId === publisherSessionId : 'sessionId' in entry && entry.sessionId === publisherSessionId);
    answerPolicy = participant?.answerPolicy;
  }
  if (context.signal?.aborted) return unavailable();
  const addressedReply = answerPolicy === 'when_addressed'
    && parsed.data.replyTarget?.kind === 'message' && parsed.data.replyTarget.messageId === addressing.messageId;
  if (answerPolicy !== 'drafts_for_approval' && !addressedReply) return unchanged;
  if (!context.serverIdentityId) return unavailable();
  if (addressedReply) {
    const credentials = params.credentials;
    if (!credentials) return unavailable();
    try {
      const { readSessionMessageReply } = await import('@/session/services/sessionMessageReply');
      const read = () => readSessionMessageReply({ credentials, sessionId: publisherSessionId,
        localId: sourceInputId, ...(context.signal ? { signal: context.signal } : {}) });
      const original = params.serverHttpBaseUrl ? await runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : await read();
      if (original.status === 'none') return unchanged;
      if (original.status !== 'available' || context.signal?.aborted) return unavailable();
      const progress = original.progress;
      // A policy change cannot turn an informational/watch input into an ask.
      // Only the retained original return obligation owns this stable intent.
      if (progress.mode !== 'return' || !progress.discussion || progress.workflow) return unchanged;
      if (progress.acceptedTurnId !== source.data.sourceTurnId
        || !['observing', 'return_pending'].includes(progress.disposition)
        || progress.discussion.participantSessionId !== publisherSessionId
        || progress.discussion.discussionId !== addressing.discussionId
        || progress.discussion.messageId !== addressing.messageId
        || progress.discussion.throughSeq !== addressing.throughSeq) return unavailable();
    } catch { return unavailable(); }
  }
  const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: publisherSessionId,
    localId: source.data.sourceInputId, acceptedTurnId: source.data.sourceTurnId });
  return { actionId: 'discussion.reply', input: { ...operands, discussionId: addressing.discussionId, localId,
    replyTarget: { kind: 'message', messageId: addressing.messageId } }, context: { ...context, actionRequestId: localId,
    discussionReplyReturn: { serverId: context.serverIdentityId, requestLocalId: source.data.sourceInputId,
      acceptedTurnId: source.data.sourceTurnId } } };
}
