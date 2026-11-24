import { describe, expect, it } from 'vitest';

import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { registerSessionPermissionRpcHandlers } from './sessionPermissions';

function createRpcHarness() {
  const handlers = new Map<string, (input: unknown, context?: unknown) => Promise<unknown>>();
  return {
    handlers,
    rpcHandlerManager: {
      registerHandler(method: string, handler: (input: unknown, context?: unknown) => Promise<unknown>) {
        handlers.set(method, handler);
      },
    },
  };
}

describe('session permission RPC handlers', () => {
  it('dispatches a permission mode change through the ActionSpec adapter', async () => {
    const calls: unknown[] = [];
    const actionExecutor: RpcActionExecutor = {
      execute: async (actionId, input, context) => {
        calls.push({ actionId, input, context });
        return { ok: true, result: { ok: true, actionId } };
      },
    };
    const { handlers, rpcHandlerManager } = createRpcHarness();

    registerSessionPermissionRpcHandlers({
      rpcHandlerManager,
      actionExecutor,
    });

    await expect(handlers.get('session.permission_mode.set')?.({
      sessionId: 'session-1',
      permissionMode: 'read_only',
    })).resolves.toEqual({ ok: true, actionId: 'session.permission_mode.set' });

    expect(calls).toEqual([
      {
        actionId: 'session.permission_mode.set',
        input: { sessionId: 'session-1', permissionMode: 'read_only' },
        context: { authority: 'account_automation', defaultSessionId: 'session-1', surface: 'rpc' },
      },
    ]);
  });

  it('maps a permission mode change refusal', async () => {
    const { handlers, rpcHandlerManager } = createRpcHarness();
    registerSessionPermissionRpcHandlers({
      rpcHandlerManager,
      actionExecutor: {
        execute: async () => ({
          ok: false,
          errorCode: 'unsupported_action',
          error: 'unsupported_action:session.permission_mode.set',
        }),
      },
    });

    await expect(handlers.get('session.permission_mode.set')?.({ sessionId: 'session-1' })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.permission_mode.set',
    });
  });
});
