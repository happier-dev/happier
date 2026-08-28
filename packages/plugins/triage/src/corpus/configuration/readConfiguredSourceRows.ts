import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';

import type { CorpusCollectionHandleV1 } from '../collections/handles.js';
import {
    CORPUS_SOURCE_INSTANCES_INDEX_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../collections/ids.js';
import { fromCorpusStoredRow } from '../collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../collections/rows.js';
import { advanceConfiguredSourceCollectionCursor } from './administerConfiguredSourceInstance.js';

/**
 * The canonical active configured-source read.
 *
 * Both the daemon aggregate and mounted Account surface consume this owner, so
 * lifecycle selection, cursor handling and decoding cannot drift between
 * transports.
 */
export async function readActiveConfiguredSourceRowPage(
    sourceInstances: Pick<CorpusCollectionHandleV1, 'query'>,
    input: Readonly<{ limit: number; cursor?: string }>,
    options?: PluginCancellationOptions,
): Promise<Readonly<{
    rows: readonly CorpusSourceInstanceRowV1[];
    status: 'complete' | 'truncated';
    nextCursor?: string;
}>> {
    const page = await sourceInstances.query({
        index: CORPUS_SOURCE_INSTANCES_INDEX_ID.byLifecycle,
        prefix: [CORPUS_SOURCE_INSTANCE_LIFECYCLE.active],
        order: 'asc',
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }, options);
    return Object.freeze({
        rows: Object.freeze(page.rows.map(
            (row) => fromCorpusStoredRow<CorpusSourceInstanceRowV1>(row).value,
        )),
        status: page.nextCursor === undefined ? 'complete' : 'truncated',
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
}

/** Reads every active configured source through the same cursor owner. */
export async function readActiveConfiguredSourceRows(
    sourceInstances: Pick<CorpusCollectionHandleV1, 'query'>,
    options?: PluginCancellationOptions,
): Promise<Readonly<{
    rows: readonly CorpusSourceInstanceRowV1[];
    status: 'complete';
}>> {
    const rows: CorpusSourceInstanceRowV1[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await sourceInstances.query({
            index: CORPUS_SOURCE_INSTANCES_INDEX_ID.byLifecycle,
            prefix: [CORPUS_SOURCE_INSTANCE_LIFECYCLE.active],
            order: 'asc',
            ...(cursor === undefined ? {} : { cursor }),
        }, options);
        rows.push(...page.rows.map(
            (row) => fromCorpusStoredRow<CorpusSourceInstanceRowV1>(row).value,
        ));
        cursor = advanceConfiguredSourceCollectionCursor(seenCursors, page.nextCursor);
    } while (cursor !== undefined);

    return Object.freeze({ rows: Object.freeze(rows), status: 'complete' });
}
