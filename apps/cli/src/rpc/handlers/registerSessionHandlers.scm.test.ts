import { describe, expect, it } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerSessionHandlers } from './registerSessionHandlers';

describe('registerSessionHandlers (SCM)', () => {
  it('does not register SCM RPCs (SCM must be machine-scoped)', () => {
    const handlers = new Map<string, RpcHandler>();
    const mgr: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };

    registerSessionHandlers(mgr, process.cwd());

    expect(handlers.has(RPC_METHODS.SCM_STATUS_SNAPSHOT)).toBe(false);
    expect(handlers.has(RPC_METHODS.SCM_DIFF_FILE)).toBe(false);
    expect(handlers.has(RPC_METHODS.SCM_DIFF_COMMIT)).toBe(false);
    expect(handlers.has(RPC_METHODS.SCM_LOG_LIST)).toBe(false);
  });
});
