import type { JsonValue, PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { describe, expect, it } from 'vitest';

import { activate } from '../activate.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import {
    CORPUS_SESSION_LINKS_COLLECTION_ID,
    CORPUS_SESSION_LINKS_INDEX_ID,
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
} from '../corpus/collections/ids.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../corpus/collections/rows.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef, testkitLocator } from '../corpus/testkit/observations.test-support.js';
import { TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 } from './sessionLinksProtocol.js';

/**
 * The registered writer of `session-links`.
 *
 * A mounted Plugin UI surface holds a Host API with no storage member, so an
 * Action is the only transport between the surface that starts work on an entry
 * and the one canonical link writer. Without a registered one the Collection is
 * declared, admitted, queried by the Session cockpit — and structurally unable
 * to ever hold a row.
 *
 * The seam is exercised through `activate`, not through the handler factory: a
 * handler nothing registers is exactly the defect this proves is gone.
 */

const NOW_BEFORE_MS = 1_760_000_900_000;

function registeredLinkHandler(): ActionHandler<JsonValue, JsonValue> {
    const handlers = new Map<string, ActionHandler<JsonValue, JsonValue>>();
    const api = {
        actions: {
            register: (id: string, handler: ActionHandler<JsonValue, JsonValue>) => {
                handlers.set(id, handler);
            },
        },
        composerAttachments: { register: () => {} },
    } as unknown as PluginApi;

    activate(api);
    const handler = handlers.get(TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1);
    if (handler === undefined) {
        throw new Error(
            `activation registers no handler for "${TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1}"`,
        );
    }
    return handler;
}

function createContext(collections: CorpusCollectionsV1): PluginInvocationContext {
    return {
        signal: new AbortController().signal,
        services: {
            storage: {
                account: {
                    collection: (definition: PluginAccountCollectionDefinition) => {
                        if (definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID) {
                            return collections.sessionLinks;
                        }
                        return definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
                            ? collections.sourceInstances
                            : collections.userMarks;
                    },
                },
            },
        },
    } as unknown as PluginInvocationContext;
}

async function readLinkRows(
    collections: CorpusCollectionsV1,
    sessionId: string,
): Promise<readonly CorpusSessionLinkRowV1[]> {
    const page = await collections.sessionLinks.query({
        index: CORPUS_SESSION_LINKS_INDEX_ID.bySession,
        prefix: [sessionId],
        order: 'asc',
        limit: 64,
    });
    return page.rows.map((row) => fromCorpusStoredRow<CorpusSessionLinkRowV1>(row).value);
}

describe('the session-link writer Action', () => {
    it('writes one durable link row the Session cockpit can read', async () => {
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const handler = registeredLinkHandler();

        const result = await handler({
            v: 1,
            sessionId: 'session-a',
            entryRef: testkitEntryRef(),
            display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
        }, createContext(collections));

        expect(result).toEqual({ v: 1, status: 'linked' });
        const rows = await readLinkRows(collections, 'session-a');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.sessionId).toBe('session-a');
        // The cockpit renders this exact frozen path; nothing durable holds a
        // fresher one to read.
        expect(rows[0]?.displayPathAtLink).toBe('example/repository #17');
    });

    it('keeps one row for one entry and Session when the same link is repeated with a different rendering', async () => {
        // The failure this excludes: a second device materializes the same entry
        // with a fresher display path, presses the same affordance, and the
        // Session ends up showing one relationship twice.
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const handler = registeredLinkHandler();
        const context = createContext(collections);

        await handler({
            v: 1,
            sessionId: 'session-a',
            entryRef: testkitEntryRef(),
            display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
        }, context);
        const second = await handler({
            v: 1,
            sessionId: 'session-a',
            // Structurally equal, independently constructed, differently rendered.
            entryRef: { ...testkitEntryRef() },
            display: {
                locator: testkitLocator({ displayPath: 'example/repository #17 (renamed)' }),
                scopeLabel: 'example/repository',
            },
        }, context);

        expect(second).toEqual({ v: 1, status: 'linked' });
        const rows = await readLinkRows(collections, 'session-a');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.displayPathAtLink).toBe('example/repository #17');
        expect(rows[0]?.linkedAtMs).toBeGreaterThanOrEqual(NOW_BEFORE_MS);
    });

    it('reports a refused storage write as a failed status rather than throwing', async () => {
        const { collections } = createTestkitCorpusCollections();
        const handler = registeredLinkHandler();

        const result = await handler({
            v: 1,
            sessionId: 'session-a',
            entryRef: testkitEntryRef(),
            display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
        }, createContext({
            ...collections,
            sessionLinks: {
                ...collections.sessionLinks,
                batch: async () => {
                    throw new Error('collection_unavailable');
                },
            },
        }));

        expect(result).toEqual({ v: 1, status: 'failed' });
    });

    it('falls back to the entry scope label when the source emitted no display path', async () => {
        const { collections } = createTestkitCorpusCollections();
        const handler = registeredLinkHandler();

        await handler({
            v: 1,
            sessionId: 'session-a',
            entryRef: testkitEntryRef(),
            display: {
                locator: testkitLocator({ displayPath: undefined }),
                scopeLabel: 'example/repository',
            },
        }, createContext(collections));

        const rows = await readLinkRows(collections, 'session-a');
        expect(rows[0]?.displayPathAtLink).toBe('example/repository');
    });
});
