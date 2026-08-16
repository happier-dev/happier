import { describe, expect, it, vi } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerSessionUserMessageSendHandler } from './sessionUserMessageSend';

function createHarness(): Readonly<{
  handlers: Map<string, RpcHandler>;
  registrar: RpcHandlerRegistrar;
}> {
  const handlers = new Map<string, RpcHandler>();
  return {
    handlers,
    registrar: {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    },
  };
}

describe('session user message recovery admission', () => {
  it('delivers a first prompt when recovery control is unsupported before the provider runtime exists', async () => {
    const { handlers, registrar } = createHarness();
    const enqueueSessionUserMessage = vi.fn();
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.usageLimit.checkNow',
    }));
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      sessionId: 'fresh-session',
      enqueueSessionUserMessage,
      sessionRuntimeControls: { checkUsageLimitRecoveryNow } as never,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;

    await expect(handler({
      text: 'Create the first provider turn.',
      localId: 'first-provider-prompt',
      meta: {},
    })).resolves.toEqual({ ok: true });

    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledOnce();
    expect(enqueueSessionUserMessage).toHaveBeenCalledOnce();
  });
});
