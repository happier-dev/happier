import { describe, expect, it } from 'vitest';

import {
    CORPUS_ACCOUNT_COLLECTIONS,
    CORPUS_SESSION_LINKS_COLLECTION,
    CORPUS_USER_MARKS_COLLECTION,
} from '../collections/definitions.js';
import type { CorpusSessionLinkRowV1, CorpusUserMarkRowV1 } from '../collections/rows.js';
import { setPinned } from '../marks/setPinned.js';
import { createTestkitCorpusCollections } from '../testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../testkit/observations.test-support.js';
import { deriveSessionLinkEntryTag, deriveSessionLinkTag, deriveUserMarkTag } from './tags.js';

const SECRET_SCOPE = 'octo/private-migration';
const SECRET_ITEM_NUMBER = '4242';
const SECRETS = [SECRET_SCOPE, SECRET_ITEM_NUMBER, 'private-migration'];

describe('E2EE durable disclosure', () => {
    it('never exposes a raw provider path or item number in an E2EE server record', async () => {
        const fixture = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const entryRef = testkitEntryRef({
            collisionScope: SECRET_SCOPE,
            entryId: SECRET_ITEM_NUMBER,
        });
        await setPinned({
            collections: fixture.collections,
            entryRef,
            pinned: true,
            displayAtMark: { title: `Fix ${SECRET_SCOPE}`, scopeLabel: SECRET_SCOPE },
            nowMs: 1_760_000_900_000,
        });
        const markTag = await deriveUserMarkTag(fixture.collections.userMarks, entryRef);
        const mark = (await fixture.collections.userMarks.get(markTag))?.value as unknown as CorpusUserMarkRowV1;
        const link: CorpusSessionLinkRowV1 = {
            linkTag: await deriveSessionLinkTag(fixture.collections.sessionLinks, entryRef, 'session-a'),
            entryTag: await deriveSessionLinkEntryTag(fixture.collections.sessionLinks, entryRef),
            sessionId: 'session-a',
            linkedAtMs: 1_760_000_900_000,
            cardPublicationId: 'publication-id-a',
            entryRef,
            identityEntryRef: entryRef,
            displayPathAtLink: `${SECRET_SCOPE} #${SECRET_ITEM_NUMBER}`,
        };

        // The row ids, the whole server-readable projection, and every declared
        // index value. Checking only the row id passes while the projection
        // leaks, so all three are asserted.
        const disclosed = [
            mark.markTag,
            link.linkTag,
            link.entryTag,
            ...CORPUS_USER_MARKS_COLLECTION.serverReadable.map((field) => String(mark[field as keyof typeof mark])),
            ...CORPUS_USER_MARKS_COLLECTION.indexes.flatMap((index) => index.fields.map(
                (field) => String(mark[field.field as keyof typeof mark]),
            )),
            ...CORPUS_SESSION_LINKS_COLLECTION.serverReadable.map((field) => String(link[field as keyof typeof link])),
            ...CORPUS_SESSION_LINKS_COLLECTION.indexes.flatMap((index) => index.fields.map(
                (field) => String(link[field.field as keyof typeof link]),
            )),
        ];

        for (const value of disclosed) {
            for (const secret of SECRETS) expect(value).not.toContain(secret);
        }
    });

    it('keeps every entry-identifying and display field out of the projection', () => {
        const contentBearing = new Set([
            'entryRef', 'identityEntryRef', 'displayAtMark', 'displayPathAtLink',
            'cardPublicationId', 'configured',
        ]);
        for (const definition of CORPUS_ACCOUNT_COLLECTIONS) {
            for (const field of definition.serverReadable) {
                expect(contentBearing.has(field)).toBe(false);
            }
            for (const index of definition.indexes) {
                for (const field of index.fields) {
                    expect(contentBearing.has(field.field)).toBe(false);
                }
            }
        }
    });
});
