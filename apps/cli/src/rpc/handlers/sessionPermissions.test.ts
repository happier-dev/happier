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
  it('dispatches canonical permission RPC methods through the ActionSpec adapter', async () => {
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

    await expect(handlers.get('session.permission.respond')?.({
      sessionId: 'session-1',
      requestId: 'permission-1',
      decision: 'allow',
    })).resolves.toEqual({ ok: true, actionId: 'session.permission.respond' });
    // Answering a Session's user action is a Session-routed Action: the host stamps its original origin.
    const sessionActionOrigin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: 'session-1', starterDepth: 0, turnDepth: 0 },
      sourceTurnId: 'turn-1', callerPermissionMode: null, requestId: 'origin-request-1' };
    await expect(handlers.get('session.user_action.answer')?.({
      sessionId: 'session-1',
      requestId: 'user-action-1',
      decision: 'approve',
    }, { signal: new AbortController().signal, sessionActionOrigin })).resolves.toEqual({ ok: true, actionId: 'session.user_action.answer' });
    await expect(handlers.get('session.permission_mode.set')?.({
      sessionId: 'session-1',
      permissionMode: 'read_only',
    })).resolves.toEqual({ ok: true, actionId: 'session.permission_mode.set' });

    expect(calls).toEqual([
      {
        actionId: 'session.permission.respond',
        input: { sessionId: 'session-1', requestId: 'permission-1', decision: 'allow' },
        context: { authority: 'account_automation', defaultSessionId: 'session-1', surface: 'rpc' },
      },
      {
        actionId: 'session.user_action.answer',
        input: { sessionId: 'session-1', requestId: 'user-action-1', decision: 'approve' },
        // The host projects the stamped origin into the Action caller; the surface follows it.
        context: expect.objectContaining({ authority: 'account_automation', defaultSessionId: 'session-1', surface: 'agent',
          actionCaller: sessionActionOrigin.caller, actionRequestId: sessionActionOrigin.requestId }),
      },
      {
        actionId: 'session.permission_mode.set',
        input: { sessionId: 'session-1', permissionMode: 'read_only' },
        context: { authority: 'account_automation', defaultSessionId: 'session-1', surface: 'rpc' },
      },
    ]);
  });

  it('maps action dispatch failures without invoking legacy session-local permission recursively', async () => {
    const { handlers, rpcHandlerManager } = createRpcHarness();
    registerSessionPermissionRpcHandlers({
      rpcHandlerManager,
      actionExecutor: {
        execute: async () => ({
          ok: false,
          errorCode: 'unsupported_action',
          error: 'unsupported_action:session.permission.respond',
        }),
      },
    });

    await expect(handlers.get('session.permission.respond')?.({ sessionId: 'session-1' })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.permission.respond',
    });
  });
});
