import { describe, expect, it } from 'vitest';

import {
    createTestkitCorpusCollections,
    testkitAccountMaterial,
} from '../testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../testkit/observations.test-support.js';
import { entryReferenceComponents } from './components.js';
import { deriveSessionLinkEntryTag, deriveSessionLinkTag, deriveUserMarkTag } from './tags.js';

const TAG_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * A contract-valid `collisionScope` or `entryId` may contain this byte: the
 * public contract bounds them but does not restrict their character class.
 */
const UNIT_SEPARATOR = '\u001f';

describe('canonical entry reference identity', () => {
    it('orders the reference components exactly, so a pin and a link agree on the one entry', () => {
        // Reordering, omitting the source, or omitting the kind silently merges
        // two entries into one pin or one link.
        expect(entryReferenceComponents(testkitEntryRef())).toEqual([
            'happier.example.source/example-forge',
            'pull-request',
            'example/repository',
            '17',
        ]);
    });

    it('derives one mark and one link address for the same entry seen through two connections', async () => {
        // The connected account is not a component, so an entry two credentials
        // can both see cannot become two pins or two links.
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const entryRef = testkitEntryRef();

        expect(await deriveUserMarkTag(collections.userMarks, { ...entryRef }))
            .toBe(await deriveUserMarkTag(collections.userMarks, entryRef));
        expect(await deriveSessionLinkTag(collections.sessionLinks, { ...entryRef }, 'session-a'))
            .toBe(await deriveSessionLinkTag(collections.sessionLinks, entryRef, 'session-a'));
    });

    it('derives stable addresses from the same Account material in a fresh process', async () => {
        const entryRef = testkitEntryRef();
        const material = testkitAccountMaterial(7);
        const before = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee', material });
        // Nothing survives but the persisted Account material.
        const after = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee', material });

        expect(await deriveUserMarkTag(after.collections.userMarks, entryRef))
            .toBe(await deriveUserMarkTag(before.collections.userMarks, entryRef));
        expect(await deriveSessionLinkTag(after.collections.sessionLinks, entryRef, 'session-a'))
            .toBe(await deriveSessionLinkTag(before.collections.sessionLinks, entryRef, 'session-a'));
    });

    it('derives different addresses for one entry under two Happier Accounts', async () => {
        const entryRef = testkitEntryRef();
        const first = createTestkitCorpusCollections({
            accountEncryptionMode: 'e2ee',
            material: testkitAccountMaterial(1),
        });
        const second = createTestkitCorpusCollections({
            accountEncryptionMode: 'e2ee',
            material: testkitAccountMaterial(2),
        });

        const firstTag = await deriveUserMarkTag(first.collections.userMarks, entryRef);
        expect(firstTag).toMatch(TAG_PATTERN);
        expect(await deriveUserMarkTag(second.collections.userMarks, entryRef)).not.toBe(firstTag);
    });

    it('derives distinct addresses for two component tuples a delimiter join would merge', async () => {
        for (const accountEncryptionMode of ['plain', 'e2ee'] as const) {
            const { collections } = createTestkitCorpusCollections({ accountEncryptionMode });
            const left = await deriveUserMarkTag(collections.userMarks, testkitEntryRef({
                collisionScope: `origin${UNIT_SEPARATOR}region`,
                entryId: '42',
            }));
            const right = await deriveUserMarkTag(collections.userMarks, testkitEntryRef({
                collisionScope: 'origin',
                entryId: `region${UNIT_SEPARATOR}42`,
            }));

            expect(right).not.toBe(left);
        }
    });

    it('derives a 43-character address for a maximum-valid natural key over the row-id ceiling', async () => {
        for (const accountEncryptionMode of ['plain', 'e2ee'] as const) {
            const { collections } = createTestkitCorpusCollections({ accountEncryptionMode });
            const entryRef = testkitEntryRef({
                collisionScope: 'scope-'.repeat(80),
                entryId: 'entry-'.repeat(80),
            });

            expect(await deriveUserMarkTag(collections.userMarks, entryRef)).toMatch(TAG_PATTERN);
            expect(await deriveSessionLinkEntryTag(collections.sessionLinks, entryRef)).toMatch(TAG_PATTERN);
        }
    });

    it('never reuses one collection address as another collection identity', async () => {
        // The mark row id, the link row id and the link's entry index value are
        // built from the same ordered components, so only the collection and
        // field binding separates them. Copying one would address the wrong row.
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const entryRef = testkitEntryRef();

        const markTag = await deriveUserMarkTag(collections.userMarks, entryRef);
        const linkEntryTag = await deriveSessionLinkEntryTag(collections.sessionLinks, entryRef);
        const linkTag = await deriveSessionLinkTag(collections.sessionLinks, entryRef, 'session-a');

        expect(new Set([markTag, linkEntryTag, linkTag]).size).toBe(3);
    });
});
