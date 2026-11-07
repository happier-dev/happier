import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol';
import type { PluginAccountCollection } from '@happier-dev/plugin-sdk/collections';

import type { CorpusCollectionsV1 } from '../collections/bindCorpusCollections.js';
import {
    CORPUS_SESSION_LINKS_COLLECTION,
    CORPUS_SOURCE_INSTANCES_COLLECTION,
    CORPUS_USER_MARKS_COLLECTION,
} from '../collections/definitions.js';
import {
    createInMemoryAccountCollection,
    type InMemoryAccountCollection,
} from '../collections/inMemoryAccountCollection.js';
import type { CorpusStoredValueV1 } from '../collections/handles.js';
import type { TriageListEntriesInputV1 } from '../../actions/listEntriesProtocol.js';
import { readActiveConfiguredSourceRows } from '../configuration/readConfiguredSourceRows.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../../internalTasks/configuration.js';

/** Explicit external-only scope for fixtures whose admitted inventory excludes
 * personal tasks. Whole-catalog paging tests keep allConfigured unchanged. */
export async function selectTestkitExternalSourceInput(
    input: TriageListEntriesInputV1,
    sourceInstances: CorpusCollectionsV1['sourceInstances'],
): Promise<TriageListEntriesInputV1> {
    if (input.sources.kind !== 'allConfigured') return input;
    const configured = await readActiveConfiguredSourceRows(sourceInstances);
    return { ...input, sources: { kind: 'selected', sourceInstanceIds: configured.rows
        .filter(row => row.configured.instance.sourceInstanceId !== INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId)
        .map(row => row.configured.instance.sourceInstanceId) } };
}

/** Account-scoped material for a test E2EE Account. Test bytes only. */
export function testkitAccountMaterial(seed: number): AccountScopedCryptoMaterial {
    return { type: 'dataKey', machineKey: Uint8Array.from({ length: 32 }, (_, index) => (index + seed) & 0xff) };
}

export type TestkitCorpusCollections = Readonly<{
    collections: CorpusCollectionsV1;
    /** Full persistence-boundary handles for owner-level observation tests. */
    watchableCollections: Readonly<Record<keyof CorpusCollectionsV1, PluginAccountCollection<CorpusStoredValueV1>>>;
    control: Readonly<Record<keyof CorpusCollectionsV1, InMemoryAccountCollection>>;
}>;

/**
 * The three durable Collections bound to in-memory stores under one Account
 * mode.
 *
 * Deriving a tag through the real Account-mode-aware derivation is the point:
 * a test that stubbed identity would not catch a purpose two collections share.
 */
export function createTestkitCorpusCollections(options: Readonly<{
    accountEncryptionMode?: 'plain' | 'e2ee';
    material?: AccountScopedCryptoMaterial | null;
}> = {}): TestkitCorpusCollections {
    const accountEncryptionMode = options.accountEncryptionMode ?? 'plain';
    const material = accountEncryptionMode === 'e2ee'
        ? options.material ?? testkitAccountMaterial(1)
        : null;
    const bind = (definition: Parameters<typeof createInMemoryAccountCollection>[0]['definition']) =>
        createInMemoryAccountCollection({ definition, accountEncryptionMode, material });

    const sourceInstances = bind(CORPUS_SOURCE_INSTANCES_COLLECTION);
    const sessionLinks = bind(CORPUS_SESSION_LINKS_COLLECTION);
    const userMarks = bind(CORPUS_USER_MARKS_COLLECTION);

    return {
        watchableCollections: Object.freeze({ sourceInstances: sourceInstances.collection,
            sessionLinks: sessionLinks.collection, userMarks: userMarks.collection }),
        collections: Object.freeze({
            sourceInstances: sourceInstances.collection,
            sessionLinks: sessionLinks.collection,
            userMarks: userMarks.collection,
        }),
        control: Object.freeze({
            sourceInstances: sourceInstances.control,
            sessionLinks: sessionLinks.control,
            userMarks: userMarks.control,
        }),
    };
}
