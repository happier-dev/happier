import { describe, expect, it } from 'vitest';

import type { PluginCollectionPage, PluginCollectionQuery } from '@happier-dev/plugin-sdk/collections';

import { createPluginCollectionTableQuery } from './collectionTableQuery.js';

type Row = Readonly<{ age: number; label: string }>;

function page(rows: readonly Row[], nextCursor: string | undefined): PluginCollectionPage<Row> {
  return { rows: rows.map((value, index) => ({ rowId: `${value.label}-${index}`, revision: 1, value })), nextCursor, changeCursor: 1 };
}

describe('plugin collection table query', () => {
  it('maps field indexes and preserves cursor paging in both directions', async () => {
    const requests: PluginCollectionQuery[] = [];
    const connector = createPluginCollectionTableQuery<Row>({
      fields: [{ key: 'age', collectionIndex: 'by-age' }],
      pageSize: 2,
      initialSort: { field: 'age', direction: 'ascending' },
      query: async (request) => {
        requests.push(request);
        if (request.order === 'asc' && request.cursor === undefined) return page([{ age: 1, label: 'a' }, { age: 2, label: 'b' }], 'asc-2');
        if (request.order === 'asc') return page([{ age: 3, label: 'c' }], undefined);
        if (request.cursor === undefined) return page([{ age: 3, label: 'c' }, { age: 2, label: 'b' }], 'desc-2');
        return page([{ age: 1, label: 'a' }], undefined);
      },
    });

    await connector.refresh();
    await connector.loadMore();
    expect(connector.getSnapshot().rows.map((row) => row.value.label)).toEqual(['a', 'b', 'c']);
    expect(requests).toEqual([
      { index: 'by-age', order: 'asc', limit: 2 },
      { index: 'by-age', order: 'asc', cursor: 'asc-2', limit: 2 },
    ]);

    await connector.setSort('age', 'descending');
    await connector.loadMore();
    expect(connector.getSnapshot().rows.map((row) => row.value.label)).toEqual(['c', 'b', 'a']);
    expect(requests.slice(2)).toEqual([
      { index: 'by-age', order: 'desc', limit: 2 },
      { index: 'by-age', order: 'desc', cursor: 'desc-2', limit: 2 },
    ]);
  });
});
