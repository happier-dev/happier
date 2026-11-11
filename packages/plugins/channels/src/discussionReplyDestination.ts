import type { PluginAccountCollectionForDefinition } from '@happier-dev/plugin-sdk/collections';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { CHANNEL_STATE_COLLECTION } from './collections.js';
import { readConversationDiscussionInputBindingId } from './discussionInputIdentity.js';
import { readConversationDiscussionBindingDestination } from './accountLocalBindingPolicy.js';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated, type PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { DiscussionReplyDestinationInputV1Schema } from '@happier-dev/channels-protocol/v1';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { resolveAccountDisplayLabelV1 } from '@happier-dev/plugin-sdk/protocol';
import { readCurrentConversationProviderDisplayName } from './providerContributions.js';

export type ConversationDiscussionReplyAncestor = Pick<
  PluginActionResultById['discussion.read']['messages'][number],
  'localId' | 'replyTarget'
>;
type DestinationMessage = ConversationDiscussionReplyAncestor & Pick<
  PluginActionResultById['discussion.read']['messages'][number], 'content' | 'accountActor'
>;

async function readReplyAncestor<T extends ConversationDiscussionReplyAncestor>(input: Readonly<{
  messageId: string;
  readMessage: (messageId: string) => Promise<T | undefined>;
}>, matches: (message: T) => boolean): Promise<T | undefined> {
  let messageId: string | undefined = input.messageId;
  while (messageId !== undefined) {
    const message = await input.readMessage(messageId);
    if (!message) return undefined;
    if (matches(message)) return message;
    messageId = message.replyTarget?.kind === 'message' ? message.replyTarget.messageId : undefined;
  }
  return undefined;
}

function readExternalSource(message: DestinationMessage) {
  return message.content !== null && 'externalSource' in message.content ? message.content.externalSource : undefined;
}

/** The same nearest Channel ancestor selects outward projection and approval context. */
export async function readConversationDiscussionReplyInput<T extends ConversationDiscussionReplyAncestor>(input: Readonly<{
  messageId: string;
  readMessage: (messageId: string) => Promise<T | undefined>;
}>): Promise<Readonly<{ bindingId: string; message: T }> | undefined> {
  const message = await readReplyAncestor(input, message => readConversationDiscussionInputBindingId(message.localId) !== undefined);
  const bindingId = message && readConversationDiscussionInputBindingId(message.localId);
  return message && bindingId !== undefined ? { bindingId, message } : undefined;
}

export async function readConversationDiscussionReplyDestination(input: Readonly<{
  discussionId: string;
  messageId: string;
  readMessage: (messageId: string) => Promise<DestinationMessage | undefined>;
  collection: Pick<PluginAccountCollectionForDefinition<typeof CHANNEL_STATE_COLLECTION>, 'get'>;
  readProviderName?: (pluginId: string) => Promise<string | null>;
  signal?: AbortSignal;
}>): Promise<Readonly<{ kind: 'channel'; connectionName: string | null; conversationName: string | null }> | Readonly<{ kind: 'none' }>> {
  const origin = await readReplyAncestor(input, message => readConversationDiscussionInputBindingId(message.localId) !== undefined
    || readExternalSource(message) !== undefined);
  if (!origin) return { kind: 'none' };
  const bindingId = readConversationDiscussionInputBindingId(origin.localId);
  const source = readExternalSource(origin);
  if (source === undefined && bindingId !== undefined) {
    const names = await readConversationDiscussionBindingDestination({ ...input, bindingId });
    return names ? { kind: 'channel', ...names } : { kind: 'none' };
  }
  // Foreign local IDs and binding records are private. Display provenance is already readable,
  // and never becomes authority for the outward projection above.
  if (source === undefined) return { kind: 'none' };
  const ownerName = origin.accountActor?.profile ? resolveAccountDisplayLabelV1(origin.accountActor.profile) : null;
  const providerName = await input.readProviderName?.(source.providerPluginId);
  return { kind: 'channel', connectionName: [ownerName, providerName].filter(Boolean).join(' · ') || null,
    conversationName: source.conversationDisplayName };
}

/** Read-only Account runtime entry: Discussion reads retain their existing content admission and decryption. */
export async function readConversationDiscussionReplyDestinationForInvocation(input: JsonValue, context: PluginAccountActionContext) {
  const request = DiscussionReplyDestinationInputV1Schema.parse(input);
  return await readConversationDiscussionReplyDestination({ ...request, signal: context.signal,
    collection: requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION),
    readProviderName: async pluginId => {
      try {
        return await readCurrentConversationProviderDisplayName({ targetedContributions: context.services.targetedContributions,
          signal: context.signal }, pluginId);
      } catch {
        // Missing public provider presentation cannot erase a readable external destination.
        return null;
      }
    },
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
