import { describe, expect, it } from 'vitest';
import { createTestkitCorpusCollections } from '../testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../testkit/observations.test-support.js';
import { readTaskOriginError, readTaskOriginReview, setPinned, setTaskOriginError, setTaskOriginReview } from './setPinned.js';

describe('task origin intent at the user-mark owner', () => {
    it.each(['plain', 'e2ee'] as const)('preserves selected Review references through pin, unpin and error unlink (%s)', async accountEncryptionMode => {
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode });
        const entryRef = testkitEntryRef();
        const originReview = { reviewId: 'review-1', findingIds: ['finding-1', 'finding-2'] };
        const input = { collections, entryRef, displayAtMark: { title: 'Fix selected findings', scopeLabel: 'Tasks' }, nowMs: 10 };
        expect(await setTaskOriginReview({ ...input, originReview })).toEqual({ status: 'linked' });
        expect(await setPinned({ ...input, pinned: true })).toMatchObject({ status: 'pinned' });
        expect(await setPinned({ ...input, pinned: false })).toMatchObject({ status: 'unpinned' });
        const originError = { entryRef: { ...entryRef, kindId: 'error' }, display: input.displayAtMark };
        await setTaskOriginError({ ...input, originError });
        await setTaskOriginError({ ...input, originError: null });
        expect(await readTaskOriginReview({ collections, entryRef })).toEqual(originReview);
        const before = (await collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows;
        await setTaskOriginReview({ ...input, originReview, nowMs: 20 });
        expect((await collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows).toEqual(before);
        expect(await setTaskOriginReview({ ...input, originReview: null })).toEqual({ status: 'unlinked' });
        expect((await collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows).toEqual([]);
    });
    it.each(['plain', 'e2ee'] as const)('publishes only changed intent and deletes the last relationship (%s)', async (accountEncryptionMode) => {
        const { collections } = createTestkitCorpusCollections({ accountEncryptionMode });
        const entryRef = testkitEntryRef();
        const originError = { entryRef: { ...entryRef, kindId: 'error' }, display: { title: 'Checkout failed', scopeLabel: 'Production' } };
        const input = { collections, entryRef, displayAtMark: { title: 'Fix checkout', scopeLabel: 'Tasks' }, originError, nowMs: 10 };
        expect(await setTaskOriginError(input)).toEqual({ status: 'linked' });
        const before = (await collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows;
        await setTaskOriginError({ ...input, nowMs: 20 });
        expect((await collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows).toEqual(before);
        const changed = { ...originError, entryRef: { ...originError.entryRef, collisionScope: 'another-project' } };
        await setTaskOriginError({ ...input, originError: changed, nowMs: 30 });
        expect(await readTaskOriginError({ collections, entryRef })).toEqual(changed);
        await setTaskOriginError({ ...input, originError: null, nowMs: 40 });
        expect((await collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows).toEqual([]);
        expect(await readTaskOriginError({ collections, entryRef })).toBeNull();
    });
});
