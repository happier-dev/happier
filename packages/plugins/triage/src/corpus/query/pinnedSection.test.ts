import { describe, expect, it } from 'vitest';

import { deriveUserMarkTag } from '../identity/tags.js';
import { setPinned } from '../marks/setPinned.js';
import {
    createTestkitCorpusCollections,
    type TestkitCorpusCollections,
} from '../testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../testkit/observations.test-support.js';
import { readPinnedSection } from './pinnedSection.js';

async function seedPin(
    fixture: TestkitCorpusCollections,
    entryId: string,
    markedAtMs: number,
): Promise<string> {
    const entryRef = testkitEntryRef({ entryId });
    await setPinned({
        collections: fixture.collections,
        entryRef,
        pinned: true,
        displayAtMark: { title: `entry ${entryId}`, scopeLabel: 'example/repository' },
        nowMs: markedAtMs,
    });
    return await deriveUserMarkTag(fixture.collections.userMarks, entryRef);
}

describe('readPinnedSection', () => {
    it('pages the pinned section on the mark cursor, newest mark first', async () => {
        const fixture = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        await seedPin(fixture, '1', 1_000);
        await seedPin(fixture, '2', 2_000);
        await seedPin(fixture, '3', 3_000);

        const first = await readPinnedSection({ collections: fixture.collections, limit: 2 });
        expect(first.marks.map((mark) => mark.entryRef.entryId)).toEqual(['3', '2']);
        expect(first.nextCursor).toBeDefined();

        const second = await readPinnedSection({
            collections: fixture.collections,
            limit: 2,
            ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
        });
        // No duplicate and no skip: the marks query owns the cursor.
        expect(second.marks.map((mark) => mark.entryRef.entryId)).toEqual(['1']);
        expect(second.nextCursor).toBeUndefined();
    });

    it('returns a pinned row no pass materialized instead of dropping it', async () => {
        const fixture = createTestkitCorpusCollections();
        const markTag = await seedPin(fixture, '7', 1_000);

        const page = await readPinnedSection({ collections: fixture.collections, limit: 10 });

        // Nothing else was ever stored for this entry, so the mark alone must
        // render a nameable, unpinnable row.
        expect(page.marks).toHaveLength(1);
        expect(page.marks[0]).toMatchObject({
            markTag,
            entryRef: testkitEntryRef({ entryId: '7' }),
            displayAtMark: { title: 'entry 7', scopeLabel: 'example/repository' },
        });
    });

    it('issues no per-row read while paging the pinned section', async () => {
        // A hydrate-in-render implementation passes every visual check and
        // re-reads on every frame; the budget is asserted, not assumed.
        const fixture = createTestkitCorpusCollections();
        await seedPin(fixture, '1', 1_000);
        await seedPin(fixture, '2', 2_000);
        const before = fixture.control.userMarks.getCallCount();

        await readPinnedSection({ collections: fixture.collections, limit: 10 });
        await readPinnedSection({ collections: fixture.collections, limit: 10 });

        expect(fixture.control.userMarks.getCallCount()).toBe(before);
    });
});
