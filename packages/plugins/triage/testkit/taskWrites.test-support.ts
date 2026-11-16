import type { StorageService } from '@happier-dev/plugin-sdk/storage';
import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { createTestkitCorpusCollections } from '../src/corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../src/corpus/collections/rowCodec.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../src/corpus/collections/ids.js';
import { CORPUS_SOURCE_INSTANCES_COLLECTION, CORPUS_SESSION_LINKS_COLLECTION, CORPUS_USER_MARKS_COLLECTION } from '../src/corpus/collections/definitions.js';

export { TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 } from '../src/actions/tasksProtocol.js';

/** The canonical in-memory Account collection boundary, seeded with an owned source. */
export function createConfiguredTaskSourceStorage(configured: TriageConfiguredSourceInstanceV1): StorageService {
    const corpus = createTestkitCorpusCollections();
    const source = configured.instance.source;
    corpus.control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: 'a'.repeat(43),
        sourceQualifiedId: `${source.pluginId}/${source.localId}`, lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1, configured }));
    // Storage's generic Collection API is supplied by the Account-bound persistence fixture.
    return { account: { collection: (definition: { id: string }) => {
        if (definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION.id) return corpus.collections.sourceInstances;
        if (definition.id === CORPUS_SESSION_LINKS_COLLECTION.id) return corpus.collections.sessionLinks;
        if (definition.id === CORPUS_USER_MARKS_COLLECTION.id) return corpus.collections.userMarks;
        throw new Error(`Unexpected Account Collection ${definition.id}`);
    } } } as unknown as StorageService;
}
