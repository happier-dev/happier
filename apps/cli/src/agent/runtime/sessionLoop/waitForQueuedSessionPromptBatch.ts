import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { waitForMessagesOrPending, type MessageBatch } from '@/agent/runtime/waitForMessagesOrPending';

export async function waitForQueuedSessionPromptBatch<Mode, Message>(params: Readonly<{
  messageQueue: MessageQueue2<Mode, Message>;
  abortSignal: AbortSignal;
  popPendingMessage: () => Promise<boolean>;
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  onMetadataUpdate?: (() => void | Promise<void>) | null;
}>): Promise<MessageBatch<Mode, Message> | null> {
  return await waitForMessagesOrPending(params);
}
