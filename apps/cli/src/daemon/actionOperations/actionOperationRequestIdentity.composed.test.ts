import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createExternalSessionActionOperationOwner } from '@/session/actions/externalSessions/actionOperationOwner';
import { createActionOperationRpcHandlers, registerActionOperationRpcHandlers } from './actionOperationRpcHandlers';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';

const transport = vi.hoisted(() => vi.fn());
// Machine RPC is the network boundary; both clients' observation owners,
// registration, schemas, runner, receipt stores and durable-domain owner stay real.
vi.mock('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: transport,
}));
// The durable-domain owner still performs its real Account partition and disk
// inventory logic beneath the installed credential adapter.
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => ({
    token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJyZXF1ZXN0ZXIifQ.test', encryption: null,
  }),
}));

import { awaitManualSessionSpawnOperation } from '../../../../ui/sources/sync/domains/session/spawn/manualSessionSpawnOperation';
import { actionOperationStore as clientStore } from '../../../../ui/sources/sync/domains/actionOperations/actionOperationStore';

afterEach(() => { clientStore.reset(); transport.mockReset(); });

describe('manual Session request-identity observation', () => {
  it.each(['click', 'manual:click'])('transfers only the newest %s receipt without reconciling unrelated owners', async requestId => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-operation-demand-'));
    const scope = { accountId: 'requester', machineId: 'guest' };
    const store = createActionOperationStore({ now: () => 10 });
    const create = (operationId: string, actionId: string, requestId: string, accountId = scope.accountId) =>
      store.create({ operationId, actionId, requestId, scope: { ...scope, accountId }, title: 'Operation',
        cancellation: 'unsupported', inputIdentity: '{}' });
    for (let index = 0; index < 2_000; index++) create(`unrelated-${index}`, 'session.spawn_new', `other-${index}`);
    create('other-action', 'session.fork', requestId);
    create('older-attempt', 'session.spawn_new', requestId);
    store.fail('older-attempt', { errorCode: 'previous_attempt', error: 'Previous attempt failed' });
    create('newest-attempt', 'session.spawn_new', requestId);
    const result = { sessionId: 'created-session' };
    store.succeed('newest-attempt', result);
    // A later receipt for another requester must not win request selection.
    create('foreign-attempt', 'session.spawn_new', requestId, 'stranger');
    create('unrelated-domain', 'sessions.external.materialize.start', 'external');
    const unrelatedProjection = store.get(scope, 'unrelated-domain');
    const owner = createExternalSessionActionOperationOwner({ activeServerDir: directory,
      execute: async () => { throw new Error('Observation must not execute an Action'); } });
    const handlers = createActionOperationRpcHandlers({ store,
      runner: createActionOperationRunner({ store, resolveAction: () => null }), owner: () => owner,
      machineId: scope.machineId, resolveAccountId: async () => scope.accountId });
    const rpc = new RpcHandlerManager({ scopePrefix: scope.machineId, encryptionMode: 'plain' });
    registerActionOperationRpcHandlers(rpc, handlers);
    let transferredReceipts = 0;
    transport.mockImplementation(async (input: { machineId: string; serverId: string; accountId: string; method: string; payload: unknown }) => {
      expect(input).toMatchObject({ ...scope, serverId: 'home' });
      const response = await rpc.invokeLocal(input.method, input.payload);
      if (input.method === ACTION_OPERATION_RPC_METHODS_V2.list) {
        transferredReceipts += ActionOperationListV1ResponseSchema.parse(response).items.length;
      }
      return response;
    });
    try {
      const operation = await awaitManualSessionSpawnOperation({ serverId: 'home', accountId: scope.accountId },
        'click', new AbortController().signal, scope.machineId);
      expect(transferredReceipts).toBe(1);
      expect(operation).toMatchObject({ operationId: 'newest-attempt', requestId, state: 'succeeded', result });
      expect(store.get(scope, 'unrelated-domain')).toBe(unrelatedProjection);
      expect([...clientStore.getSnapshot().operationsByKey.values()].map(row => row.snapshot.operationId))
        .toEqual(['newest-attempt']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
