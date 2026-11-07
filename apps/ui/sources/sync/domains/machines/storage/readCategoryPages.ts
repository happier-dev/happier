import type { MachineStorageCategoryListResultV1 } from '@happier-dev/protocol/storage/storageV1';
import type { MachineStorageCategoryInput, MachineStorageClients, MachineStorageResult } from './machineRpc';

/** The category owner acquires either a page or one revision-coherent inventory. */
export async function readStorageCategoryPages(
    input: MachineStorageCategoryInput,
    client: MachineStorageClients['categoryClient'],
    allPages: boolean,
): Promise<MachineStorageResult<MachineStorageCategoryListResultV1>> {
    const first = await client(input);
    if (!first.ok || !allPages) return first;
    if (first.value.trashEntries === undefined) return { ok: false, reason: 'invalid_response' };
    const entries = [...first.value.trashEntries];
    const items = [...first.value.items];
    const cursors = new Set<string>();
    let cursor = first.value.nextCursor;
    while (cursor) {
        if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
        if (cursors.has(cursor)) return { ok: false, reason: 'invalid_response' };
        cursors.add(cursor);
        const page = await client({ ...input, cursor });
        if (!page.ok) return page;
        if (page.value.categoryId !== input.categoryId || page.value.trashEntries === undefined
            || page.value.revision !== first.value.revision) return { ok: false, reason: 'invalid_response' };
        entries.push(...page.value.trashEntries);
        items.push(...page.value.items);
        cursor = page.value.nextCursor;
    }
    if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
    const { nextCursor: _nextCursor, ...head } = first.value;
    return { ok: true, value: { ...head, items, trashEntries: entries } };
}
