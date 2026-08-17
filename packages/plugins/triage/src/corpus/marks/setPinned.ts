import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { CorpusCollectionsV1 } from '../collections/bindCorpusCollections.js';
import { fromCorpusStoredRow, toCorpusStoredValue } from '../collections/rowCodec.js';
import type { CorpusUserMarkDisplayV1, CorpusUserMarkRowV1 } from '../collections/rows.js';
import { deriveUserMarkTag } from '../identity/tags.js';

/**
 * The one canonical `user-marks` writer.
 *
 * Pin and Unpin are direct user actions on Account Collection data: there is no
 * confirmation ceremony, no optimistic second owner, no source Action, no
 * provider call and no mark-to-entry repair path. Because a mark is Collection
 * data, the pinned state survives client and daemon restarts, and it keeps
 * working while every daemon is offline as long as the Account server is
 * reachable.
 *
 * The mark's address is derived from the canonical entry reference alone, so
 * two devices that materialized the same entry independently — with different
 * titles, at different times, through different connections — address the one
 * row. Nothing about the pass that rendered the entry reaches the identity.
 *
 * Nothing provider-derived is stored beside it. A Pin copies only the two
 * display values a user needs to recognize and unpin what they pinned, supplied
 * by the caller from its own projection: there is no durable entry row to read,
 * and an entry that is not projected cannot be pinned because there is nothing
 * to name.
 */

export type CorpusSetPinnedResultV1 =
    | Readonly<{ status: 'pinned'; markTag: string }>
    | Readonly<{ status: 'unpinned'; markTag: string }>
    /** Another writer won; the caller reads current state rather than forcing one. */
    | Readonly<{ status: 'conflict'; markTag: string }>;

type MarkCollections = Pick<CorpusCollectionsV1, 'userMarks'>;

type SetPinnedCommonV1 = Readonly<{
    collections: MarkCollections;
    entryRef: TriageEntryRefV1;
    /** Our clock, supplied by the caller so the writer owns no ambient time. */
    nowMs: number;
    signal?: AbortSignal;
}>;

/**
 * Pin carries the projected facts; Unpin structurally cannot.
 *
 * That asymmetry is the contract: a Pin must name what it pinned, and an Unpin
 * must keep working for a pinned row no current pass materialized.
 */
export type CorpusSetPinnedInputV1 =
    | (SetPinnedCommonV1 & Readonly<{ pinned: true; displayAtMark: CorpusUserMarkDisplayV1 }>)
    | (SetPinnedCommonV1 & Readonly<{ pinned: false }>);

async function readLiveMark(
    collections: MarkCollections,
    markTag: string,
    options?: PluginCancellationOptions,
): Promise<Readonly<{ revision: number; value: CorpusUserMarkRowV1 }> | null> {
    const row = await collections.userMarks.get(markTag, options);
    // A deleted mark reads as `null`: a plugin cannot see its own tombstone.
    return row ? fromCorpusStoredRow<CorpusUserMarkRowV1>(row) : null;
}

async function putMark(
    collections: MarkCollections,
    mark: CorpusUserMarkRowV1,
    options?: PluginCancellationOptions,
): Promise<'written' | 'conflict'> {
    const value = toCorpusStoredValue(mark);
    const first = await collections.userMarks.batch(
        [{ kind: 'put', value, expectedRevision: 'absent' }],
        options,
    );
    if (first.status === 'updated') return 'written';

    const conflict = first.conflicts[0];
    // The one conditional resurrection this design allows: an explicit tombstone
    // carries no competing live content, so the same intent may be written once
    // against that exact revision. An `absent` put alone would lose the row
    // forever, while a general conflict retry could overwrite newer live state.
    if (!conflict || !conflict.deleted || conflict.revision === null) return 'conflict';
    const second = await collections.userMarks.batch(
        [{ kind: 'put', value, expectedRevision: conflict.revision }],
        options,
    );
    return second.status === 'updated' ? 'written' : 'conflict';
}

export async function setPinned(input: CorpusSetPinnedInputV1): Promise<CorpusSetPinnedResultV1> {
    const { collections, entryRef, nowMs } = input;
    const options = input.signal ? { signal: input.signal } : undefined;
    // Derived in the collection it addresses. A tag is never copied from one
    // collection to another, even when the components are identical.
    const markTag = await deriveUserMarkTag(collections.userMarks, entryRef, options);

    if (!input.pinned) {
        const existing = await readLiveMark(collections, markTag, options);
        // An already-absent mark is an idempotent success.
        if (!existing) return { status: 'unpinned', markTag };
        try {
            await collections.userMarks.delete(markTag, {
                expectedRevision: existing.revision,
                ...(input.signal ? { signal: input.signal } : {}),
            });
        } catch {
            return { status: 'conflict', markTag };
        }
        return { status: 'unpinned', markTag };
    }

    const existing = await readLiveMark(collections, markTag, options);
    // A live mark is idempotent: a repeat Pin never reorders the pinned section
    // and never overwrites the user's own mark with a later pass's rendering.
    if (existing?.value.pinned === true) return { status: 'pinned', markTag };

    const written = await putMark(collections, {
        markTag,
        pinned: true,
        markedAtMs: nowMs,
        entryRef,
        displayAtMark: input.displayAtMark,
    }, options);
    return written === 'written'
        ? { status: 'pinned', markTag }
        : { status: 'conflict', markTag };
}
