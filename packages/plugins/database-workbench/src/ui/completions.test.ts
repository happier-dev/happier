import { expect, it } from 'vitest';
import { createDatabaseCompletionSource, type DatabaseCompletionMetadata } from './completions.js';

it('samples current cached names and native column types without owning a metadata reader', async () => {
    let metadata: DatabaseCompletionMetadata = {};
    const source = createDatabaseCompletionSource(() => metadata);
    const position = { offset: 0, line: 1, character: 0, explicit: true };
    const signal = new AbortController().signal;
    expect(await source.complete(position, signal)).toBeNull();
    metadata = { schemas: [{ name: 'public' }], relations: [{ name: 'items', kind: 'table' }],
        columns: [{ name: 'price', nativeType: 'numeric(20,2)' }] };
    expect(await source.complete(position, signal)).toEqual([
        { label: 'public' }, { label: 'items', detail: 'table' }, { label: 'price', detail: 'numeric(20,2)' },
    ]);
    metadata = { columns: [{ name: 'id', nativeType: 'bigint' }] };
    expect(await source.complete(position, signal)).toEqual([{ label: 'id', detail: 'bigint' }]);
    const cancelled = new AbortController(); cancelled.abort();
    expect(await source.complete(position, cancelled.signal)).toBeNull();
});
