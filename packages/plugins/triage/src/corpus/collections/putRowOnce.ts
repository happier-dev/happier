import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';

import type { CorpusCollectionHandleV1 } from './handles.js';
import { fromCorpusStoredRow, toCorpusStoredValue, type CorpusRowV1 } from './rowCodec.js';

/**
 * The one durable-row CAS put every corpus writer uses.
 *
 * `INV-04` states the sequence exactly once — a single-row put at
 * `expectedRevision: 'absent'`, one conditional resurrection put against an
 * explicit tombstone's returned revision, and a typed outcome after that — and
 * it was implemented twice, once for `user-marks` and once for `session-links`.
 * The two copies had already drifted on both axes that matter: only one of them
 * treated the live row another writer committed as an answer rather than a
 * failure. A sequence this small is exactly the kind that gets copied and then
 * corrected in one place only, so it lives here.
 *
 * It deliberately does **not** catch the store boundary. A refused or lost
 * Collection write means different things to different writers — the Session
 * link retries only its own phase, while a mounted Pin control must tell the
 * reader their Account could not be reached — so the boundary policy stays with
 * each caller and this module reports only what the store actually said.
 *
 * The two-row atomic retire/activate transition in
 * `corpus/configuration/administerConfiguredSourceInstance.ts` is not a third
 * copy of this: source-instance rows are retired in place and never deleted, so
 * no tombstone can exist and no resurrection is possible there.
 */

export type CorpusPutRowOnceResultV1<TRow> =
    /** This call committed the row. */
    | Readonly<{ status: 'written' }>
    /**
     * Another writer holds the live row. What it committed is a fact about the
     * row rather than a failure of this call, so the caller decides whether it
     * is the state it wanted.
     */
    | Readonly<{ status: 'live'; row: CorpusRowV1<TRow> }>
    /** Contended, with no live row to explain it. */
    | Readonly<{ status: 'conflict' }>;

export async function putCorpusRowOnce<TRow>(input: Readonly<{
    collection: CorpusCollectionHandleV1;
    /** The row's own id, so a lost race can be re-read at its exact address. */
    rowId: string;
    row: TRow;
    signal?: AbortSignal;
}>): Promise<CorpusPutRowOnceResultV1<TRow>> {
    const { collection, rowId } = input;
    const options: PluginCancellationOptions | undefined = input.signal
        ? { signal: input.signal }
        : undefined;
    const value = toCorpusStoredValue(input.row);

    const first = await collection.batch(
        [{ kind: 'put', value, expectedRevision: 'absent' }],
        options,
    );
    if (first.status === 'updated') return { status: 'written' };

    const conflict = first.conflicts[0];
    // The one conditional resurrection this design allows: an explicit tombstone
    // carries no competing live content, so the same intent may be written once
    // against that exact revision. An `absent` put alone would lose the row
    // forever, while a general conflict retry could overwrite newer live state.
    if (conflict?.deleted === true && conflict.revision !== null) {
        const second = await collection.batch(
            [{ kind: 'put', value, expectedRevision: conflict.revision }],
            options,
        );
        if (second.status === 'updated') return { status: 'written' };
    }

    const live = await collection.get(rowId, options);
    return live === null
        ? { status: 'conflict' }
        : { status: 'live', row: fromCorpusStoredRow<TRow>(live) };
}
