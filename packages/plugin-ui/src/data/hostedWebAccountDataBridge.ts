import { PluginError, projectPluginAccountCollectionDeclaration, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import type { AccountKvEntry } from '@happier-dev/plugin-sdk/storage';
import {
  PluginHostedWebAccountDataBridgeOperationV1Schema,
  PluginHostedWebAccountDataBridgeResponseV1Schema,
  type PluginHostedWebAccountDataBridgeChangeV1,
  type PluginHostedWebAccountDataBridgeOperationV1,
  type PluginHostedWebAccountDataBridgeResponseV1,
} from '@happier-dev/plugin-sdk/ui';

import type {
  PluginUiAccountCollectionForDefinition,
  PluginUiCollectionQueryInput,
  PluginUiCollectionQueryPager,
  PluginUiCollectionQuerySnapshot,
  PluginUiDataClient,
} from './types.js';

type HostedWebAccountDataTransport = Readonly<{
  request(
    operation: PluginHostedWebAccountDataBridgeOperationV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginHostedWebAccountDataBridgeResponseV1>;
  subscribe(listener: (change: PluginHostedWebAccountDataBridgeChangeV1) => void): Readonly<{
    dispose(): void;
  }>;
  subscribeDisconnect(listener: () => void): Readonly<{
    dispose(): void;
  }>;
}>;

type HostedWebAccountDataTransportFactory = (
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<HostedWebAccountDataTransport>;

function unavailableError(): PluginError {
  return new PluginError({
    code: 'plugin_collection_ui_query_unavailable',
    message: 'Plugin Account Collection operations are unavailable in this hosted UI surface.',
  });
}

function toSnapshot(
  snapshot: Extract<PluginHostedWebAccountDataBridgeResponseV1, { kind: 'snapshot' }>['snapshot'],
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

function parseSnapshotResponse(value: unknown): Extract<
  PluginHostedWebAccountDataBridgeResponseV1,
  { kind: 'snapshot' }
> {
  const parsed = PluginHostedWebAccountDataBridgeResponseV1Schema.parse(value);
  if (parsed.kind !== 'snapshot') {
    throw new Error('Hosted Collection UI-query bridge closed a query unexpectedly.');
  }
  return parsed;
}

function optionsWithoutSignal<TOptions extends Readonly<Record<string, unknown>>>(
  options: TOptions | undefined,
): Readonly<Record<string, JsonValue>> {
  if (!options) return Object.freeze({});
  const { signal: _signal, ...rest } = options;
  return Object.freeze(rest as Record<string, JsonValue>);
}

/**
 * Adapts the Data-owned hosted bridge to the public `PluginUiDataClient`.
 * The existing hosted bootstrap owns transport identity, readiness,
 * currentness, cancellation, and disconnection. The mounted host retains every
 * Account-data decision; this guest owns only method-shape projection plus its
 * local query presentation snapshot and opaque host-issued handles.
 */
export function createHostedWebPluginUiDataClient(input: Readonly<{
  acquireTransport: HostedWebAccountDataTransportFactory;
}>): PluginUiDataClient {
  const requestData = async <T>(
    operation: Extract<PluginHostedWebAccountDataBridgeOperationV1, { kind: 'data' }>['operation'],
    args: readonly JsonValue[],
    options?: Readonly<{ signal?: AbortSignal; definition?: Readonly<Record<string, unknown>> }>,
  ): Promise<T> => {
    const transport = await input.acquireTransport(
      options?.signal === undefined ? undefined : { signal: options.signal },
    );
    const request = PluginHostedWebAccountDataBridgeOperationV1Schema.parse({
      kind: 'data',
      operation,
      ...(options?.definition === undefined ? {} : { definition: options.definition }),
      arguments: args,
    });
    const response = PluginHostedWebAccountDataBridgeResponseV1Schema.parse(
      await transport.request(
        request,
        options?.signal === undefined ? undefined : { signal: options.signal },
      ),
    );
    if (response.kind === 'error') throw new PluginError(response.error);
    if (response.kind !== 'data') {
      throw new PluginError({
        code: 'plugin_collection_protocol_invalid',
        message: 'Hosted Account Data bridge returned an unexpected response.',
      });
    }
    return response.value as T;
  };

  const collection = <TDefinition extends PluginAccountCollectionDefinition>(
    definition: TDefinition,
  ): PluginUiAccountCollectionForDefinition<TDefinition> => {
    const declaration = projectPluginAccountCollectionDeclaration(definition.id, definition);
    const collectionOptions = (signal?: AbortSignal) => ({
      definition: declaration,
      ...(signal === undefined ? {} : { signal }),
    });
    return Object.freeze({
      identityTag: async (request, options) => await requestData(
        'collection.identityTag',
        [request as unknown as JsonValue],
        collectionOptions(options?.signal),
      ),
      get: async (rowId, options) => await requestData(
        'collection.get',
        [rowId],
        collectionOptions(options?.signal),
      ),
      put: async (value, options) => await requestData(
        'collection.put',
        [value, optionsWithoutSignal(options) as JsonValue],
        collectionOptions(options.signal),
      ),
      delete: async (rowId, options) => await requestData(
        'collection.delete',
        [rowId, optionsWithoutSignal(options) as JsonValue],
        collectionOptions(options.signal),
      ),
      query: async (request, options) => await requestData(
        'collection.query',
        [request as unknown as JsonValue],
        collectionOptions(options?.signal),
      ),
      batch: async (operations, options) => await requestData(
        'collection.batch',
        [operations as unknown as JsonValue],
        collectionOptions(options?.signal),
      ),
      limits: async (options) => await requestData(
        'collection.limits',
        [],
        collectionOptions(options?.signal),
      ),
      measureBatch: async (operations, options) => await requestData(
        'collection.measureBatch',
        [operations as unknown as JsonValue],
        collectionOptions(options?.signal),
      ),
    });
  };

  const accountKvMethods: PluginUiDataClient['accountKv'] = {
    get: async (key, options) => await requestData('accountKv.get', [key], options),
    set: async (key, value, options) => await requestData(
      'accountKv.set',
      [key, value, optionsWithoutSignal(options) as JsonValue],
      options,
    ),
    delete: async (key, options) => await requestData(
      'accountKv.delete',
      [key, optionsWithoutSignal(options) as JsonValue],
      options,
    ),
    list: async (options = {}) => await requestData(
      'accountKv.list',
      [optionsWithoutSignal(options) as JsonValue],
      options,
    ),
    transaction: async (operation, options) => {
      const transactionId = await requestData<string>(
        'accountKv.transaction.begin',
        [],
        options,
      );
      const transaction = Object.freeze({
        get: async <TValue extends JsonValue = JsonValue>(key: string): Promise<AccountKvEntry<TValue> | null> => (
          await requestData<AccountKvEntry<TValue> | null>(
            'accountKv.transaction.get',
            [transactionId, key],
            options,
          )
        ),
        set: async (key: string, value: JsonValue, setOptions: Readonly<{ expectedVersion: number | 'absent' }>) => await requestData(
          'accountKv.transaction.set',
          [transactionId, key, { value, expectedVersion: setOptions.expectedVersion }],
          options,
        ) as Awaited<ReturnType<PluginUiDataClient['accountKv']['set']>>,
        delete: async (key: string, deleteOptions: Readonly<{ expectedVersion: number }>) => await requestData(
          'accountKv.transaction.delete',
          [transactionId, key, { expectedVersion: deleteOptions.expectedVersion }],
          options,
        ) as Awaited<ReturnType<PluginUiDataClient['accountKv']['delete']>>,
      });
      try {
        const result = await operation(transaction);
        await requestData('accountKv.transaction.commit', [transactionId], options);
        return result;
      } catch (error) {
        await requestData('accountKv.transaction.rollback', [transactionId]).catch(() => undefined);
        throw error;
      }
    },
  };
  const accountKv = Object.freeze(accountKvMethods);

  const openCollectionQuery = async (
    query: PluginUiCollectionQueryInput,
  ): Promise<PluginUiCollectionQueryPager> => {
    const operation = PluginHostedWebAccountDataBridgeOperationV1Schema.parse({
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

  return Object.freeze({ collection, openCollectionQuery, accountKv });
}
