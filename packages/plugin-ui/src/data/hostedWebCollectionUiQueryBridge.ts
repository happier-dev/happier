import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import {
  PluginHostedWebCollectionUiQueryBridgeOperationV1Schema,
  PluginHostedWebCollectionUiQueryBridgeResponseV1Schema,
  type PluginHostedWebCollectionUiQueryBridgeChangeV1,
  type PluginHostedWebCollectionUiQueryBridgeOperationV1,
  type PluginHostedWebCollectionUiQueryBridgeResponseV1,
} from '@happier-dev/plugin-sdk/ui';

import type {
  PluginUiAccountCollectionForDefinition,
  PluginUiCollectionQueryInput,
  PluginUiCollectionQueryPager,
  PluginUiCollectionQuerySnapshot,
  PluginUiDataClient,
} from './types.js';

type HostedWebCollectionUiQueryTransport = Readonly<{
  request(
    operation: PluginHostedWebCollectionUiQueryBridgeOperationV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginHostedWebCollectionUiQueryBridgeResponseV1>;
  subscribe(listener: (change: PluginHostedWebCollectionUiQueryBridgeChangeV1) => void): Readonly<{
    dispose(): void;
  }>;
  subscribeDisconnect(listener: () => void): Readonly<{
    dispose(): void;
  }>;
}>;

type HostedWebCollectionUiQueryTransportFactory = (
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<HostedWebCollectionUiQueryTransport>;

function unavailableError(): PluginError {
  return new PluginError({
    code: 'plugin_collection_ui_query_unavailable',
    message: 'Plugin Account Collection operations are unavailable in this hosted UI surface.',
  });
}

function toSnapshot(
  snapshot: Extract<PluginHostedWebCollectionUiQueryBridgeResponseV1, { kind: 'snapshot' }>['snapshot'],
): PluginUiCollectionQuerySnapshot {
  return Object.freeze({
    status: snapshot.status,
    rows: Object.freeze(snapshot.rows.map((row) => Object.freeze({
      context: Object.freeze({
        collection: Object.freeze({ ...row.context.collection }),
        rowId: row.context.rowId,
        revision: row.context.revision,
      }),
      fields: Object.freeze({ ...row.fields }),
    }))),
    hasMore: snapshot.hasMore,
    ...(snapshot.status === 'error' && snapshot.error !== undefined ? { error: snapshot.error } : {}),
  });
}

function errorSnapshot(
  previous: PluginUiCollectionQuerySnapshot,
  error?: PluginUiCollectionQuerySnapshot['error'],
): PluginUiCollectionQuerySnapshot {
  return Object.freeze({
    status: 'error',
    rows: previous.rows,
    hasMore: previous.hasMore,
    ...(error === undefined ? {} : { error }),
  });
}

function unavailableSnapshot(): PluginUiCollectionQuerySnapshot {
  return Object.freeze({ status: 'unavailable', rows: Object.freeze([]), hasMore: false });
}

export function createUnavailableHostedWebPluginUiDataClient(): PluginUiDataClient {
  const unavailable = async (): Promise<never> => {
    throw unavailableError();
  };
  const collection = <TDefinition extends PluginAccountCollectionDefinition>(
    _definition: TDefinition,
  ): PluginUiAccountCollectionForDefinition<TDefinition> => Object.freeze({
    get: unavailable,
    put: unavailable,
    delete: unavailable,
    query: unavailable,
    batch: unavailable,
  });

  return Object.freeze({ collection, openCollectionQuery: unavailable });
}

function parseSnapshotResponse(value: unknown): Extract<
  PluginHostedWebCollectionUiQueryBridgeResponseV1,
  { kind: 'snapshot' }
> {
  const parsed = PluginHostedWebCollectionUiQueryBridgeResponseV1Schema.parse(value);
  if (parsed.kind !== 'snapshot') {
    throw new Error('Hosted Collection UI-query bridge closed a query unexpectedly.');
  }
  return parsed;
}

/**
 * Adapts the Data-owned hosted bridge to the public `PluginUiDataClient` pager
 * shape. The existing hosted bootstrap owns transport identity, readiness,
 * currentness, cancellation, and disconnection; this adapter owns only its
 * local presentation snapshot and opaque host-issued query handle.
 */
export function createHostedWebPluginUiDataClient(input: Readonly<{
  acquireTransport: HostedWebCollectionUiQueryTransportFactory;
}>): PluginUiDataClient {
  const { collection } = createUnavailableHostedWebPluginUiDataClient();

  const openCollectionQuery = async (
    query: PluginUiCollectionQueryInput,
  ): Promise<PluginUiCollectionQueryPager> => {
    const operation = PluginHostedWebCollectionUiQueryBridgeOperationV1Schema.parse({
      kind: 'open',
      collectionId: query.collectionId,
      uiQueryId: query.uiQueryId,
      parameters: query.parameters,
    });
    const transport = await input.acquireTransport(
      query.signal === undefined ? undefined : { signal: query.signal },
    );
    let disposed = false;
    let disconnected = false;
    let queryId: string | null = null;
    let snapshot: PluginUiCollectionQuerySnapshot = Object.freeze({
      status: 'loading',
      rows: Object.freeze([]),
      hasMore: false,
    });
    let reopenInFlight: Promise<void> | null = null;
    const listeners = new Set<() => void>();
    let changeSubscription: Readonly<{ dispose(): void }> | null = null;
    let disconnectSubscription: Readonly<{ dispose(): void }> | null = null;

    const publish = (next: PluginUiCollectionQuerySnapshot): void => {
      if (disposed) return;
      snapshot = next;
      for (const listener of listeners) listener();
    };
    const closeRemote = (id: string): void => {
      void transport.request({ kind: 'close', queryId: id }, undefined).catch(() => undefined);
    };
    const requestOpen = async (): Promise<void> => {
      if (disconnected) return;
      try {
        const opened = parseSnapshotResponse(await transport.request(operation, undefined));
        if (disposed || disconnected) {
          closeRemote(opened.queryId);
          return;
        }
        const replacement = toSnapshot(opened.snapshot);
        if (replacement.status === 'error') {
          // A typed replacement error leaves its provisional host query active.
          // Close that handle without touching the incumbent, then retain its
          // rows for the next content-free wakeup through the same Data path.
          if (opened.queryId !== queryId) closeRemote(opened.queryId);
          publish(errorSnapshot(snapshot, replacement.error));
          return;
        }
        const previousQueryId = queryId;
        queryId = opened.queryId;
        publish(replacement);
        if (previousQueryId && previousQueryId !== opened.queryId) closeRemote(previousQueryId);
      } catch {
        if (disposed || disconnected) return;
        publish(errorSnapshot(snapshot));
      }
    };
    const reopen = (): Promise<void> => {
      if (reopenInFlight) return reopenInFlight;
      reopenInFlight = requestOpen().finally(() => { reopenInFlight = null; });
      return reopenInFlight;
    };
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      changeSubscription?.dispose();
      changeSubscription = null;
      disconnectSubscription?.dispose();
      disconnectSubscription = null;
      query.signal?.removeEventListener('abort', dispose);
      if (queryId) closeRemote(queryId);
      listeners.clear();
    };

    try {
      const opened = parseSnapshotResponse(await transport.request(
        operation,
        query.signal === undefined ? undefined : { signal: query.signal },
      ));
      if (query.signal?.aborted) {
        closeRemote(opened.queryId);
        throw unavailableError();
      }
      queryId = opened.queryId;
      snapshot = toSnapshot(opened.snapshot);
      changeSubscription = transport.subscribe((change) => {
        if (disposed || change.queryId !== queryId) return;
        // Data wakeups are content-free; reopening is the only way to receive
        // a new safe projection, and rotates the opaque host-side handle.
        void reopen();
      });
      disconnectSubscription = transport.subscribeDisconnect(() => {
        disconnected = true;
        publish(unavailableSnapshot());
      });
      query.signal?.addEventListener('abort', dispose, { once: true });
    } catch (error) {
      dispose();
      throw error;
    }

    return Object.freeze({
      getSnapshot: () => snapshot,
      subscribe(listener) {
        if (disposed) return () => {};
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      refresh: async () => { await reopen(); },
      loadMore: async () => {
        if (disposed || disconnected || !queryId) return;
        const pendingReopen = reopenInFlight;
        if (pendingReopen) await pendingReopen;
        if (disposed || disconnected || !queryId) return;
        try {
          const paged = parseSnapshotResponse(await transport.request({
            kind: 'page',
            queryId,
          }, undefined));
          if (disposed || disconnected || paged.queryId !== queryId) return;
          publish(toSnapshot(paged.snapshot));
        } catch {
          if (disposed || disconnected) return;
          publish(errorSnapshot(snapshot));
        }
      },
      dispose,
    });
  };

  return Object.freeze({ collection, openCollectionQuery });
}
