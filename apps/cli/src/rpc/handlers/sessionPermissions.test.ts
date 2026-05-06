import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { registerSessionPermissionRpcHandlers } from './sessionPermissions';

function createRpcHarness() {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  return {
    handlers,
    rpcHandlerManager: {
      registerHandler(method: string, handler: (input: unknown) => Promise<unknown>) {
        handlers.set(method, handler);
      },
    },
  };
}

describe('session permission RPC handlers', () => {
  it('does not own a static RPC binding table', async () => {
    const source = await readFile(new URL('./sessionPermissions.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('SESSION_PERMISSION_RPC_BINDINGS');
  });

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
    await expect(handlers.get('session.user_action.answer')?.({
      sessionId: 'session-1',
      requestId: 'user-action-1',
      decision: 'approve',
    })).resolves.toEqual({ ok: true, actionId: 'session.user_action.answer' });
    await expect(handlers.get('session.permission_mode.set')?.({
      sessionId: 'session-1',
      permissionMode: 'read_only',
    })).resolves.toEqual({ ok: true, actionId: 'session.permission_mode.set' });

    expect(calls).toEqual([
      {
        actionId: 'session.permission.respond',
        input: { sessionId: 'session-1', requestId: 'permission-1', decision: 'allow' },
        context: { defaultSessionId: 'session-1', surface: 'rpc' },
      },
      {
        actionId: 'session.user_action.answer',
        input: { sessionId: 'session-1', requestId: 'user-action-1', decision: 'approve' },
        context: { defaultSessionId: 'session-1', surface: 'rpc' },
      },
      {
        actionId: 'session.permission_mode.set',
        input: { sessionId: 'session-1', permissionMode: 'read_only' },
        context: { defaultSessionId: 'session-1', surface: 'rpc' },
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
