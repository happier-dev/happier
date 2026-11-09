import type { PluginAccountCollectionForDefinition } from '@happier-dev/plugin-sdk/collections';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { CHANNEL_STATE_COLLECTION } from './collections.js';
import { readConversationDiscussionInputBindingId } from './discussionInputIdentity.js';
import { readConversationDiscussionBindingDestination } from './accountLocalBindingPolicy.js';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated, type PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { DiscussionReplyDestinationInputV1Schema } from '@happier-dev/channels-protocol/v1';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';

export type ConversationDiscussionReplyAncestor = Pick<
  PluginActionResultById['discussion.read']['messages'][number],
  'localId' | 'replyTarget'
>;

/** The same nearest Channel ancestor selects outward projection and approval context. */
export async function readConversationDiscussionReplyInput<T extends ConversationDiscussionReplyAncestor>(input: Readonly<{
  messageId: string;
  readMessage: (messageId: string) => Promise<T | undefined>;
}>): Promise<Readonly<{ bindingId: string; message: T }> | undefined> {
  let messageId: string | undefined = input.messageId;
  while (messageId !== undefined) {
    const message = await input.readMessage(messageId);
    if (!message) return undefined;
    const bindingId = readConversationDiscussionInputBindingId(message.localId);
    if (bindingId !== undefined) return { bindingId, message };
    messageId = message.replyTarget?.kind === 'message' ? message.replyTarget.messageId : undefined;
  }
  return undefined;
}

export async function readConversationDiscussionReplyDestination(input: Readonly<{
  discussionId: string;
  messageId: string;
  readMessage: (messageId: string) => Promise<ConversationDiscussionReplyAncestor | undefined>;
  collection: Pick<PluginAccountCollectionForDefinition<typeof CHANNEL_STATE_COLLECTION>, 'get'>;
  signal?: AbortSignal;
}>): Promise<Readonly<{ kind: 'channel'; connectionName: string | null; conversationName: string | null }> | Readonly<{ kind: 'none' }>> {
  const origin = await readConversationDiscussionReplyInput(input);
  if (!origin) return { kind: 'none' };
  const names = await readConversationDiscussionBindingDestination({ ...input, bindingId: origin.bindingId });
  return names ? { kind: 'channel', ...names } : { kind: 'none' };
}

/** Read-only Account runtime entry: Discussion reads retain their existing content admission and decryption. */
export async function readConversationDiscussionReplyDestinationForInvocation(input: JsonValue, context: PluginAccountActionContext) {
  const request = DiscussionReplyDestinationInputV1Schema.parse(input);
  return await readConversationDiscussionReplyDestination({ ...request, signal: context.signal,
    collection: requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION),
    readMessage: async messageId => {
      const result = await context.services.actions.execute('discussion.read', {
        discussionId: request.discussionId, messageId,
      }, { signal: context.signal });
      if (isPluginActionApprovalRequestCreated(result)) throw new PluginError({
        code: 'approval_required', message: 'Discussion read requires approval.', retryable: false,
      });
      const message = result.messages.find(message => message.id === messageId);
      if (result.incomplete || message === undefined || message.content === null) throw new PluginError({
        code: 'discussion_content_unavailable', message: 'Discussion reply ancestry is unavailable.', retryable: false,
      });
      return message;
    },
  });
}
