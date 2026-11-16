import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readCommittedDiscussionMessage } from '@happier-dev/protocol/actions/executor/docCollaborationActions';
import { readWorkflowDiscussionContextV1 } from '@happier-dev/protocol/workflows';
import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions/references';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import type { StoredCredentials } from '@/persistence';
import { readSessionMessageReply } from '@/session/services/sessionMessageReply';
import type { WorkflowCoordinatorInvocation } from './coordinator';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { WorkflowInputResolutionError, type WorkflowValueResolutionRuntime } from './input';

type DiscussionAction = NonNullable<ActionExecutorDeps['discussionAction']>;
type DiscussionOrigin = Readonly<{ discussion: DiscussionAddressV1; messageId: string; throughSeq: number }>;

/** Resolve a committed occurrence through C3; caller text and local ids supply no frontier. */
export async function resolveWorkflowDiscussionOrigin(params: Readonly<{
  origin: Readonly<{ kind: 'discussion'; discussion: DiscussionAddressV1; addressingMessageId: string }>;
  context: ActionExecutorContext;
  discussionAction: DiscussionAction;
  /** Host-resolved producer, never caller-supplied publication text or a latest-message guess. */
  replyTo?: Readonly<{ credentials: StoredCredentials; runId: string; invocation: WorkflowCoordinatorInvocation; serverIdentityId?: string }>;
  signal?: AbortSignal;
}>): Promise<DiscussionOrigin> {
  const { origin } = params;
  const serverIdentityId = params.context.serverIdentityId ?? params.replyTo?.serverIdentityId;
  const context = { ...params.context, ...(serverIdentityId ? { serverIdentityId } : {}),
    ...(params.signal ? { signal: params.signal } : {}) };
  const sameHome = (left: string | null | undefined, right: string | null | undefined) =>
    areServerProfileIdentifiersEquivalent(left, right,
      id => id === context.serverId || id === serverIdentityId ? serverIdentityId : undefined);
  if (!context.serverId || !sameHome(context.serverId, origin.discussion.serverId)) {
    throw new WorkflowInputResolutionError('invalid_reference_scope');
  }
  let parent: Parameters<typeof readCommittedDiscussionMessage>[0] = { kind: 'discussion', discussion: origin.discussion,
    messageId: origin.addressingMessageId };
  if (params.replyTo) {
    const { credentials, runId, invocation } = params.replyTo;
    if (invocation.runId !== runId || invocation.lifecycle !== 'completed' || !invocation.execution) {
      throw new WorkflowInputResolutionError('workflow_discussion_context_unavailable');
    }
    if (invocation.execution.kind === 'session') {
      const original = await readSessionMessageReply({ credentials, sessionId: invocation.execution.sessionId,
        localId: invocation.execution.localInputId, ...(context.signal ? { signal: context.signal } : {}) });
      const progress = original.status === 'available' ? original.progress : undefined;
      const outcome = progress?.outcome;
      if (progress?.workflow?.runId !== runId || progress.workflow.invocationRecordId !== invocation.recordId
        || progress.disposition !== 'returned' || outcome?.kind !== 'answer' || !('publicationRef' in outcome)
        || outcome.publicationRef.kind !== 'discussion'
        || outcome.publicationRef.discussion.discussionId !== origin.discussion.discussionId
        || !sameHome(context.serverId, outcome.publicationRef.discussion.serverId)) {
        throw new WorkflowInputResolutionError('workflow_discussion_context_unavailable');
      }
      parent = { ...outcome.publicationRef, discussion: origin.discussion };
    } else {
      parent = { kind: 'discussion', discussion: origin.discussion, localId: deriveWorkflowDiscussionReplyLocalIdV1({
        runId, invocationRecordId: invocation.recordId, invocationAttempt: String(invocation.attempt),
      }) };
    }
  }
  const read = await readCommittedDiscussionMessage(parent, context, params.discussionAction, undefined, sameHome);
  if (!read.ok) throw createActionExecuteFailureError(read);
  if (!read.message.content
    || read.message.messageRef.discussion.discussionId !== origin.discussion.discussionId) {
    throw new WorkflowInputResolutionError('workflow_discussion_context_unavailable');
  }
  if (params.replyTo) {
    const producer = read.message.producerV1;
    const source = producer?.kind === 'agent' ? producer.replyReturn?.workflow : producer?.kind === 'workflow' ? producer : undefined;
    if (!source || source.runId !== params.replyTo.runId
      || source.invocationRecordId !== params.replyTo.invocation.recordId
      || source.invocationAttempt !== String(params.replyTo.invocation.attempt)) {
      throw new WorkflowInputResolutionError('workflow_discussion_context_unavailable');
    }
  }
  return { discussion: origin.discussion, messageId: read.message.id, throughSeq: read.message.seq };
}

/** The canonical Discussion codec/access reader owns every page; the invocation owns the chosen input. */
export function createProductionWorkflowDiscussionContextReader(params: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  serverIdentityId?: string;
  serverHttpBaseUrl: string;
  origin: DiscussionOrigin | undefined;
  signal?: AbortSignal;
}>): Required<Pick<WorkflowValueResolutionRuntime, 'resolveDiscussionContext'>> {
  const discussionAction = createDiscussionActionDeps({ credentials: params.credentials,
    serverId: params.serverId, serverHttpBaseUrl: params.serverHttpBaseUrl,
    ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}) }).discussionAction!;
  return { resolveDiscussionContext: async scope => {
    params.signal?.throwIfAborted();
    const origin = params.origin;
    if (!origin) {
      throw new WorkflowInputResolutionError('invalid_reference_scope');
    }
    const read = await readWorkflowDiscussionContextV1({ origin, scope, discussionAction,
      context: { surface: 'api', authority: 'account_automation', serverId: params.serverId,
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
        ...(params.signal ? { signal: params.signal } : {}) } });
    if (!read.ok) throw new WorkflowInputResolutionError(read.code);
    return StrictJsonValueSchema.parse(read.context);
  } };
}
