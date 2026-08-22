import { isPluginError, type PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { CorpusCollectionsV1 } from '../collections/bindCorpusCollections.js';
import { putCorpusRowOnce } from '../collections/putRowOnce.js';
import { fromCorpusStoredRow } from '../collections/rowCodec.js';
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
    /**
     * Another writer won, as the store itself said; the caller reads current
     * state rather than forcing one. It is never a store failure wearing this
     * word — those are raised.
     */
    | Readonly<{ status: 'conflict'; markTag: string }>;

/** The one store code that means a competing writer, not a broken write. */
const COLLECTION_CONFLICT_CODE = 'plugin_collection_conflict';

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
        } catch (error) {
            // `conflict` means exactly one thing — the store refused this delete
            // because another writer moved the mark's revision. Every other
            // refusal, and an abort or an unreachable store, surfaces as itself:
            // folding them all into `conflict` tells the reader their pin changed
            // somewhere else and to retry, when the write is in fact refused for
            // a reason retrying cannot resolve. The mounted control already reads
            // a rejection as "your account could not be reached" and says so.
            if (isPluginError(error) && error.code === COLLECTION_CONFLICT_CODE) {
                return { status: 'conflict', markTag };
            }
            throw error;
        }
        return { status: 'unpinned', markTag };
    }

    const existing = await readLiveMark(collections, markTag, options);
    // A live mark is idempotent: a repeat Pin never reorders the pinned section
    // and never overwrites the user's own mark with a later pass's rendering.
    if (existing?.value.pinned === true) return { status: 'pinned', markTag };

    const written = await putCorpusRowOnce<CorpusUserMarkRowV1>({
        collection: collections.userMarks,
        rowId: markTag,
        row: {
            markTag,
            pinned: true,
            markedAtMs: nowMs,
            entryRef,
            displayAtMark: input.displayAtMark,
        },
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (written.status === 'written') return { status: 'pinned', markTag };
    // Another device pinned the same entry inside this call's window. The mark it
    // committed is the one this call wanted, so reporting a conflict would tell
    // the reader their Pin failed while the pin is on screen. Only a live row
    // that is not a pin is a real conflict — a live mark is always pinned, so
    // that is a contract check rather than a second unpinned state.
    if (written.status === 'live') {
        return written.row.value.pinned === true
            ? { status: 'pinned', markTag }
            : { status: 'conflict', markTag };
    }
    return { status: 'conflict', markTag };
}
