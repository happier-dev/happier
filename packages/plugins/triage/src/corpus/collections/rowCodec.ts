import type { PluginCollectionRow } from '@happier-dev/plugin-sdk/collections';

import type { CorpusStoredValueV1 } from './handles.js';

/** One corpus row, with its server-authoritative revision. */
export type CorpusRowV1<TRow> = Readonly<{
    rowId: string;
    revision: number;
    value: TRow;
}>;

/**
 * The one place a corpus row changes type.
 *
 * The declared schemas are plain JSON, so a bound handle is typed over the
 * generic stored-value shape while the corpus works in the row types of
 * `rows.ts`. Those two describe the same bytes: the host validates every write
 * and every read against the admitted schema, which is the same schema the row
 * types mirror. Revalidating here would create a second, drifting validator for
 * a contract the platform already enforces, so the projection is a typed view
 * rather than a parse — and it is confined to this file.
 *
 * Optional protocol members such as `locator.webUrl` are why the row types are
 * not structurally assignable to `Record<string, JsonValue>` even though every
 * stored value is valid JSON.
 */
export function toCorpusStoredValue<TRow>(row: TRow): CorpusStoredValueV1 {
    return row as unknown as CorpusStoredValueV1;
}

export function fromCorpusStoredRow<TRow>(
    row: PluginCollectionRow<CorpusStoredValueV1>,
): CorpusRowV1<TRow> {
    return { rowId: row.rowId, revision: row.revision, value: row.value as unknown as TRow };
}
