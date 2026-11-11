import type {
  PluginCollectionPage,
  PluginCollectionQuery,
  PluginCollectionRow,
} from '@happier-dev/plugin-sdk/collections';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { CollectionField } from '../components/Collection.js';

export type PluginUiCollectionTableField<Item = unknown> = Pick<CollectionField<Item>, 'key' | 'collectionIndex'>;

export type PluginUiCollectionTableSort = Readonly<{
  field: string;
  direction: 'ascending' | 'descending';
}>;

export type PluginUiCollectionTableQuerySnapshot<
  TValue extends Readonly<Record<string, JsonValue>>,
> = Readonly<{
  rows: readonly PluginCollectionRow<TValue>[];
  hasMore: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  sort: PluginUiCollectionTableSort;
  error?: unknown;
}>;

export type PluginUiCollectionTableQuery<
  TValue extends Readonly<Record<string, JsonValue>>,
> = Readonly<{
  getSnapshot(): PluginUiCollectionTableQuerySnapshot<TValue>;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  setSort(field: string, direction: PluginUiCollectionTableSort['direction']): Promise<void>;
}>;

type Input<TValue extends Readonly<Record<string, JsonValue>>> = Readonly<{
  fields: readonly PluginUiCollectionTableField[];
  pageSize: number;
  initialSort: PluginUiCollectionTableSort;
  query: (request: PluginCollectionQuery) => Promise<PluginCollectionPage<TValue>>;
}>;

function toWireOrder(direction: PluginUiCollectionTableSort['direction']): 'asc' | 'desc' {
  return direction === 'ascending' ? 'asc' : 'desc';
}

export function createPluginCollectionTableQuery<
  TValue extends Readonly<Record<string, JsonValue>>,
>(input: Input<TValue>): PluginUiCollectionTableQuery<TValue> {
  const indexByField = new Map(
    input.fields
      .filter((field): field is PluginUiCollectionTableField & { collectionIndex: string } => field.collectionIndex !== undefined)
      .map((field) => [field.key, field.collectionIndex]),
  );
  let sort = input.initialSort;
  let rows: readonly PluginCollectionRow<TValue>[] = [];
  let nextCursor: string | undefined;
  let status: PluginUiCollectionTableQuerySnapshot<TValue>['status'] = 'idle';
  let error: unknown;
  let inFlight: Promise<void> | undefined;

  const indexFor = (field: string): string => {
    const index = indexByField.get(field);
    if (index === undefined) throw new Error(`Collection field "${field}" has no declared index.`);
    return index;
  };

  const fetch = async (reset: boolean): Promise<void> => {
    if (inFlight !== undefined) return inFlight;
    const cursor = reset ? undefined : nextCursor;
    if (!reset && cursor === undefined) return;
    status = 'loading';
    error = undefined;
    inFlight = (async () => {
      try {
        const request: PluginCollectionQuery = {
          index: indexFor(sort.field),
          order: toWireOrder(sort.direction),
          ...(cursor === undefined ? {} : { cursor }),
          limit: input.pageSize,
        };
        const page = await input.query(request);
        rows = reset ? page.rows : [...rows, ...page.rows];
        nextCursor = page.nextCursor;
        status = 'ready';
      } catch (caught: unknown) {
        error = caught;
        status = 'error';
        throw caught;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return {
    getSnapshot: () => ({
      rows,
      hasMore: nextCursor !== undefined,
      status,
      sort,
      ...(error === undefined ? {} : { error }),
    }),
    refresh: () => fetch(true),
    loadMore: () => fetch(false),
    setSort: async (field, direction) => {
      indexFor(field);
      sort = { field, direction };
      if (inFlight !== undefined) {
        await inFlight.catch(() => undefined);
      }
      await fetch(true);
    },
  };
}
