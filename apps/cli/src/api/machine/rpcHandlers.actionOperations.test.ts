import { describe, expect, it, vi } from 'vitest';

import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions';

import { registerMachineRpcHandlers } from './rpcHandlers';

type Handler = (data: unknown) => Promise<unknown>;

function createRpcHandlerManager() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method: string, handler: Handler) {
      handlers.set(method, handler);
    },
  };
}

describe('machine RPC Action operations', () => {
  it('mounts every versioned Action operation method through the canonical machine registrar', () => {
    const manager = createRpcHandlerManager();
    const handlers = {
      list: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
    };

    registerMachineRpcHandlers({
      rpcHandlerManager: manager as never,
      handlers: {
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as never,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
      deps: {
        actionOperations: {
          handlers,
          observeExecution: async ({ execute }) => await execute({
            signal: new AbortController().signal,
            operationProgress: { update: () => undefined },
            operationOwnerUpdate: { update: () => undefined },
          }),
        },
      },
    });

    expect([...manager.handlers.keys()]).toEqual(expect.arrayContaining(
      Object.values(ACTION_OPERATION_RPC_METHODS_V1),
    ));
    expect(manager.handlers.has('actionOperation.start.v1')).toBe(false);
    expect(manager.handlers.has('actionOperation.wait.v1')).toBe(false);
    expect(manager.handlers.get(ACTION_OPERATION_RPC_METHODS_V1.list)).toBe(handlers.list);
    expect(manager.handlers.get(ACTION_OPERATION_RPC_METHODS_V1.get)).toBe(handlers.get);
    expect(manager.handlers.get(ACTION_OPERATION_RPC_METHODS_V1.cancel)).toBe(handlers.cancel);
  });
});
