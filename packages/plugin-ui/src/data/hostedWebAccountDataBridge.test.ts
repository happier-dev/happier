import { describe, expect, it, vi } from 'vitest';
import { defineAccountCollection } from '@happier-dev/plugin-sdk/collections';

import { createHostedWebPluginUiDataClient } from './hostedWebAccountDataBridge.js';

const taskCollectionDefinition = defineAccountCollection({
  id: 'tasks',
  schemaVersion: 1,
  schema: {
    type: 'object',
    properties: { id: { type: 'string' }, title: { type: 'string' } },
    required: ['id', 'title'],
    additionalProperties: false,
  },
  rowIdField: 'id',
  identityFields: ['id'],
  serverReadable: ['id'],
  indexes: [{ id: 'by-id', fields: [{ field: 'id', direction: 'asc' }] }],
  uiQueries: [],
  relations: [],
});

const firstSnapshot = {
  status: 'ready',
  rows: [{
    context: {
      collection: { pluginId: 'example.tasks', collectionId: 'tasks' },
      rowId: 'task-1',
      revision: 3,
    },
    fields: { status: 'open', title: 'Ship the hosted adapter' },
  }],
  hasMore: true,
} as const;

const secondSnapshot = {
  status: 'ready',
  rows: [{
    context: {
      collection: { pluginId: 'example.tasks', collectionId: 'tasks' },
      rowId: 'task-2',
      revision: 4,
    },
    fields: { status: 'open', title: 'Verify the guest pager' },
  }],
  hasMore: false,
} as const;

type ChangeListener = (change: unknown) => void;
type DisconnectListener = () => void;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    promise,
    resolve: (value: T) => resolve(value),
    reject: (reason?: unknown) => reject(reason),
  };
}

function createTransportHarness(openSnapshots: readonly unknown[] = [firstSnapshot, secondSnapshot]) {
  const changeListeners = new Set<ChangeListener>();
  const disconnectListeners = new Set<DisconnectListener>();
  let openCount = 0;
  let disconnected = false;
  const request = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
    if (disconnected && operation.kind === 'data') {
      return {
        kind: 'error',
        error: {
          code: 'plugin_account_storage_unavailable',
          message: 'Hosted Account Data bridge retired.',
          retryable: true,
        },
      };
    }
    if (operation.kind === 'open') {
      openCount += 1;
      return {
        kind: 'snapshot',
        queryId: `host-query-${openCount}`,
        snapshot: openSnapshots[openCount - 1] ?? secondSnapshot,
      };
    }
    if (operation.kind === 'page') {
      return { kind: 'snapshot', queryId: operation.queryId, snapshot: secondSnapshot };
    }
    if (operation.kind === 'close') {
      return { kind: 'closed', queryId: operation.queryId };
    }
    if (operation.kind === 'data') {
      if (operation.operation === 'collection.identityTag') return { kind: 'data', value: 'exact-host-tag' };
      if (operation.operation === 'collection.get') {
        return { kind: 'data', value: { rowId: 'task-1', revision: 3, value: { id: 'task-1', title: 'One' } } };
      }
      if (operation.operation === 'collection.put') {
        return { kind: 'data', value: { rowId: 'task-1', revision: 4, value: { id: 'task-1', title: 'One' } } };
      }
      if (operation.operation === 'collection.delete') {
        return { kind: 'data', value: { rowId: 'task-1', revision: 5, deleted: true } };
      }
      if (operation.operation === 'collection.query') {
        return { kind: 'data', value: { rows: [], changeCursor: 9 } };
      }
      if (operation.operation === 'collection.batch') {
        return { kind: 'data', value: { status: 'updated', revision: 6, results: [{ rowId: 'task-1', revision: 6, deleted: false }] } };
      }
      if (operation.operation === 'collection.limits') {
        return { kind: 'data', value: { maxBatchRows: 10, maxBatchBytes: 1000, maxRowEncodedBytes: 500, maxAccountRows: 100, maxAccountBytes: 10000, basis: 'deployment' } };
      }
      if (operation.operation === 'collection.measureBatch') {
        return { kind: 'data', value: { overheadEncodedBytes: 20, operationEncodedBytes: [52] } };
      }
      if (operation.operation === 'accountKv.get') return { kind: 'data', value: { version: 2, value: { cursor: 7 } } };
      if (operation.operation === 'accountKv.set') return { kind: 'data', value: { version: 3 } };
      if (operation.operation === 'accountKv.delete') return { kind: 'data', value: { version: 4, deleted: true } };
      if (operation.operation === 'accountKv.list') return { kind: 'data', value: { items: [{ key: 'cursor', version: 4, deleted: true }] } };
      if (operation.operation === 'accountKv.transaction.begin') return { kind: 'data', value: 'transaction_1' };
      if (operation.operation === 'accountKv.transaction.get') return { kind: 'data', value: { version: 4, deleted: true } };
      if (operation.operation === 'accountKv.transaction.set') return { kind: 'data', value: { version: 5 } };
      if (operation.operation === 'accountKv.transaction.commit') return { kind: 'data', value: null };
    }
    throw new Error('Unexpected bridge operation');
  });
  const transport = {
    request,
    subscribe(listener: ChangeListener) {
      changeListeners.add(listener);
      return { dispose: () => { changeListeners.delete(listener); } };
    },
    subscribeDisconnect(listener: DisconnectListener) {
      disconnectListeners.add(listener);
      return { dispose: () => { disconnectListeners.delete(listener); } };
    },
  };
  return {
    transport,
    request,
    emitChange(change: unknown) {
      for (const listener of changeListeners) listener(change);
    },
    disconnect() {
      disconnected = true;
      for (const listener of disconnectListeners) listener();
    },
  };
}

function createClient(harness: ReturnType<typeof createTransportHarness>) {
  return createHostedWebPluginUiDataClient({
    acquireTransport: async () => harness.transport,
  });
}

describe('hosted-web Collection UI-query guest pager', () => {
  it('projects the complete generic Account-data client through the host-owned bridge', async () => {
    const harness = createTransportHarness();
    const client = createClient(harness);
    const collection = client.collection(taskCollectionDefinition);

    await expect(collection.identityTag({ field: 'id', components: ['provider', '1'] })).resolves.toBe('exact-host-tag');
    await expect(collection.get('task-1')).resolves.toMatchObject({ revision: 3 });
    await expect(collection.put({ id: 'task-1', title: 'One' }, { expectedRevision: 3 })).resolves.toMatchObject({ revision: 4 });
    await expect(collection.delete('task-1', { expectedRevision: 4 })).resolves.toMatchObject({ deleted: true });
    await expect(collection.query({ index: 'by-id', order: 'asc' })).resolves.toMatchObject({ changeCursor: 9 });
    await expect(collection.batch([{ kind: 'assert', rowId: 'task-1', expectedRevision: 4 }])).resolves.toMatchObject({ status: 'updated' });
    await expect(collection.limits()).resolves.toMatchObject({ maxBatchRows: 10 });
    await expect(collection.measureBatch([{ kind: 'delete', rowId: 'task-1', expectedRevision: 4 }])).resolves.toEqual({ overheadEncodedBytes: 20, operationEncodedBytes: [52] });

    await expect(client.accountKv.get('cursor')).resolves.toEqual({ version: 2, value: { cursor: 7 } });
    await expect(client.accountKv.set('cursor', { cursor: 8 }, { expectedVersion: 2 })).resolves.toEqual({ version: 3 });
    await expect(client.accountKv.delete('cursor', { expectedVersion: 3 })).resolves.toEqual({ version: 4, deleted: true });
    await expect(client.accountKv.list({ prefix: 'cur' })).resolves.toMatchObject({ items: [{ key: 'cursor', deleted: true }] });
    await expect(client.accountKv.transaction(async (transaction) => {
      const previous = await transaction.get('cursor');
      expect(previous).toEqual({ version: 4, deleted: true });
      return await transaction.set('cursor', { cursor: 9 }, { expectedVersion: 4 });
    })).resolves.toEqual({ version: 5 });

    expect(harness.request.mock.calls.filter(([operation]) => operation.kind === 'data')).toHaveLength(16);
    expect(JSON.stringify(harness.request.mock.calls)).not.toContain('account-a');
  });

  it('preserves typed host conflict and currentness failures at the public hosted boundary', async () => {
    const harness = createTransportHarness();
    harness.request.mockImplementation(async () => ({
      kind: 'error',
      error: { code: 'plugin_collection_conflict', message: 'stale row' },
    }));
    const client = createClient(harness);
    const collection = client.collection(defineAccountCollection({
      id: 'tasks', schemaVersion: 1,
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      rowIdField: 'id', identityFields: ['id'], serverReadable: ['id'], indexes: [], uiQueries: [], relations: [],
    }));

    await expect(collection.put({ id: 'task-1' }, { expectedRevision: 1 })).rejects.toMatchObject({
      code: 'plugin_collection_conflict',
      message: 'stale row',
    });

    harness.request.mockImplementation(async () => ({
      kind: 'error',
      error: { code: 'plugin_account_storage_unavailable', message: 'retired', retryable: true },
    }));
    await expect(client.accountKv.get('cursor')).rejects.toMatchObject({
      code: 'plugin_account_storage_unavailable', retryable: true,
    });
  });
  it('uses only the Data bridge open/page/content-free-wakeup/close contract and never adds guest authority', async () => {
    const harness = createTransportHarness();
    const client = createClient(harness);
    const pager = await client.openCollectionQuery({
      collectionId: 'tasks',
      uiQueryId: 'open',
      parameters: { status: 'open' },
    });

    expect(pager.getSnapshot()).toEqual(firstSnapshot);
    const observed = vi.fn();
    const unsubscribe = pager.subscribe(observed);
    // The bridge carries no rows in an AccountChange event. The guest reopens
    // the Data-owned static query through the same bridge and adopts its safe
    // response only after the host issues a new opaque query id.
    harness.emitChange({ kind: 'change', queryId: 'host-query-1' });
    await vi.waitFor(() => {
      expect(harness.request).toHaveBeenNthCalledWith(2, {
        kind: 'open',
        collectionId: 'tasks',
        uiQueryId: 'open',
        parameters: { status: 'open' },
      }, undefined);
      expect(pager.getSnapshot()).toEqual(secondSnapshot);
      expect(observed).toHaveBeenCalledTimes(1);
      expect(harness.request).toHaveBeenNthCalledWith(3, {
        kind: 'close',
        queryId: 'host-query-1',
      }, undefined);
    });

    await pager.loadMore();
    expect(harness.request).toHaveBeenNthCalledWith(1, {
      kind: 'open',
      collectionId: 'tasks',
      uiQueryId: 'open',
      parameters: { status: 'open' },
    }, undefined);
    expect(harness.request).toHaveBeenNthCalledWith(4, {
      kind: 'page',
      queryId: 'host-query-2',
    }, undefined);
    const serializedCalls = JSON.stringify(harness.request.mock.calls);
    expect(serializedCalls).not.toContain('example.tasks');
    expect(serializedCalls).not.toContain('host-private-cursor');

    const observedBeforeDispose = observed.mock.calls.length;
    pager.dispose();
    expect(harness.request).toHaveBeenLastCalledWith({ kind: 'close', queryId: 'host-query-2' }, undefined);
    harness.emitChange({ kind: 'change', queryId: 'host-query-2' });
    expect(observed).toHaveBeenCalledTimes(observedBeforeDispose);
    unsubscribe();
  });

  it('clears a mounted snapshot on bridge retirement and fails closed for generic Account-data operations', async () => {
    const harness = createTransportHarness();
    const client = createClient(harness);
    const pager = await client.openCollectionQuery({
      collectionId: 'tasks',
      uiQueryId: 'open',
      parameters: { status: 'open' },
    });
    const observed = vi.fn();
    pager.subscribe(observed);

    harness.disconnect();
    expect(pager.getSnapshot()).toEqual({ status: 'unavailable', rows: [], hasMore: false });
    expect(observed).toHaveBeenCalledTimes(1);
    await expect(client.collection(taskCollectionDefinition).get('task-1')).rejects.toMatchObject({
      code: 'plugin_account_storage_unavailable',
    });
    expect(harness.request).toHaveBeenCalledTimes(2);
  });

  it('keeps disconnect terminal when a deferred wakeup replacement rejects', async () => {
    const harness = createTransportHarness();
    const client = createClient(harness);
    const pager = await client.openCollectionQuery({
      collectionId: 'tasks',
      uiQueryId: 'open',
      parameters: { status: 'open' },
    });
    const observed = vi.fn();
    pager.subscribe(observed);
    const replacement = createDeferred<unknown>();
    let replacementRejected = false;
    harness.request.mockImplementationOnce(async (operation) => {
      expect(operation).toMatchObject({ kind: 'open' });
      try {
        return await replacement.promise;
      } catch (error) {
        replacementRejected = true;
        throw error;
      }
    });

    harness.emitChange({ kind: 'change', queryId: 'host-query-1' });
    await vi.waitFor(() => {
      expect(harness.request).toHaveBeenCalledTimes(2);
    });
    harness.disconnect();
    replacement.reject(new Error('replacement transport closed'));
    await vi.waitFor(() => {
      expect(replacementRejected).toBe(true);
    });
    await Promise.resolve();

    expect(pager.getSnapshot()).toEqual({ status: 'unavailable', rows: [], hasMore: false });
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('keeps disconnect terminal when a deferred page rejects', async () => {
    const harness = createTransportHarness();
    const client = createClient(harness);
    const pager = await client.openCollectionQuery({
      collectionId: 'tasks',
      uiQueryId: 'open',
      parameters: { status: 'open' },
    });
    const observed = vi.fn();
    pager.subscribe(observed);
    const page = createDeferred<unknown>();
    harness.request.mockImplementationOnce(async (operation) => {
      expect(operation).toEqual({ kind: 'page', queryId: 'host-query-1' });
      return await page.promise;
    });

    const loading = pager.loadMore();
    await vi.waitFor(() => {
      expect(harness.request).toHaveBeenCalledTimes(2);
    });
    harness.disconnect();
    page.reject(new Error('page transport closed'));
    await loading;

    expect(pager.getSnapshot()).toEqual({ status: 'unavailable', rows: [], hasMore: false });
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('retains the incumbent query and rows when a wakeup replacement returns a typed error snapshot', async () => {
    const harness = createTransportHarness([
      firstSnapshot,
      { status: 'error', rows: [], hasMore: false },
      secondSnapshot,
    ]);
    const client = createClient(harness);
    const pager = await client.openCollectionQuery({
      collectionId: 'tasks',
      uiQueryId: 'open',
      parameters: { status: 'open' },
    });
    const observed = vi.fn();
    pager.subscribe(observed);

    harness.emitChange({ kind: 'change', queryId: 'host-query-1' });
    await vi.waitFor(() => {
      expect(pager.getSnapshot()).toEqual({
        status: 'error',
        rows: firstSnapshot.rows,
        hasMore: true,
      });
      expect(harness.request).not.toHaveBeenCalledWith({ kind: 'close', queryId: 'host-query-1' }, undefined);
      expect(harness.request).toHaveBeenCalledWith({ kind: 'close', queryId: 'host-query-2' }, undefined);
    });

    // The incumbent handle remains live after the failed replacement, so the
    // next content-free wakeup can recover it through the same bridge path.
    harness.emitChange({ kind: 'change', queryId: 'host-query-1' });
    await vi.waitFor(() => {
      expect(pager.getSnapshot()).toEqual(secondSnapshot);
      expect(harness.request).toHaveBeenCalledWith({ kind: 'close', queryId: 'host-query-1' }, undefined);
    });
    expect(observed).toHaveBeenCalledTimes(2);
  });
});
