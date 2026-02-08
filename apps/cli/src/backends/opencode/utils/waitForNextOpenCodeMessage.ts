import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';
import type { MessageBatch } from '@/agent/runtime/waitForMessagesOrPending';
import { waitForMessagesOrPending } from '@/agent/runtime/waitForMessagesOrPending';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

export async function waitForNextOpenCodeMessage(opts: {
    messageQueue: MessageQueue2<{ permissionMode: PermissionMode }>;
    abortSignal: AbortSignal;
    session: ApiSessionClient;
    onMetadataUpdate?: (() => void | Promise<void>) | null;
}): Promise<MessageBatch<{ permissionMode: PermissionMode }> | null> {
    return await waitForMessagesOrPending({
        messageQueue: opts.messageQueue,
        abortSignal: opts.abortSignal,
        popPendingMessage: () => opts.session.popPendingMessage(),
        waitForMetadataUpdate: (signal) => opts.session.waitForMetadataUpdate(signal),
        onMetadataUpdate: opts.onMetadataUpdate,
    });
}
