import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { CHANNELS_PAGE_VIEW_ID } from './sessionSurfaceIds.js';

export const INBOUND_CONVERSATION_NOTIFICATION_CATEGORY_ID = 'inbound-conversations';

/** The existing private notice store owns first creation and equal-write suppression. */
export async function notifyInboundConversation(input: Readonly<{
  conversationId: string;
  displayName?: string;
}>, context: PluginInvocationContext): Promise<void> {
  await context.services.notifications.send({
    clientRequestId: input.conversationId,
    categoryId: INBOUND_CONVERSATION_NOTIFICATION_CATEGORY_ID,
    itemId: input.conversationId,
    type: 'update',
    resolved: false,
    title: input.displayName ?? 'External conversation',
    channelIds: [],
    page: { pageId: CHANNELS_PAGE_VIEW_ID },
  }, { signal: context.signal });
}
