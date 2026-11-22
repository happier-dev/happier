import { describe, expect, it } from 'vitest';
import { TriageReviewSkipV1Schema } from '@happier-dev/triage-protocol/v1';
import { deriveUserMarkTag } from '../identity/tags.js';
import { toCorpusStoredValue } from '../collections/rowCodec.js';
import { createTestkitCorpusCollections } from '../testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../testkit/observations.test-support.js';
import { readAdmittedReview, readReviewOutcome, setAdmittedReview, setPinned, setReviewSkip } from './setPinned.js';

describe('the admitted Review relation at the user-mark owner', () => {
    it('reads a retained skip through the current detail contract and replaces it with an admitted Review', async () => {
        const { collections } = createTestkitCorpusCollections();
        const entryRef = testkitEntryRef();
        const displayAtMark = { title: 'Pull request 17', scopeLabel: 'example/repository' };
        const reviewSkip = { headSha: 'a'.repeat(40), reason: 'baseRef' as const, occurrence: { baseRef: 'feature/relay-v2' },
            rules: { baseRefs: ['main'], baseRevision: 'b'.repeat(40), inlineThreshold: 'low' as const,
                provenance: { baseRefs: 'baseCommit' as const, inlineThreshold: 'baseCommit' as const } } };
        const markTag = await deriveUserMarkTag(collections.userMarks, entryRef);
        await collections.userMarks.batch([{ kind: 'put', expectedRevision: 'absent', value: toCorpusStoredValue({
            markTag, pinned: true, markedAtMs: 10, entryRef, displayAtMark, reviewSkip,
        }) }]);

        const outcome = await readReviewOutcome({ collections, entryRef });
        expect(TriageReviewSkipV1Schema.parse(outcome.reviewSkip)).toEqual({ ...reviewSkip,
            rules: { baseRefs: ['main'], baseRevision: 'b'.repeat(40), provenance: { baseRefs: 'baseCommit' } } });
        await setAdmittedReview({ collections, entryRef, displayAtMark, nowMs: 20,
            admittedReview: { reviewId: 'review-1', roundOrdinal: 1 } });
        expect(await readReviewOutcome({ collections, entryRef })).toEqual({ admittedReview: { reviewId: 'review-1', roundOrdinal: 1 } });
        expect((await collections.userMarks.get(markTag))?.value).toMatchObject({ pinned: true });
    });

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

    it.each(['plain', 'e2ee'] as const)('keeps the latest skipped Review until a Review is admitted (%s)', async accountEncryptionMode => {
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode });
        const entryRef = testkitEntryRef();
        const input = { collections, entryRef, displayAtMark: { title: 'Pull request 17', scopeLabel: 'example/repository' }, nowMs: 10 };
        const skip = { headSha: 'a'.repeat(40), reason: 'baseRef' as const, occurrence: { baseRef: 'feature/relay-v2' },
            rules: { baseRefs: ['main'], baseRevision: 'b'.repeat(40), provenance: { baseRefs: 'baseCommit' as const } },
            automationId: 'automation-1' };

        expect(await readReviewOutcome({ collections, entryRef })).toEqual({});
        expect(await setReviewSkip({ ...input, reviewSkip: skip })).toEqual({ status: 'linked' });
        expect(await setPinned({ ...input, pinned: true })).toMatchObject({ status: 'pinned' });
        expect(await readReviewOutcome({ collections, entryRef })).toEqual({ reviewSkip: skip });

        const draft = { ...skip, headSha: 'c'.repeat(40), reason: 'draft' as const, occurrence: {} };
        await setReviewSkip({ ...input, reviewSkip: draft, nowMs: 20 });
        expect(await readReviewOutcome({ collections, entryRef })).toEqual({ reviewSkip: draft });

        await setAdmittedReview({ ...input, admittedReview: { reviewId: 'review-1', roundOrdinal: 1 }, nowMs: 30 });
        expect(await readReviewOutcome({ collections, entryRef })).toEqual({ admittedReview: { reviewId: 'review-1', roundOrdinal: 1 } });
        expect(await readAdmittedReview({ collections, entryRef })).toEqual({ reviewId: 'review-1', roundOrdinal: 1 });
    });
});
