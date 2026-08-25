import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';

import { MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1 } from './administerConfiguredSourceInstance.js';
import type { CorpusCollectionHandleV1 } from '../collections/handles.js';
import {
    CORPUS_SOURCE_INSTANCES_INDEX_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../collections/ids.js';
import { fromCorpusStoredRow } from '../collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../collections/rows.js';

/**
 * The canonical active configured-source read.
 *
 * Both the daemon aggregate and mounted Account surface consume this owner, so
 * lifecycle selection, decoding and the truthful one-row-past truncation check
 * cannot drift between transports.
 */
export async function readActiveConfiguredSourceRows(
    sourceInstances: Pick<CorpusCollectionHandleV1, 'query'>,
    options?: PluginCancellationOptions,
): Promise<Readonly<{
    /** The V1 list/materialization projection, bounded by its Action result contract. */
    rows: readonly CorpusSourceInstanceRowV1[];
    /** Every durable active row, so a bounded-set overshoot remains removable. */
    administrativeRows: readonly CorpusSourceInstanceRowV1[];
    status: 'complete' | 'truncated';
}>> {
    const administrativeRows: CorpusSourceInstanceRowV1[] = [];
    let cursor: string | undefined;
    do {
        const page = await sourceInstances.query({
            index: CORPUS_SOURCE_INSTANCES_INDEX_ID.byLifecycle,
            prefix: [CORPUS_SOURCE_INSTANCE_LIFECYCLE.active],
            order: 'asc',
            limit: MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1 + 1,
            ...(cursor === undefined ? {} : { cursor }),
        }, options);
        administrativeRows.push(...page.rows.map(
            (row) => fromCorpusStoredRow<CorpusSourceInstanceRowV1>(row).value,
        ));
        cursor = page.nextCursor;
    } while (cursor !== undefined);

    return {
        rows: administrativeRows.slice(0, MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1),
        administrativeRows,
        status: administrativeRows.length > MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1
            ? 'truncated'
            : 'complete',
    };
}
