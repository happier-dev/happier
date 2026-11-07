import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';

import type { CorpusCollectionHandleV1 } from '../collections/handles.js';
import {
    CORPUS_SOURCE_INSTANCES_INDEX_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../collections/ids.js';
import { fromCorpusStoredRow, type CorpusRowV1 } from '../collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../collections/rows.js';
import { advanceConfiguredSourceCollectionCursor, readExactConfiguredSourceInstanceRow } from './administerConfiguredSourceInstance.js';
import { projectInternalTaskSourceCatalogV1 } from '../../internalTasks/configuration.js';

/** The selected-detail counterpart of the active catalog read below. */
export async function readActiveConfiguredSourceRow(
    sourceInstances: Pick<CorpusCollectionHandleV1, 'get' | 'identityTag'>,
    exact: Parameters<typeof readExactConfiguredSourceInstanceRow>[1],
    options?: PluginCancellationOptions,
): Promise<CorpusRowV1<CorpusSourceInstanceRowV1> | null> {
    const record = await readExactConfiguredSourceInstanceRow(sourceInstances, exact, options);
    return record?.value.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.active ? record : null;
}

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
    /** Stored revisions, or the immutable built-in configuration's revision. */
    records: readonly CorpusRowV1<CorpusSourceInstanceRowV1>[];
    status: 'complete' | 'truncated';
    nextCursor?: string;
}>> {
    const page = await sourceInstances.query({
        index: CORPUS_SOURCE_INSTANCES_INDEX_ID.byLifecycle,
        prefix: [CORPUS_SOURCE_INSTANCE_LIFECYCLE.active],
        order: 'asc',
        // The first catalog page reserves one place for the built-in source.
        limit: input.limit - (input.cursor === undefined ? 1 : 0),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }, options);
    const records = projectInternalTaskSourceCatalogV1(page.rows.map(
        (row) => fromCorpusStoredRow<CorpusSourceInstanceRowV1>(row),
    ), input.cursor === undefined);
    return Object.freeze({
        rows: Object.freeze(records.map((record) => record.value)),
        records,
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
    /** Stored revisions, or the immutable built-in configuration's revision. */
    records: readonly CorpusRowV1<CorpusSourceInstanceRowV1>[];
    status: 'complete';
}>> {
    const records: CorpusRowV1<CorpusSourceInstanceRowV1>[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await sourceInstances.query({
            index: CORPUS_SOURCE_INSTANCES_INDEX_ID.byLifecycle,
            prefix: [CORPUS_SOURCE_INSTANCE_LIFECYCLE.active],
            order: 'asc',
            ...(cursor === undefined ? {} : { cursor }),
        }, options);
        records.push(...page.rows.map(
            (row) => fromCorpusStoredRow<CorpusSourceInstanceRowV1>(row),
        ));
        cursor = advanceConfiguredSourceCollectionCursor(seenCursors, page.nextCursor);
    } while (cursor !== undefined);

    const catalog = projectInternalTaskSourceCatalogV1(records);
    return Object.freeze({
        rows: Object.freeze(catalog.map((record) => record.value)),
        records: catalog,
        status: 'complete',
    });
}
