import { describe, expect, it } from 'vitest';

import { CORPUS_USER_MARKS_INDEX_ID } from '../collections/ids.js';
import type { CorpusUserMarkRowV1 } from '../collections/rows.js';
import { deriveUserMarkTag } from '../identity/tags.js';
import {
    createTestkitCorpusCollections,
    testkitAccountMaterial,
    type TestkitCorpusCollections,
} from '../testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../testkit/observations.test-support.js';
import { setPinned } from './setPinned.js';

const DISPLAY = { title: 'Replace the duplicated normalizer', scopeLabel: 'example/repository' } as const;

async function liveMarks(fixture: TestkitCorpusCollections): Promise<readonly CorpusUserMarkRowV1[]> {
    const page = await fixture.collections.userMarks.query({
        index: CORPUS_USER_MARKS_INDEX_ID.byPinned,
        prefix: [true],
        order: 'asc',
    });
    return page.rows.map((row) => row.value as unknown as CorpusUserMarkRowV1);
}

describe('setPinned', () => {
    it('pins from the supplied projected facts alone, with no durable entry row anywhere', async () => {
        const fixture = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const entryRef = testkitEntryRef();

        const result = await setPinned({
            collections: fixture.collections,
            entryRef,
            pinned: true,
            displayAtMark: DISPLAY,
            nowMs: 1_760_000_900_000,
        });

        const markTag = await deriveUserMarkTag(fixture.collections.userMarks, entryRef);
        expect(result).toEqual({ status: 'pinned', markTag });
        expect((await fixture.collections.userMarks.get(markTag))?.value).toEqual({
            markTag,
            pinned: true,
            markedAtMs: 1_760_000_900_000,
            entryRef,
            displayAtMark: DISPLAY,
        });
    });

    it('addresses one mark row for one entry reference even when a later pass renders it differently', async () => {
        // The failure this excludes: a second device refreshes, sees a fresher
        // title, and its Pin lands on a second row — so the user now has two
        // pins for one entry and unpinning removes only one of them.
        const fixture = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const entryRef = testkitEntryRef();
        await setPinned({
            collections: fixture.collections,
            entryRef,
            pinned: true,
            displayAtMark: DISPLAY,
            nowMs: 1_000,
        });

        const repeat = await setPinned({
            collections: fixture.collections,
            // Structurally equal, independently constructed: nothing device-local
            // or object-identity-based may reach the row address.
            entryRef: { ...testkitEntryRef() },
            pinned: true,
            displayAtMark: { title: 'Replace the duplicated normalizer (updated)', scopeLabel: 'example/repository' },
            nowMs: 9_000,
        });

        const markTag = await deriveUserMarkTag(fixture.collections.userMarks, entryRef);
        expect(repeat).toEqual({ status: 'pinned', markTag });
        const marks = await liveMarks(fixture);
        expect(marks).toHaveLength(1);
        // A live mark is idempotent: the pinned section never reorders and the
        // user's own first display is not overwritten by a later pass.
        expect(marks[0]).toMatchObject({ markTag, markedAtMs: 1_000, displayAtMark: DISPLAY });
    });

    it('derives the same mark address from the same Account material in a fresh process', async () => {
        // A tag that did not survive a restart would strand the pin at an
        // unreachable id: it would still be listed, and it could never be
        // unpinned.
        const entryRef = testkitEntryRef();
        const material = testkitAccountMaterial(7);
        const before = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee', material });
        const after = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee', material });

        const pinned = await setPinned({
            collections: before.collections,
            entryRef,
            pinned: true,
            displayAtMark: DISPLAY,
            nowMs: 1_000,
        });

        expect(pinned).toEqual({
            status: 'pinned',
            markTag: await deriveUserMarkTag(after.collections.userMarks, entryRef),
        });
    });

    it('unpins with no projected facts at all and re-pins over the mark tombstone', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const markTag = await deriveUserMarkTag(fixture.collections.userMarks, entryRef);
        await setPinned({
            collections: fixture.collections,
            entryRef,
            pinned: true,
            displayAtMark: DISPLAY,
            nowMs: 1_000,
        });

        // Unpin needs nothing but the mark, so it stays available for a pinned
        // row that no current pass materialized.
        expect(await setPinned({ collections: fixture.collections, entryRef, pinned: false, nowMs: 2_000 }))
            .toEqual({ status: 'unpinned', markTag });
        expect(fixture.control.userMarks.inspect(markTag)?.deleted).toBe(true);

        // Unpinning twice is an idempotent success, not a conflict.
        expect(await setPinned({ collections: fixture.collections, entryRef, pinned: false, nowMs: 3_000 }))
            .toEqual({ status: 'unpinned', markTag });

        // Re-pinning must resurrect the mark against its tombstone revision: an
        // `absent` put alone would conflict forever.
        expect(await setPinned({
            collections: fixture.collections,
            entryRef,
            pinned: true,
            displayAtMark: DISPLAY,
            nowMs: 4_000,
        })).toEqual({ status: 'pinned', markTag });
        expect((await fixture.collections.userMarks.get(markTag))?.value).toMatchObject({
            pinned: true,
            markedAtMs: 4_000,
        });
    });

    it('reports a conflict instead of overwriting a newer live mark revision', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const markTag = await deriveUserMarkTag(fixture.collections.userMarks, entryRef);
        // Another writer already owns a live mark row this writer has not read.
        fixture.control.userMarks.seed({
            markTag,
            pinned: false,
            markedAtMs: 5,
            entryRef,
            displayAtMark: { title: 'stale', scopeLabel: 'stale' },
        });

        expect(await setPinned({
            collections: fixture.collections,
            entryRef,
            pinned: true,
            displayAtMark: DISPLAY,
            nowMs: 6,
        })).toEqual({ status: 'conflict', markTag });
    });
});
