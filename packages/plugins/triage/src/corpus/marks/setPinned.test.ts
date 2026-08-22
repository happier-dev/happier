import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import type { CorpusCollectionsV1 } from '../collections/bindCorpusCollections.js';
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

/**
 * A second writer that commits between this call's read and its `absent` put.
 *
 * The Collection is a network-backed store and therefore a genuine system
 * boundary; this wraps that boundary to land a concurrent commit inside the
 * exact window the CAS put exists to detect. Nothing internal is stubbed — the
 * real in-memory store answers both writes.
 */
function racingCollection(
    base: CorpusCollectionsV1['userMarks'],
    commitFirst: () => void,
): CorpusCollectionsV1['userMarks'] {
    let raced = false;
    return {
        ...base,
        async batch(operations, options) {
            if (!raced) {
                raced = true;
                commitFirst();
            }
            return await base.batch(operations, options);
        },
    };
}

/**
 * A second writer that commits between Unpin's read and its conditional delete.
 *
 * Same boundary, same reason as `racingCollection`: the store is a network-backed
 * system boundary, so the concurrent commit is landed inside the exact window the
 * `expectedRevision` delete exists to detect. The real in-memory store raises the
 * real `plugin_collection_conflict` `PluginError` the host raises.
 */
function racingDeleteCollection(
    base: CorpusCollectionsV1['userMarks'],
    commitFirst: () => void,
): CorpusCollectionsV1['userMarks'] {
    let raced = false;
    return {
        ...base,
        async delete(rowId, options) {
            if (!raced) {
                raced = true;
                commitFirst();
            }
            return await base.delete(rowId, options);
        },
    };
}

/** The store answering an Unpin with a refusal that is not a revision conflict. */
function refusingDeleteCollection(
    base: CorpusCollectionsV1['userMarks'],
    error: unknown,
): CorpusCollectionsV1['userMarks'] {
    return {
        ...base,
        async delete() {
            throw error;
        },
    };
}

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

    it('reports the pin that another device committed in the same window, not a failure', async () => {
        // The race: two devices pin one entry, and the loser's `absent` put
        // conflicts with a live row that is already the pin it wanted. Telling
        // that reader "That pin was changed somewhere else" — the warning the
        // surface shows for `conflict` — is false twice over: nothing they can
        // act on changed, and the pin they asked for exists.
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const markTag = await deriveUserMarkTag(fixture.collections.userMarks, entryRef);
        const userMarks = racingCollection(fixture.collections.userMarks, () => {
            fixture.control.userMarks.seed({
                markTag,
                pinned: true,
                markedAtMs: 5,
                entryRef,
                displayAtMark: { title: 'Pinned on the other device', scopeLabel: 'example/repository' },
            });
        });

        expect(await setPinned({
            collections: { userMarks },
            entryRef,
            pinned: true,
            displayAtMark: DISPLAY,
            nowMs: 6,
        })).toEqual({ status: 'pinned', markTag });
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

    it('reports a conflict only when the store says another writer moved the mark revision', async () => {
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

        // Another device re-pins between this Unpin's read and its delete, so the
        // revision this call holds is stale and the store refuses it.
        const userMarks = racingDeleteCollection(fixture.collections.userMarks, () => {
            fixture.control.userMarks.seed({
                markTag,
                pinned: true,
                markedAtMs: 2_000,
                entryRef,
                displayAtMark: { title: 'Re-pinned on the other device', scopeLabel: 'example/repository' },
            });
        });

        expect(await setPinned({ collections: { userMarks }, entryRef, pinned: false, nowMs: 3_000 }))
            .toEqual({ status: 'conflict', markTag });
        // The mark the other device committed is still live: a lost race never
        // removes the row it did not own.
        expect(fixture.control.userMarks.inspect(markTag)?.deleted).toBe(false);
    });

    it('surfaces an Unpin refusal that is not a revision conflict as itself', async () => {
        // The failure this excludes: the store is unreachable, the write is
        // refused for good, and the reader is told their pin "was changed
        // somewhere else" and offered a retry that cannot succeed. The mounted
        // control reads a rejection as "your account could not be reached" and
        // says so, which is the only honest answer here.
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        await setPinned({
            collections: fixture.collections,
            entryRef,
            pinned: true,
            displayAtMark: DISPLAY,
            nowMs: 1_000,
        });
        const unavailable = new PluginError({
            code: 'plugin_account_storage_unavailable',
            message: 'Account plugin data storage is unavailable',
        });
        const userMarks = refusingDeleteCollection(fixture.collections.userMarks, unavailable);

        await expect(setPinned({ collections: { userMarks }, entryRef, pinned: false, nowMs: 2_000 }))
            .rejects.toBe(unavailable);
    });
});
