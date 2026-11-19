import { describe, expect, it } from 'vitest';
import { createTestkitCorpusCollections } from '../testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../testkit/observations.test-support.js';
import { readAdmittedReview, setAdmittedReview, setPinned } from './setPinned.js';

describe('the admitted Review relation at the user-mark owner', () => {
    it('refuses an empty Review ID without changing the mark', async () => {
        const { collections } = createTestkitCorpusCollections();
        const input = { collections, entryRef: testkitEntryRef(),
            displayAtMark: { title: 'Pull request 17', scopeLabel: 'example/repository' }, nowMs: 10 };
        await setPinned({ ...input, pinned: true });
        const before = (await collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows;

        await expect(setAdmittedReview({ ...input, admittedReview: { reviewId: '', roundOrdinal: 1 } }))
            .rejects.toMatchObject({ code: 'triage_admitted_review_id_invalid' });
        expect((await collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows).toEqual(before);
    });

    it.each(['plain', 'e2ee'] as const)('keeps the latest admitted Review and round beside pin intent (%s)', async accountEncryptionMode => {
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode });
        const entryRef = testkitEntryRef();
        const input = { collections, entryRef, displayAtMark: { title: 'Pull request 17', scopeLabel: 'example/repository' }, nowMs: 10 };

        expect(await readAdmittedReview({ collections, entryRef })).toBeNull();
        expect(await setAdmittedReview({ ...input, admittedReview: { reviewId: 'review-1', roundOrdinal: 1 } })).toEqual({ status: 'linked' });
        expect(await setPinned({ ...input, pinned: true })).toMatchObject({ status: 'pinned' });
        expect(await setPinned({ ...input, pinned: false })).toMatchObject({ status: 'unpinned' });
        expect(await readAdmittedReview({ collections, entryRef })).toEqual({ reviewId: 'review-1', roundOrdinal: 1 });

        // A new round of the same Review and a different Review each replace the relation; replaying the same receipt writes nothing.
        const before = (await collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows;
        await setAdmittedReview({ ...input, admittedReview: { reviewId: 'review-1', roundOrdinal: 1 }, nowMs: 20 });
        expect((await collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows).toEqual(before);
        await setAdmittedReview({ ...input, admittedReview: { reviewId: 'review-1', roundOrdinal: 2 }, nowMs: 30 });
        expect(await readAdmittedReview({ collections, entryRef })).toEqual({ reviewId: 'review-1', roundOrdinal: 2 });
    });
});
