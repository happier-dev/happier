import { SessionUserMessageSendRequestSchema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';

export function registerSessionUserMessageSendHandler(
  rpc: RpcHandlerRegistrar,
  opts: Readonly<{
    enqueueSessionUserMessage?: ((request: {
      text: string;
      localId?: string;
      meta: Record<string, unknown>;
    }) => Promise<void> | void) | null;
  }>,
): void {
  if (typeof opts.enqueueSessionUserMessage !== 'function') return;

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, async (raw: unknown) => {
    const parsed = SessionUserMessageSendRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'Invalid params', errorCode: 'session_user_message_invalid_input' };
    }

    await opts.enqueueSessionUserMessage?.({
      text: parsed.data.text,
      localId: parsed.data.localId,
      meta: parsed.data.meta,
    });
    return { ok: true };
  });
}
