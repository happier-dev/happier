import { describe, expect, it, vi } from 'vitest';

import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions';
import { createActionOperationRpcHandlers, registerActionOperationRpcHandlers } from './actionOperationRpcHandlers';
import { createActionOperationStore } from './actionOperationStore';

describe('action operation observation RPC handlers', () => {
  it('registers observation and cancellation only, with no execution ingress', () => {
    const registered = new Map<string, unknown>();
    const handlers = {
      list: vi.fn(), get: vi.fn(), cancel: vi.fn(),
    };
    registerActionOperationRpcHandlers({
      registerHandler: (method, handler) => registered.set(method, handler),
    }, handlers);
    expect([...registered.keys()]).toEqual(Object.values(ACTION_OPERATION_RPC_METHODS_V1));
    expect(registered.has('actionOperation.start.v1')).toBe(false);
    expect(registered.has('actionOperation.wait.v1')).toBe(false);
  });

  it('stamps query scope at the daemon', async () => {
    const store = createActionOperationStore();
    store.create({
      operationId: 'operation-1', actionId: 'session.fork', title: 'Fork',
      scope: { accountId: 'account-1', machineId: 'machine-1' }, cancellation: 'unsupported',
    });
    const handlers = createActionOperationRpcHandlers({
      store,
      runner: { cancel: () => ({ kind: 'unsupported' }) },
      machineId: 'machine-1',
      resolveAccountId: async () => 'account-1',
    });
    await expect(handlers.get({ operationId: 'operation-1' })).resolves.toMatchObject({
      kind: 'found', operation: { operationId: 'operation-1' },
    });
  });
});
