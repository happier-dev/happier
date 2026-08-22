import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';

import {
    CORPUS_SESSION_LINKS_COLLECTION,
    CORPUS_SOURCE_INSTANCES_COLLECTION,
    CORPUS_USER_MARKS_COLLECTION,
} from './definitions.js';
import type { CorpusCollectionHandleV1 } from './handles.js';

/**
 * The three bound durable Collections.
 *
 * Separation is by writer: each collection has exactly one module that creates
 * its rows, so two independently written concerns can never race inside one row.
 * `session-links` additionally has `sessions/reconcileMergedSuccessor.ts`, which
 * creates nothing — it retargets an existing row onto an authoritative successor
 * — and `user-marks` deliberately has no second writer at all, which is why a
 * merge never moves a pin. Binding happens once and the handles are passed to
 * those owners; no owner rebinds a collection of its own.
 */
export type CorpusCollectionsV1 = Readonly<{
    sourceInstances: CorpusCollectionHandleV1;
    sessionLinks: CorpusCollectionHandleV1;
    userMarks: CorpusCollectionHandleV1;
}>;

export function bindCorpusCollections(account: PluginAccountStorageScope): CorpusCollectionsV1 {
    return Object.freeze({
        sourceInstances: account.collection(CORPUS_SOURCE_INSTANCES_COLLECTION),
        sessionLinks: account.collection(CORPUS_SESSION_LINKS_COLLECTION),
        userMarks: account.collection(CORPUS_USER_MARKS_COLLECTION),
    });
}
