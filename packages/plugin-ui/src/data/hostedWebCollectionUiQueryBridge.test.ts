import { describe, expect, it, vi } from 'vitest';

import { createHostedWebPluginUiDataClient } from './hostedWebCollectionUiQueryBridge.js';

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
  const request = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
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

  it('clears a mounted snapshot on bridge retirement and fails closed for generic Collection operations', async () => {
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
    await expect(client.collection({ id: 'tasks' }).get('task-1')).rejects.toMatchObject({
      code: 'plugin_collection_ui_query_unavailable',
    });
    await expect(client.accountSettings.snapshot()).rejects.toMatchObject({
      code: 'plugin_settings_persistence_unavailable',
    });
    expect(harness.request).toHaveBeenCalledTimes(1);
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
