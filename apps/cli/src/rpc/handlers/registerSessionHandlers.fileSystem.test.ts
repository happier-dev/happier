import { describe, expect, it } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerSessionHandlers } from './registerSessionHandlers';

describe('registerSessionHandlers (file system)', () => {
  it('does not register filesystem RPCs (filesystem must be machine-scoped)', () => {
    const handlers = new Map<string, RpcHandler>();
    const mgr: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };

    registerSessionHandlers(mgr, process.cwd());

    expect(handlers.has(RPC_METHODS.READ_FILE)).toBe(false);
    expect(handlers.has(RPC_METHODS.WRITE_FILE)).toBe(false);
    expect(handlers.has(RPC_METHODS.CREATE_DIRECTORY)).toBe(false);
    expect(handlers.has(RPC_METHODS.LIST_DIRECTORY)).toBe(false);
    expect(handlers.has(RPC_METHODS.GET_DIRECTORY_TREE)).toBe(false);
  });
});
