import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  PluginCollectionUiQueryErrorV1,
  PluginCollectionUiQueryRequestV1,
} from '@happier-dev/plugin-sdk/collections';

import { usePluginUiDataClient, usePluginUiDataClientOrNull } from './context.js';
import type {
  PluginUiAccountKv,
  PluginUiAccountSettings,
  PluginUiCollectionQueryPager,
  PluginUiCollectionQuerySnapshot,
} from './types.js';

export { usePluginUiDataClient, usePluginUiDataClientOrNull } from './context.js';
export type {
  PluginUiAccountCollectionForDefinition,
  PluginUiAccountKv,
  PluginUiAccountSettings,
  PluginUiCollectionQueryInput,
  PluginUiCollectionQueryPager,
  PluginUiCollectionQuerySnapshot,
  PluginUiDataClient,
} from './types.js';

/**
 * The mounted surface's own Account KV scope.
 *
 * Account KV is the small, Account-portable store a plugin uses for its own
 * non-declarative state. Reading it from a surface needs no daemon: this is the
 * same Account row the plugin's daemon side writes, reached through the same
 * Protocol owner.
 */
export function usePluginAccountKv(): PluginUiAccountKv {
  return usePluginUiDataClient().accountKv;
}

/**
 * The mounted surface's own Account Settings scope.
 *
 * Reading or writing it needs no daemon: this is the one Account Settings
 * record the plugin's daemon side reads and writes, reached through the same
 * declared fields, the same schema admission and the same revision CAS.
 *
 * `null` is the truthful answer when this mount has no Account Data client at
 * all — the Account is not reachable from here, so durable controls must be
 * disabled rather than silently doing nothing.
 */
export function usePluginAccountSettings(): PluginUiAccountSettings | null {
  return usePluginUiDataClientOrNull()?.accountSettings ?? null;
}

export type PluginUiCollectionQueryFailure =
  | PluginCollectionUiQueryErrorV1
  | Error;

export type PluginUiCollectionQueryResult = Readonly<{
  rows: PluginUiCollectionQuerySnapshot['rows'];
  hasMore: boolean;
  status: PluginUiCollectionQuerySnapshot['status'];
  error?: PluginUiCollectionQueryFailure;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
}>;

type QueryOpenState = Readonly<{
  client: ReturnType<typeof usePluginUiDataClientOrNull>;
  key: string;
  pager: PluginUiCollectionQueryPager | null;
  error: Error | null;
}>;

const EMPTY_QUERY_SNAPSHOT: PluginUiCollectionQuerySnapshot = Object.freeze({
  rows: Object.freeze([]),
  hasMore: false,
  status: 'idle',
});

const UNAVAILABLE_QUERY_SNAPSHOT: PluginUiCollectionQuerySnapshot = Object.freeze({
  rows: Object.freeze([]),
  hasMore: false,
  status: 'unavailable',
});

const EMPTY_QUERY_OPEN_STATE: QueryOpenState = Object.freeze({
  client: null,
  key: '',
  pager: null,
  error: null,
});

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error('Plugin UI Data query could not be opened.');
}

function queryKey(
  collectionId: PluginCollectionUiQueryRequestV1['collectionId'],
  uiQueryId: PluginCollectionUiQueryRequestV1['uiQueryId'],
  parameters: PluginCollectionUiQueryRequestV1['parameters'],
): string {
  return JSON.stringify([
    collectionId,
    uiQueryId,
    Object.entries(parameters)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  ]);
}

/**
 * Presentation/lifecycle adapter over the host's one Data-owned UI-query
 * pager. The pager retains query validation, cursor continuation, Account
 * currentness, AccountChange wakeups, and last-known-good rows.
 */
export function usePluginCollectionQuery(
  collectionId: PluginCollectionUiQueryRequestV1['collectionId'],
  uiQueryId: PluginCollectionUiQueryRequestV1['uiQueryId'],
  parameters: PluginCollectionUiQueryRequestV1['parameters'] = {},
): PluginUiCollectionQueryResult {
  const client = usePluginUiDataClientOrNull();
  const [attempt, setAttempt] = useState(0);
  const [openState, setOpenState] = useState<QueryOpenState>(EMPTY_QUERY_OPEN_STATE);
  const key = useMemo(
    () => queryKey(collectionId, uiQueryId, parameters),
    [collectionId, parameters, uiQueryId],
  );
  // Equivalent parameter objects deliberately retain the existing Data pager.
  // The key is the complete author-visible query identity; cursor/currentness
  // remain private to the Data owner.
  const queryInput = useMemo(
    () => Object.freeze({ collectionId, uiQueryId, parameters }),
    [key],
  );

  useEffect(() => {
    let retired = false;
    let pager: PluginUiCollectionQueryPager | null = null;
    const controller = new AbortController();
    setOpenState(Object.freeze({
      client,
      key,
      pager: null,
      error: null,
    }));

    if (client === null) {
      return () => { controller.abort(); };
    }

    void client.openCollectionQuery({
      ...queryInput,
      signal: controller.signal,
    }).then(
      (openedPager) => {
        pager = openedPager;
        if (retired || controller.signal.aborted) {
          openedPager.dispose();
          return;
        }
        setOpenState(Object.freeze({
          client,
          key,
          pager: openedPager,
          error: null,
        }));
        if (openedPager.getSnapshot().status === 'idle') {
          void openedPager.refresh().catch(() => undefined);
        }
      },
      (error: unknown) => {
        if (retired || controller.signal.aborted) return;
        setOpenState(Object.freeze({
          client,
          key,
          pager: null,
          error: toError(error),
        }));
      },
    );

    return () => {
      retired = true;
      controller.abort();
      pager?.dispose();
      pager = null;
    };
  }, [attempt, client, key, queryInput]);

  const pager = openState.client === client && openState.key === key
    ? openState.pager
    : null;
  const openingError = openState.client === client && openState.key === key
    ? openState.error
    : null;
  const subscribe = useCallback(
    (listener: () => void) => pager ? pager.subscribe(listener) : () => {},
    [pager],
  );
  const getSnapshot = useCallback(
    () => pager?.getSnapshot()
      ?? (client === null ? UNAVAILABLE_QUERY_SNAPSHOT : EMPTY_QUERY_SNAPSHOT),
    [client, pager],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(() => {
    if (pager) return pager.refresh();
    setAttempt((value) => value + 1);
    return Promise.resolve();
  }, [pager]);
  const loadMore = useCallback(
    () => pager ? pager.loadMore() : Promise.resolve(),
    [pager],
  );

  if (openingError) {
    return Object.freeze({
      rows: EMPTY_QUERY_SNAPSHOT.rows,
      hasMore: false,
      status: 'error',
      error: openingError,
      refresh,
      loadMore,
    });
  }

  return Object.freeze({
    rows: snapshot.rows,
    hasMore: snapshot.hasMore,
    status: client === null ? 'unavailable' : pager ? snapshot.status : 'loading',
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    refresh,
    loadMore,
  });
}
