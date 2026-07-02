import { describe, expect, it, vi } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';

import { registerSessionRollbackRpcHandler } from './sessionRollbackRpc';

function createRegistrar() {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const registrar: RpcHandlerRegistrar = {
    registerHandler: <TRequest, TResponse>(
      method: string,
      handler: (data: TRequest) => TResponse | Promise<TResponse>,
    ) => {
      handlers.set(method, async (input: unknown) => handler(input as TRequest));
    },
  };
  return {
    handlers,
    registrar,
  };
}

describe('registerSessionRollbackRpcHandler', () => {
  it('routes product checkpoint and restore RPCs through the active runtime facet', async () => {
    const { handlers, registrar } = createRegistrar();
    const sessionCheckpoint = vi.fn(async () => ({
      ok: true as const,
      status: 'succeeded' as const,
      source: 'happier_scm' as const,
      receipts: [],
    }));
    const sessionRestore = vi.fn(async () => ({
      ok: true as const,
      status: 'succeeded' as const,
      source: 'happier_scm' as const,
      restoredScopes: ['workspace' as const],
      receipts: [],
    }));

    registerSessionRollbackRpcHandler(registrar, () => ({
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' as const } })),
      sessionCheckpoint,
      sessionRestore,
    }));

    const checkpointRequest = {
      v: 1,
      sessionId: 'session-1',
      scopes: ['workspace'],
      candidate: {
        source: 'happier_scm',
      },
    };
    const restoreRequest = {
      v: 1,
      sessionId: 'session-1',
      scopes: ['workspace'],
      candidate: {
        source: 'happier_scm',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      },
      confirmation: { sourceChoiceConfirmed: true },
    };

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_CHECKPOINT)?.(checkpointRequest)).resolves.toMatchObject({ ok: true });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_RESTORE)?.(restoreRequest)).resolves.toMatchObject({ ok: true });
    expect(sessionCheckpoint).toHaveBeenCalledWith({ ...checkpointRequest, timing: 'idle' });
    expect(sessionRestore).toHaveBeenCalledWith(restoreRequest);
  });

  it('fails closed when restore is unavailable on the active runtime facet', async () => {
    const { handlers, registrar } = createRegistrar();

    registerSessionRollbackRpcHandler(registrar, () => ({
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' as const } })),
    }));

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_RESTORE)?.({
      v: 1,
      sessionId: 'session-1',
      scopes: ['workspace'],
      candidate: {
        source: 'happier_scm',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      },
      confirmation: { sourceChoiceConfirmed: true },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'restore_target_missing',
      error: 'RPC_METHOD_NOT_AVAILABLE',
    });
  });
});
