import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DiscussionPostInputV1Schema, DiscussionReplyInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionParticipantsListResponseV1Schema, type DiscussionAnswerPolicyV1 } from '@happier-dev/protocol/discussions/participants';
import { SessionInputSourceSessionV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

/** Bind explicit and terminal drafts before the existing approval owner captures their operands. */
export async function bindDiscussionDraftReply(params: Readonly<{
  actionId: ActionId;
  input: unknown;
  context: ActionExecutorContext;
  serverId: string;
  serverIdentityId?: string;
  discussionAction: ActionExecutorDeps['discussionAction'];
  readAnswerPolicy?: () => Promise<DiscussionAnswerPolicyV1 | ActionExecuteFailure | null>;
  credentials?: Readonly<{ token: string }>;
  serverHttpBaseUrl?: string;
}>): Promise<Readonly<{ actionId: ActionId; input: unknown; context: ActionExecutorContext }>
  | Readonly<{ failure: ActionExecuteFailure }>> {
  const unchanged = { actionId: params.actionId, input: params.input, context: params.context };
  const unavailable = () => ({ ...unchanged, failure: { ok: false as const,
    errorCode: 'discussion_content_unavailable', error: 'discussion_content_unavailable' } });
  const { context } = params;
  if ((params.actionId !== 'discussion.post' && params.actionId !== 'discussion.reply')
    || context.discussionReplyReturn || context.approvedActionReplay || context.signal?.aborted
    || context.serverId !== undefined && !areServerProfileIdentifiersEquivalent(context.serverId, params.serverId,
      id => id === params.serverId || id === params.serverIdentityId ? params.serverIdentityId : null)
    || context.surface !== 'agent' && context.actionCaller?.kind !== 'session') return unchanged;
  const source = SessionInputSourceSessionV1Schema.safeParse(context.sessionInputSource);
  const parsed = (params.actionId === 'discussion.reply' ? DiscussionReplyInputV1Schema : DiscussionPostInputV1Schema).safeParse(params.input);
  if (!source.success || !parsed.success || !source.data.discussionAddressing || !source.data.sourceInputId) return unchanged;
  const addressing = source.data.discussionAddressing;
  const sourceInputId = source.data.sourceInputId;
  const publisherSessionId = context.actionCaller?.kind === 'session' ? context.actionCaller.sessionId : context.defaultSessionId;
  if (publisherSessionId !== addressing.participantSessionId
    || context.defaultSessionId !== undefined && context.defaultSessionId !== publisherSessionId
    || parsed.data.discussionId !== addressing.discussionId
    || parsed.data.replyTarget && (parsed.data.replyTarget.kind !== 'message'
      || parsed.data.replyTarget.messageId !== addressing.messageId)
    || !params.discussionAction) return unchanged;
  // Capture persisted policy before the daemon signs this original. Approval
  // and publication retain their own request admission at the canonical owners.
  let answerPolicy: DiscussionAnswerPolicyV1 | null | undefined;
  if (params.readAnswerPolicy) {
    const policy = await params.readAnswerPolicy();
    if (policy && typeof policy === 'object') return { failure: policy };
    answerPolicy = policy;
  } else {
    let rawRoster: unknown;
    try {
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
  // The verified daemon binds a real return obligation before signing. An
  // unchanged signed when-addressed reply may instead be an informational input
  // whose policy changed; preserve it without rewriting operands or borrowing
  // ambient credentials. An unbound deliberate draft still fails closed.
  if (context.externalActionExecutionAuthorization) return answerPolicy === 'drafts_for_approval'
    ? unavailable() : unchanged;
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
  return { actionId: 'discussion.reply', input: { ...parsed.data, localId,
    replyTarget: { kind: 'message', messageId: addressing.messageId } }, context: { ...context, actionRequestId: localId,
    discussionReplyReturn: { serverId: context.serverIdentityId, requestLocalId: source.data.sourceInputId,
      acceptedTurnId: source.data.sourceTurnId } } };
}
