import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { MessageBatch } from '@/agent/runtime/waitForMessagesOrPending';
import { waitForMessagesOrPending } from '@/agent/runtime/waitForMessagesOrPending';

export async function waitForNextPermissionModeMessage<Mode, Message>(opts: {
  messageQueue: MessageQueue2<Mode, Message>;
  abortSignal: AbortSignal;
  session: ApiSessionClient;
  onMetadataUpdate?: (() => void | Promise<void>) | null;
}): Promise<MessageBatch<Mode, Message> | null> {
  return await waitForMessagesOrPending({
    messageQueue: opts.messageQueue,
    abortSignal: opts.abortSignal,
    popPendingMessage: () => opts.session.popPendingMessage(),
    waitForMetadataUpdate: (signal) => opts.session.waitForMetadataUpdate(signal),
    onMetadataUpdate: opts.onMetadataUpdate,
  });
}
