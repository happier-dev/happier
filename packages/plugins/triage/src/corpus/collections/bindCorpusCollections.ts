import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
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

/**
 * How one declared Collection becomes a bound handle.
 *
 * There are two realms that can supply one — the daemon's Account storage scope
 * and a mounted surface's Account Data client — and exactly one place that
 * knows WHICH three Collections exist. Keeping the definition list here is what
 * lets the same domain writers run over either transport without a second copy
 * of the corpus, a second identity derivation, or a second codec.
 */
export type CorpusCollectionBinderV1 = <TDefinition extends PluginAccountCollectionDefinition>(
    definition: TDefinition,
) => CorpusCollectionHandleV1;

export function bindCorpusCollectionsWith(bind: CorpusCollectionBinderV1): CorpusCollectionsV1 {
    return Object.freeze({
        sourceInstances: bind(CORPUS_SOURCE_INSTANCES_COLLECTION),
        sessionLinks: bind(CORPUS_SESSION_LINKS_COLLECTION),
        userMarks: bind(CORPUS_USER_MARKS_COLLECTION),
    });
}

export function bindCorpusCollections(account: PluginAccountStorageScope): CorpusCollectionsV1 {
    return bindCorpusCollectionsWith((definition) => account.collection(definition));
}
