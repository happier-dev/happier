import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol';

import type { CorpusCollectionsV1 } from '../collections/bindCorpusCollections.js';
import {
    CORPUS_SESSION_LINKS_COLLECTION,
    CORPUS_SOURCE_INSTANCES_COLLECTION,
    CORPUS_USER_MARKS_COLLECTION,
} from '../collections/definitions.js';
import {
    createInMemoryAccountCollection,
    type InMemoryAccountCollection,
} from './inMemoryAccountCollection.test-support.js';

/** Account-scoped material for a test E2EE Account. Test bytes only. */
export function testkitAccountMaterial(seed: number): AccountScopedCryptoMaterial {
    return { type: 'dataKey', machineKey: Uint8Array.from({ length: 32 }, (_, index) => (index + seed) & 0xff) };
}

export type TestkitCorpusCollections = Readonly<{
    collections: CorpusCollectionsV1;
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
