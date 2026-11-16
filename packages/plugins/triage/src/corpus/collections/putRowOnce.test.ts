import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { deriveUserMarkTag } from '../identity/tags.js';
import { createTestkitCorpusCollections } from '../testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../testkit/observations.test-support.js';
import type { CorpusCollectionHandleV1 } from './handles.js';
import { putCorpusRowOnce } from './putRowOnce.js';

describe('durable user-state CAS', () => {
    it('surfaces a second tombstone conflict without retrying over the newer revision', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const markTag = await deriveUserMarkTag(fixture.collections.userMarks, entryRef);
        fixture.control.userMarks.tombstone(markTag);
        const revisions: unknown[] = [];
        // Collection I/O is the boundary. The real store decides both conflicts;
        // another writer changes its tombstone during the resurrection request.
        const collection: CorpusCollectionHandleV1 = {
            ...fixture.collections.userMarks,
            async batch(operations, options) {
                revisions.push(operations[0]?.expectedRevision);
                if (revisions.length === 2) fixture.control.userMarks.tombstone(markTag);
                return fixture.collections.userMarks.batch(operations, options);
            },
        };

        expect(await putCorpusRowOnce({ collection, rowId: markTag, row: {
            markTag, entryRef, pinned: true, markedAtMs: 1,
            displayAtMark: { title: 'Own pin', scopeLabel: 'QA' },
        } })).toEqual({ status: 'conflict' });
        expect(revisions).toEqual(['absent', 1]);
        expect(fixture.control.userMarks.inspect(markTag)).toEqual({ revision: 2, deleted: true });
    });

    it('preserves an existing pin when storage refuses a new row for quota', async () => {
        const fixture = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const markTag = await deriveUserMarkTag(fixture.collections.userMarks, entryRef);
        const row = { markTag, entryRef, pinned: true, markedAtMs: 1,
            displayAtMark: { title: 'Keep this pin', scopeLabel: 'QA' } };
        fixture.control.userMarks.seed(row);
        const previous = await fixture.collections.userMarks.get(markTag);
        const nextEntryRef = testkitEntryRef({ entryId: 'quota-refused' });
        const nextTag = await deriveUserMarkTag(fixture.collections.userMarks, nextEntryRef);
        const refusal = new PluginError({ code: 'collection_quota_exceeded', message: 'Account Collection quota reached' });
        // The remote storage boundary rejects the request before mutation.
        const collection: CorpusCollectionHandleV1 = {
            ...fixture.collections.userMarks,
            async batch() { throw refusal; },
        };

        await expect(putCorpusRowOnce({ collection, rowId: nextTag,
            row: { ...row, markTag: nextTag, entryRef: nextEntryRef } })).rejects.toBe(refusal);
        expect(await fixture.collections.userMarks.get(markTag)).toEqual(previous);
        expect(await fixture.collections.userMarks.get(nextTag)).toBeNull();
    });
});
