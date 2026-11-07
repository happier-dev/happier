import { describe, expect, it } from 'vitest';
import { createTestkitCorpusCollections } from '../testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../testkit/observations.test-support.js';
import { readTaskOriginError, setTaskOriginError } from './setPinned.js';

describe('task origin intent at the user-mark owner', () => {
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
