import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollection } from '@happier-dev/plugin-sdk/collections';
import type { StorageService } from '@happier-dev/plugin-sdk/storage';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { TRIAGE_PLUGIN } from '../manifest.js';
import { CORPUS_USER_MARKS_COLLECTION } from '../corpus/collections/definitions.js';
import { deriveUserMarkTag } from '../corpus/identity/tags.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';
import {
    TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
    TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
    TriageListPinnedEntriesResultV1Schema,
    TriageSetEntryPinnedResultV1Schema,
} from './userMarksProtocol.js';

type Collection = PluginAccountCollection<Readonly<Record<string, JsonValue>>>;
type Mutation = Parameters<Collection['batch']>[0][number];

async function withRegisteredMarks(
    run: (fixture: Readonly<{
        plugin: Awaited<ReturnType<typeof createPluginTestkit>>;
        corpus: ReturnType<typeof createTestkitCorpusCollections>;
        writes: Readonly<{ collection: string; operations: readonly Mutation[] }>[];
        beforeBatch: (callback: (operations: readonly Mutation[]) => void) => void;
    }>) => Promise<void>,
) {
    const corpus = createTestkitCorpusCollections();
    const writes: { collection: string; operations: readonly Mutation[] }[] = [];
    let beforeBatch = (_operations: readonly Mutation[]) => {};
    // Account Collection I/O is the genuine remote-store boundary. The canonical
    // testkit retains real schema validation, identity derivation and CAS.
    const storage = { account: { collection: (definition: { id: string }) => {
        if (definition.id !== CORPUS_USER_MARKS_COLLECTION.id) {
            // Binding the three declared handles is harmless; accessing another
            // Collection during a marks journey is a competing-state edit/read.
            return new Proxy({}, { get() { throw new Error(`Unexpected Collection I/O: ${definition.id}`); } });
        }
        const base = corpus.watchableCollections.userMarks;
        return {
            ...base,
            async batch(operations: readonly Mutation[], options?: Parameters<Collection['batch']>[1]) {
                writes.push({ collection: definition.id, operations });
                beforeBatch(operations);
                return base.batch(operations, options);
            },
            async delete(rowId: string, options: Parameters<Collection['delete']>[1]) {
                writes.push({ collection: definition.id, operations: [{ kind: 'delete', rowId, expectedRevision: options.expectedRevision }] });
                return base.delete(rowId, options);
            },
        };
    } } } as unknown as StorageService;
    const plugin = await createPluginTestkit({ manifest: TRIAGE_PLUGIN.manifest, module: TRIAGE_PLUGIN, services: { storage } });
    try {
        await run({ plugin, corpus, writes, beforeBatch: callback => { beforeBatch = callback; } });
    } finally { await plugin.dispose(); }
}

const entryRef = testkitEntryRef({ kindId: 'issue', entryId: 'cas-user-choice' });
const displayAtMark = { title: 'Preserve my durable choice', scopeLabel: 'example/repository' };
const options = { surface: 'agent' as const };

describe('registered durable user-state CAS', () => {
    it('carries each read revision and returns a conflict without compensating another Collection', async () => {
        await withRegisteredMarks(async ({ plugin, corpus, writes, beforeBatch }) => {
            // Dismissing a fix PR produces a real unpinned relationship mark;
            // this durable choice requires no current provider observation.
            expect(await plugin.invokeAction(TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1, {
                v: 1, linked: false, entryRef, displayAtMark,
                fixPullRequest: testkitEntryRef(),
            }, options)).toEqual({ v: 1, status: 'unlinked' });
            const markTag = await deriveUserMarkTag(corpus.collections.userMarks, entryRef);
            const relationship = await corpus.collections.userMarks.get(markTag);
            expect(relationship).not.toBeNull();
            writes.length = 0;

            expect(TriageSetEntryPinnedResultV1Schema.parse(await plugin.invokeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
                { v: 1, entryRef, pinned: true, displayAtMark }, options))).toEqual({ v: 1, status: 'pinned' });
            expect(writes).toEqual([{ collection: CORPUS_USER_MARKS_COLLECTION.id,
                operations: [expect.objectContaining({ kind: 'put', expectedRevision: relationship!.revision })] }]);
            const pinned = await corpus.collections.userMarks.get(markTag);
            expect(pinned?.value).toMatchObject({ pinned: true, fixPullRequests: relationship!.value.fixPullRequests });
            writes.length = 0;
            beforeBatch(() => { corpus.control.userMarks.seed(pinned!.value); });

            expect(TriageSetEntryPinnedResultV1Schema.parse(await plugin.invokeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
                { v: 1, entryRef, pinned: false }, options))).toEqual({ v: 1, status: 'conflict' });
            expect(writes).toEqual([{ collection: CORPUS_USER_MARKS_COLLECTION.id,
                operations: [expect.objectContaining({ kind: 'put', expectedRevision: pinned!.revision })] }]);
            expect((await corpus.collections.userMarks.get(markTag))?.value).toEqual(pinned!.value);
            expect(TriageListPinnedEntriesResultV1Schema.parse(await plugin.invokeAction(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
                { v: 1, limit: 10 }, options)).pins).toEqual([expect.objectContaining({ entryRef, displayAtMark })]);
        });
    });

    it.each([false, true])('conditionally resurrects an explicit tombstone once; second conflict = %s', async secondConflict => {
        await withRegisteredMarks(async ({ plugin, corpus, writes, beforeBatch }) => {
            expect(await plugin.invokeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
                { v: 1, entryRef, pinned: true, displayAtMark }, options)).toEqual({ v: 1, status: 'pinned' });
            expect(await plugin.invokeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
                { v: 1, entryRef, pinned: false }, options)).toEqual({ v: 1, status: 'unpinned' });
            const markTag = await deriveUserMarkTag(corpus.collections.userMarks, entryRef);
            const tombstone = corpus.control.userMarks.inspect(markTag);
            expect(tombstone).toEqual({ revision: 2, deleted: true });
            writes.length = 0;
            beforeBatch(() => {
                if (secondConflict && writes.length === 2) corpus.control.userMarks.tombstone(markTag);
            });

            expect(TriageSetEntryPinnedResultV1Schema.parse(await plugin.invokeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
                { v: 1, entryRef, pinned: true, displayAtMark }, options)))
                .toEqual({ v: 1, status: secondConflict ? 'conflict' : 'pinned' });
            expect(writes).toEqual([
                { collection: CORPUS_USER_MARKS_COLLECTION.id, operations: [expect.objectContaining({ kind: 'put', expectedRevision: 'absent' })] },
                { collection: CORPUS_USER_MARKS_COLLECTION.id, operations: [expect.objectContaining({ kind: 'put', expectedRevision: tombstone!.revision })] },
            ]);
            expect(corpus.control.userMarks.inspect(markTag)).toEqual({ revision: 3, deleted: secondConflict });
            expect(TriageListPinnedEntriesResultV1Schema.parse(await plugin.invokeAction(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
                { v: 1, limit: 10 }, options)).pins).toEqual(secondConflict ? [] : [expect.objectContaining({ entryRef, displayAtMark })]);
        });
    });

    it('preserves the existing pin and exposes collection_quota_exceeded to the registered caller', async () => {
        await withRegisteredMarks(async ({ plugin, corpus, writes, beforeBatch }) => {
            expect(await plugin.invokeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
                { v: 1, entryRef, pinned: true, displayAtMark }, options)).toEqual({ v: 1, status: 'pinned' });
            const markTag = await deriveUserMarkTag(corpus.collections.userMarks, entryRef);
            const retained = await corpus.collections.userMarks.get(markTag);
            const pinsBefore = await plugin.invokeAction(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1, { v: 1, limit: 10 }, options);
            writes.length = 0;
            beforeBatch(() => { throw new PluginError({ code: 'collection_quota_exceeded', message: 'Account Collection quota reached' }); });
            await expect(plugin.invokeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
                { v: 1, entryRef: testkitEntryRef({ entryId: 'quota-refused' }), pinned: true, displayAtMark }, options))
                .rejects.toMatchObject({ code: 'collection_quota_exceeded' });
            expect(writes).toEqual([{ collection: CORPUS_USER_MARKS_COLLECTION.id,
                operations: [expect.objectContaining({ kind: 'put', expectedRevision: 'absent' })] }]);
            expect(await corpus.collections.userMarks.get(markTag)).toEqual(retained);
            expect(await plugin.invokeAction(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1, { v: 1, limit: 10 }, options)).toEqual(pinsBefore);
        });
    });
});
