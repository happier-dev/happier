import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';

vi.mock('./prepareSessionCreationTarget', () => ({
  prepareSessionCreationTarget: vi.fn(),
}));

import { registerSessionCreationTargetPreparationRpc } from './registerSessionCreationTargetPreparationRpc';

describe('registerSessionCreationTargetPreparationRpc', () => {
  it('binds the narrow preparation contract to the target daemon and forwards cancellation', async () => {
    const registered = new Map<string, RpcHandler>();
    const rpcHandlerManager: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        registered.set(method, handler);
      },
    };
    const prepare = vi.fn(async () => ({
      ok: true as const,
      directory: '/repo',
      directoryCreationRequired: false,
      checkout: null,
    }));
    registerSessionCreationTargetPreparationRpc({
      rpcHandlerManager,
      prepare,
    });
    const signal = new AbortController().signal;

    await expect(registered.get(RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE)?.(
      { directory: '/repo' },
      { signal },
    )).resolves.toEqual({
      ok: true,
      directory: '/repo',
      directoryCreationRequired: false,
      checkout: null,
    });
    expect(prepare).toHaveBeenCalledWith({
      request: { directory: '/repo' },
      signal,
    });
  });
});
