import { describe, expect, it } from 'vitest';

import { createTestkitCorpusCollections } from '../testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../testkit/observations.test-support.js';
import { userMarkTagComponents } from './components.js';
import { deriveUserMarkTag } from './tags.js';

describe('user mark identity tags', () => {
    it('derives markTag from the exact ordered entry-ref components in both Account modes', async () => {
        // Pin, retention and the Account-mode transition must all address the
        // one mark row. Reordering these components, or omitting the source or
        // kind, silently loses the mark's retention protection.
        expect(userMarkTagComponents(testkitEntryRef())).toEqual([
            'happier.example.source/example-forge',
            'pull-request',
            'example/repository',
            '17',
        ]);

        for (const accountEncryptionMode of ['plain', 'e2ee'] as const) {
            const { collections } = createTestkitCorpusCollections({ accountEncryptionMode });
            const canonical = await deriveUserMarkTag(collections.userMarks, testkitEntryRef());

            expect(canonical).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(await deriveUserMarkTag(collections.userMarks, testkitEntryRef({ kindId: 'issue' })))
                .not.toBe(canonical);
            expect(await deriveUserMarkTag(collections.userMarks, testkitEntryRef({
                source: { pluginId: 'happier.other.source', localId: 'example-forge' },
            }))).not.toBe(canonical);
            expect(await deriveUserMarkTag(collections.userMarks, testkitEntryRef({
                collisionScope: 'example/other-repository',
            }))).not.toBe(canonical);
        }
    });

    it('rejects a mark tag requested for a field the marks contract does not declare', async () => {
        const { collections } = createTestkitCorpusCollections();

        await expect(collections.userMarks.identityTag({
            field: 'entryRef',
            components: ['anything'],
        })).rejects.toMatchObject({ code: 'plugin_collection_invalid_value' });
    });
});
