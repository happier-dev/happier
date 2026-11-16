import { DiscussionReadResultV1Schema, type DiscussionOpenedMessageV1 } from '../discussions/actions.js';
import type { DiscussionAddressV1 } from '../discussions/references.js';
import { areServerProfileIdentifiersEquivalent } from '../features/payload/capabilities/serverIdentityCapabilities.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import { createActionExecuteFailureError } from '../actions/actionExecutionResult.js';
import { readActionFailureEnvelope } from '../actions/executor/actionFailureEnvelope.js';

export type WorkflowDiscussionContextV1 = Readonly<{
  discussion: DiscussionAddressV1; messageId: string; throughSeq: number; messages: readonly DiscussionOpenedMessageV1[];
}>;

/** One authorized paging/frontier owner for Workflow references and round preparation. */
export async function readWorkflowDiscussionContextV1(params: Readonly<{
  origin: Readonly<{ discussion: DiscussionAddressV1; messageId: string; throughSeq: number }>;
  scope: 'addressing_message' | 'so_far';
  afterSeq?: number;
  context: ActionExecutorContext;
  discussionAction: NonNullable<ActionExecutorDeps['discussionAction']>;
  resolveServerProfileScopeId?: ActionExecutorDeps['resolveServerProfileScopeId'];
}>): Promise<Readonly<{ ok: true; context: WorkflowDiscussionContextV1 }>
  | Readonly<{ ok: false; code: 'invalid_reference_scope' | 'workflow_discussion_context_unavailable' }>> {
  const unavailable = () => ({ ok: false as const, code: 'workflow_discussion_context_unavailable' as const });
  const { origin, context } = params;
  const sameHome = (left: string, right: string) => areServerProfileIdentifiersEquivalent(left, right,
    id => (id === context.serverId || id === context.serverIdentityId) && context.serverIdentityId
      ? context.serverIdentityId : params.resolveServerProfileScopeId?.(id));
  if (!context.serverId || !sameHome(context.serverId, origin.discussion.serverId)) return { ok: false, code: 'invalid_reference_scope' };
  const messages: DiscussionOpenedMessageV1[] = [];
  let throughSeq = params.scope === 'addressing_message' ? origin.throughSeq : undefined;
  let beforeSeq: number | undefined;
  for (;;) {
    context.signal?.throwIfAborted();
    const result = await params.discussionAction({ actionId: 'discussion.read',
      input: { discussionId: origin.discussion.discussionId, ...(throughSeq === undefined ? {} : { throughSeq }),
        ...(beforeSeq === undefined ? {} : { beforeSeq }), ...(params.afterSeq === undefined ? {} : { afterSeq: params.afterSeq }) },
      context, ...(context.signal ? { signal: context.signal } : {}) });
    const failure = readActionFailureEnvelope(result);
    if (failure) throw createActionExecuteFailureError(failure);
    const page = DiscussionReadResultV1Schema.safeParse(result);
    if (!page.success || page.data.incomplete || page.data.discussionId !== origin.discussion.discussionId
      || !sameHome(page.data.serverId, origin.discussion.serverId)) return unavailable();
    throughSeq ??= page.data.messageSeq;
    if (page.data.messageSeq !== throughSeq || page.data.messages.some(message => !message.content
      || message.seq > throughSeq! || beforeSeq !== undefined && message.seq >= beforeSeq
      || params.afterSeq !== undefined && message.seq <= params.afterSeq
      || message.discussionId !== origin.discussion.discussionId || message.messageRef.messageId !== message.id
      || message.messageRef.discussion.discussionId !== origin.discussion.discussionId
      || !sameHome(message.messageRef.discussion.serverId, origin.discussion.serverId))) return unavailable();
    messages.push(...page.data.messages);
    if (!page.data.hasMoreOlder) break;
    const next = Math.min(...page.data.messages.map(message => message.seq));
    if (!Number.isFinite(next) || beforeSeq !== undefined && next >= beforeSeq) return unavailable();
    beforeSeq = next;
  }
  if (params.afterSeq === undefined && !messages.some(message => message.id === origin.messageId && message.seq === origin.throughSeq)) return unavailable();
  context.signal?.throwIfAborted();
  return { ok: true, context: { discussion: origin.discussion, messageId: origin.messageId, throughSeq: throughSeq!,
    messages: messages.sort((left, right) => left.seq - right.seq) } };
}
