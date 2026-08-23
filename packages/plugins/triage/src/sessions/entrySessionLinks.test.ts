import { describe, expect, it } from 'vitest';

import { CORPUS_SESSION_LINKS_INDEX_ID } from '../corpus/collections/ids.js';
import type { CorpusSessionLinkRowV1 } from '../corpus/collections/rows.js';
import { deriveSessionLinkEntryTag, deriveSessionLinkTag } from '../corpus/identity/tags.js';
import {
    createTestkitCorpusCollections,
    testkitAccountMaterial,
} from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef, testkitLocator } from '../corpus/testkit/observations.test-support.js';
import { linkEntryToSession, unlinkEntryFromSession } from './entrySessionLinks.js';
import { TESTKIT_LINK_DISPLAY } from './testkit/entrySessionTestkit.test-support.js';

const NOW_MS = 1_760_000_900_000;

describe('linkEntryToSession', () => {
    it('writes one link row from the projected facts, with no durable entry row anywhere', async () => {
        const fixture = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const entryRef = testkitEntryRef();

        const result = await linkEntryToSession({
            collections: fixture.collections,
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            sessionId: 'session-a',
            nowMs: NOW_MS,
            mintCardPublicationId: () => 'publication-id-a',
        });

        const linkTag = await deriveSessionLinkTag(fixture.collections.sessionLinks, entryRef, 'session-a');
        expect(result).toEqual({ status: 'linked', linkTag });
        expect((await fixture.collections.sessionLinks.get(linkTag))?.value).toEqual({
            linkTag,
            entryTag: await deriveSessionLinkEntryTag(fixture.collections.sessionLinks, entryRef),
            sessionId: 'session-a',
            linkedAtMs: NOW_MS,
            cardPublicationId: 'publication-id-a',
            entryRef,
            identityEntryRef: entryRef,
            displayPathAtLink: 'example/repository #17',
        });
    });

    it('addresses one link row for one entry reference and Session across devices and passes', async () => {
        // The failure this excludes: a second device materializes the same entry
        // with a fresher display path and its start writes a second link, so one
        // relationship is represented twice and the merge retarget can only fix
        // one of them.
        const fixture = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const entryRef = testkitEntryRef();
        await linkEntryToSession({
            collections: fixture.collections,
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            sessionId: 'session-a',
            nowMs: NOW_MS,
            mintCardPublicationId: () => 'publication-id-a',
        });
        const linkTag = await deriveSessionLinkTag(fixture.collections.sessionLinks, entryRef, 'session-a');
        const revisionAfterFirst = fixture.control.sessionLinks.inspect(linkTag)?.revision;

        const second = await linkEntryToSession({
            collections: fixture.collections,
            // Structurally equal, independently constructed, differently rendered.
            entryRef: { ...testkitEntryRef() },
            display: {
                locator: testkitLocator({ displayPath: 'example/repository #17 (renamed)' }),
                scopeLabel: 'example/repository',
            },
            sessionId: 'session-a',
            nowMs: NOW_MS + 60_000,
            mintCardPublicationId: () => 'publication-id-b',
        });

        expect(second).toEqual({ status: 'linked', linkTag });
        const page = await fixture.collections.sessionLinks.query({
            index: CORPUS_SESSION_LINKS_INDEX_ID.bySession,
            prefix: ['session-a'],
            order: 'asc',
        });
        expect(page.rows).toHaveLength(1);
        const row = page.rows[0]?.value as unknown as CorpusSessionLinkRowV1;
        expect(row.linkedAtMs).toBe(NOW_MS);
        expect(row.cardPublicationId).toBe('publication-id-a');
        expect(row.displayPathAtLink).toBe('example/repository #17');
        expect(fixture.control.sessionLinks.inspect(linkTag)?.revision).toBe(revisionAfterFirst);
    });

    it('derives the same link address from the same Account material in a fresh process', async () => {
        // An unstable address would strand the user's Session relationship at an
        // id nothing can read back after a restart.
        const entryRef = testkitEntryRef();
        const material = testkitAccountMaterial(7);
        const before = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee', material });
        const after = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee', material });

        const linked = await linkEntryToSession({
            collections: before.collections,
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            sessionId: 'session-a',
            nowMs: NOW_MS,
        });

        expect(linked).toEqual({
            status: 'linked',
            linkTag: await deriveSessionLinkTag(after.collections.sessionLinks, entryRef, 'session-a'),
        });
    });

    it('gives one entry linked to two Sessions two independent rows', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const link = (sessionId: string) => linkEntryToSession({
            collections: fixture.collections,
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            sessionId,
            nowMs: NOW_MS,
        });

        await link('session-a');
        await link('session-b');

        const page = await fixture.collections.sessionLinks.query({
            index: CORPUS_SESSION_LINKS_INDEX_ID.byEntry,
            prefix: [await deriveSessionLinkEntryTag(fixture.collections.sessionLinks, entryRef)],
            order: 'asc',
        });
        expect(page.rows.map((row) => (row.value as unknown as CorpusSessionLinkRowV1).sessionId).sort())
            .toEqual(['session-a', 'session-b']);
    });

    it('falls back to the entry scope label when the source emitted no display path', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();

        await linkEntryToSession({
            collections: fixture.collections,
            entryRef,
            display: {
                locator: testkitLocator({ displayPath: undefined }),
                scopeLabel: 'example/repository',
            },
            sessionId: 'session-a',
            nowMs: NOW_MS,
        });

        const linkTag = await deriveSessionLinkTag(fixture.collections.sessionLinks, entryRef, 'session-a');
        const linkRow = (await fixture.collections.sessionLinks.get(linkTag))?.value as CorpusSessionLinkRowV1;
        expect(linkRow.displayPathAtLink).toBe('example/repository');
    });

    it('rewrites the same relationship over its own tombstone', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const link = (nowMs: number) => linkEntryToSession({
            collections: fixture.collections,
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            sessionId: 'session-a',
            nowMs,
        });
        await link(NOW_MS);
        const linkTag = await deriveSessionLinkTag(fixture.collections.sessionLinks, entryRef, 'session-a');
        fixture.control.sessionLinks.tombstone(linkTag);

        expect(await link(NOW_MS + 1)).toEqual({ status: 'linked', linkTag });
        expect(await fixture.collections.sessionLinks.get(linkTag)).not.toBeNull();
    });

    it('reports a refused storage write as a retryable failure rather than throwing', async () => {
        const fixture = createTestkitCorpusCollections();

        expect(await linkEntryToSession({
            collections: {
                sessionLinks: {
                    ...fixture.collections.sessionLinks,
                    batch: async () => {
                        throw new Error('collection_unavailable');
                    },
                },
            },
            entryRef: testkitEntryRef(),
            display: TESTKIT_LINK_DISPLAY,
            sessionId: 'session-a',
            nowMs: NOW_MS,
        })).toEqual({ status: 'failed' });
    });
});

describe('unlinkEntryFromSession', () => {
    async function linkedFixture(): Promise<Readonly<{
        fixture: ReturnType<typeof createTestkitCorpusCollections>;
        entryRef: ReturnType<typeof testkitEntryRef>;
        linkTag: string;
    }>> {
        const fixture = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const entryRef = testkitEntryRef();
        await linkEntryToSession({
            collections: fixture.collections,
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            sessionId: 'session-a',
            nowMs: NOW_MS,
        });
        const linkTag = await deriveSessionLinkTag(
            fixture.collections.sessionLinks,
            entryRef,
            'session-a',
        );
        return { fixture, entryRef, linkTag };
    }

    it('removes the one link the user named and leaves every other link alone', async () => {
        // The failure this excludes: an unlink addressed by the entry alone,
        // which would drop the same entry's link to a Session the user never
        // touched. The named Session is deliberately the SECOND one, so an
        // implementation that reaches for any of the entry's links — or for a
        // fixed one — removes the wrong row and this fails.
        const { fixture, entryRef, linkTag: linkToA } = await linkedFixture();
        await linkEntryToSession({
            collections: fixture.collections,
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            sessionId: 'session-b',
            nowMs: NOW_MS,
        });
        const linkToB = await deriveSessionLinkTag(
            fixture.collections.sessionLinks,
            entryRef,
            'session-b',
        );
        expect(linkToB).not.toBe(linkToA);

        expect(await unlinkEntryFromSession({
            collections: fixture.collections,
            entryRef,
            sessionId: 'session-b',
        })).toEqual({ status: 'unlinked', linkTag: linkToB });

        expect(await fixture.collections.sessionLinks.get(linkToB)).toBeNull();
        expect(fixture.control.sessionLinks.inspect(linkToB)?.deleted).toBe(true);
        expect(await fixture.collections.sessionLinks.get(linkToA)).not.toBeNull();
    });

    it('answers an already absent link with the same idempotent success', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const linkTag = await deriveSessionLinkTag(
            fixture.collections.sessionLinks,
            entryRef,
            'session-a',
        );

        // Nothing was ever linked, so there is nothing different to tell the
        // reader — and a second Unlink press must not report a failure.
        expect(await unlinkEntryFromSession({
            collections: fixture.collections,
            entryRef,
            sessionId: 'session-a',
        })).toEqual({ status: 'unlinked', linkTag });
    });

    it('lets the user link the same entry to the same Session again afterwards', async () => {
        // An unlink leaves a tombstone that keeps its revision, so a re-link is
        // the conditional resurrection put. Without it the user's own mistake
        // would strand the relationship at an address nothing can write again.
        const { fixture, entryRef, linkTag } = await linkedFixture();
        await unlinkEntryFromSession({
            collections: fixture.collections,
            entryRef,
            sessionId: 'session-a',
        });

        expect(await linkEntryToSession({
            collections: fixture.collections,
            entryRef,
            display: TESTKIT_LINK_DISPLAY,
            sessionId: 'session-a',
            nowMs: NOW_MS + 1,
        })).toEqual({ status: 'linked', linkTag });
        expect((await fixture.collections.sessionLinks.get(linkTag))?.value)
            .toMatchObject({ linkedAtMs: NOW_MS + 1 });
    });

    it('reports a competing writer as a conflict the reader can re-read', async () => {
        const { fixture, entryRef, linkTag } = await linkedFixture();
        const base = fixture.collections.sessionLinks;

        expect(await unlinkEntryFromSession({
            collections: {
                sessionLinks: {
                    ...base,
                    // The concurrent commit lands inside the exact window the
                    // conditional delete exists to detect, and the real store
                    // raises the real `plugin_collection_conflict`.
                    async delete(rowId, options) {
                        fixture.control.sessionLinks.tombstone(linkTag);
                        return await base.delete(rowId, options);
                    },
                },
            },
            entryRef,
            sessionId: 'session-a',
        })).toEqual({ status: 'conflict', linkTag });
    });

    it('reports a refused storage delete as a failure rather than throwing', async () => {
        const { fixture, entryRef } = await linkedFixture();

        expect(await unlinkEntryFromSession({
            collections: {
                sessionLinks: {
                    ...fixture.collections.sessionLinks,
                    delete: async () => {
                        throw new Error('collection_unavailable');
                    },
                },
            },
            entryRef,
            sessionId: 'session-a',
        })).toEqual({ status: 'failed' });
    });
});
