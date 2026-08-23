import { describe, expect, it, vi } from 'vitest';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol';

import { registerActionOperationRpcHandlers } from './actionOperationRpcHandlers';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';

describe('actionOperationRpcHandlers', () => {
  it('registers observation/control only and stamps authenticated scope', async () => {
    const handlers = new Map<string, (request: unknown) => Promise<unknown>>();
    const store = createActionOperationStore();
    store.create({
      version: 1, operationId: 'operation-rpc', requestId: 'request-1', revision: 1,
      actionId: 'session.spawn_new', state: 'accepted',
      scope: { accountId: 'authenticated-account', machineId: 'registered-machine' },
      title: 'Create session', createdAt: 1, cancellation: 'unsupported',
    });
    const runner = createActionOperationRunner({ store });
    const getScope = vi.fn(async () => ({ accountId: 'authenticated-account', machineId: 'registered-machine' }));

    registerActionOperationRpcHandlers({
      rpcHandlerManager: { registerHandler: (method, handler) => handlers.set(method, handler) },
      runner,
      store,
      getScope,
    });

    expect([...handlers.keys()]).toEqual([
      ACTION_OPERATION_RPC_METHODS_V1.list,
      ACTION_OPERATION_RPC_METHODS_V1.get,
      ACTION_OPERATION_RPC_METHODS_V1.cancel,
    ]);
    await expect(handlers.get(ACTION_OPERATION_RPC_METHODS_V1.list)?.({})).resolves.toMatchObject({
      items: [expect.objectContaining({ operationId: 'operation-rpc' })],
    });
    await expect(handlers.get(ACTION_OPERATION_RPC_METHODS_V1.get)?.({ operationId: 'operation-rpc' }))
      .resolves.toMatchObject({ kind: 'found' });
    await expect(handlers.get(ACTION_OPERATION_RPC_METHODS_V1.cancel)?.({ operationId: 'operation-rpc' }))
      .resolves.toEqual({ kind: 'unsupported' });
    expect(getScope).toHaveBeenCalledTimes(3);
  });
});
