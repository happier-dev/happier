import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';

import type { CorpusCollectionsV1 } from '../collections/bindCorpusCollections.js';
import { CORPUS_USER_MARKS_INDEX_ID } from '../collections/ids.js';
import { fromCorpusStoredRow } from '../collections/rowCodec.js';
import type { CorpusUserMarkRowV1 } from '../collections/rows.js';

/**
 * The pinned section — the one section whose rows come from a Collection.
 *
 * The marks query owns the section's cursor, order and count. Re-ranking a lane
 * page by pinned-ness would only surface the pins that happen to be in the
 * loaded window, and persisting pinned state on anything else would create a
 * second writer for a user fact.
 *
 * It issues **zero per-row reads and no provider call**: a mark carries the
 * `entryRef` and the display values a row needs on its own, and the caller
 * renders fresher facts for any mark whose `entryRef` its device-local
 * projection already holds. A pinned entry the current pass did not materialize
 * still renders from the mark, still shows as not yet synchronized, and stays
 * unpinnable — dropping it would leave the user unable to even remove the pin.
 */

export type CorpusPinnedSectionPageV1 = Readonly<{
    marks: readonly CorpusUserMarkRowV1[];
    nextCursor?: string;
}>;

export async function readPinnedSection(input: Readonly<{
    collections: Pick<CorpusCollectionsV1, 'userMarks'>;
    limit: number;
    cursor?: string;
    signal?: AbortSignal;
}>): Promise<CorpusPinnedSectionPageV1> {
    const options: PluginCancellationOptions | undefined = input.signal ? { signal: input.signal } : undefined;
    const page = await input.collections.userMarks.query({
        index: CORPUS_USER_MARKS_INDEX_ID.byPinned,
        prefix: [true],
        // The index already encodes `markedAtMs` descending — a descending field
        // is byte-inverted in the stored sort key — so the forward traversal is
        // the newest-pin-first order. `desc` here would page the oldest pins.
        order: 'asc',
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }, options);

    return {
        marks: page.rows.map((row) => fromCorpusStoredRow<CorpusUserMarkRowV1>(row).value),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
}
