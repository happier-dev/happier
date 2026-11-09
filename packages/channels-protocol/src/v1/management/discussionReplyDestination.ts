import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

export const DISCUSSION_REPLY_DESTINATION_ACTION_ID_V1 = 'discussion-reply-destination-v1';
export const DiscussionReplyDestinationInputV1Schema = defineProtocolObject({
  discussionId: defineProtocolString({ minLength: 1 }), messageId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
export const DiscussionReplyDestinationResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('none') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('channel'),
    connectionName: defineProtocolString().nullable(), conversationName: defineProtocolString().nullable(),
  }, { policy: 'closed' }),
]);
export type DiscussionReplyDestinationResultV1 = ReturnType<typeof DiscussionReplyDestinationResultV1Schema.parse>;
