import { isPluginError, type PluginCancellationOptions } from '@happier-dev/plugin-sdk';

import { isHostCancellation } from '../hostCancellation.js';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import { CORPUS_SESSION_LINKS_INDEX_ID } from '../corpus/collections/ids.js';
import { fromCorpusStoredRow, toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../corpus/collections/rows.js';
import { deriveSessionLinkEntryTag, deriveSessionLinkTag } from '../corpus/identity/tags.js';

/**
 * The one durable effect an authoritative `merged(successor)` observation has.
 *
 * A Session link is a user commitment, and a provider merge must not strand it
 * on a predecessor nobody will open again. So when a source answers that the
 * entry it was asked about has become another one — and names that direct
 * successor in the same authoritative invocation — the links pointing at the
 * predecessor are moved onto the successor, in place.
 *
 * "In place" is the whole design. The row keeps its `linkTag`, so its address
 * never moves: that address is derived from the immutable `identityEntryRef`,
 * which is why that field exists at all. It keeps its `sessionId`, its
 * `linkedAtMs` and its `displayPathAtLink`, which is what the row renders from
 * until a live materialization supplies fresher facts. Only the projected
 * `entryTag` and the private current `entryRef` move.
 *
 * What it deliberately is not:
 *
 * - **Not a redirect, alias or chain.** Nothing here stores a predecessor edge,
 *   follows a successor's own successor, or rewrites a read. The only trace of
 *   the predecessor is the row-local `identityEntryRef` the row id was always
 *   derived from, and it is not queryable continuity history.
 * - **Not a pin writer.** `corpus/marks/setPinned.ts` is the single `user-marks`
 *   writer. A pin on a merged predecessor keeps rendering from its own
 *   `displayAtMark` and the person can unpin it or pin the successor; retargeting
 *   it here would buy one automatic hop and cost a second writer of a user's own
 *   fact.
 * - **Not a job.** There is no queue, watermark or background pass. It runs
 *   inside the observation that produced the evidence, and it is idempotent:
 *   a retry rereads the predecessor index, finds what remains, and moves it.
 */

export type CorpusReconcileMergedSuccessorInputV1 = Readonly<{
    collections: Pick<CorpusCollectionsV1, 'sessionLinks'>;
    /** The entry the source was asked about and reported as merged away. */
    entryRef: TriageEntryRefV1;
    /** The qualified direct successor that same authoritative observation named. */
    successorEntryRef: TriageEntryRefV1;
    signal?: AbortSignal;
}>;

export type CorpusReconcileMergedSuccessorResultV1 =
    /** No link remains on the predecessor. */
    | Readonly<{ status: 'reconciled' }>
    /**
     * Links remain on the predecessor because the store refused or lost a
     * conditional write. They stay exactly where the next authoritative merge
     * observation will find them; nothing is retried here, and nothing is
     * half-moved — each row moves whole or not at all.
     */
    | Readonly<{ status: 'incomplete' }>;

const RECONCILED: CorpusReconcileMergedSuccessorResultV1 = Object.freeze({ status: 'reconciled' });
const INCOMPLETE: CorpusReconcileMergedSuccessorResultV1 = Object.freeze({ status: 'incomplete' });

export async function reconcileMergedSuccessor(
    input: CorpusReconcileMergedSuccessorInputV1,
): Promise<CorpusReconcileMergedSuccessorResultV1> {
    const sessionLinks = input.collections.sessionLinks;
    const options: PluginCancellationOptions | undefined = input.signal
        ? { signal: input.signal }
        : undefined;

    const predecessorEntryTag = await deriveSessionLinkEntryTag(sessionLinks, input.entryRef, options);
    const successorEntryTag = await deriveSessionLinkEntryTag(sessionLinks, input.successorEntryRef, options);
    // A source that named the observed entry as its own successor has reported no
    // discontinuity. Moving those rows would write them straight back into the
    // index this walk rereads, so there would be no last page.
    if (predecessorEntryTag === successorEntryTag) return RECONCILED;

    try {
        // The predecessor index is the work list, and a moved or collapsed row
        // leaves it. Rereading from the start is therefore the whole paging
        // strategy: it needs no cursor, and it is what makes a retry pick up
        // exactly the rows a previous attempt could not move.
        for (;;) {
            const page = await sessionLinks.query({
                index: CORPUS_SESSION_LINKS_INDEX_ID.byEntry,
                prefix: [predecessorEntryTag],
                order: 'asc',
            }, options);
            if (page.rows.length === 0) return RECONCILED;

            let moved = 0;
            for (const stored of page.rows) {
                const row = fromCorpusStoredRow<CorpusSessionLinkRowV1>(stored);
                if (await moveOneLink(sessionLinks, row.revision, row.value, {
                    successorEntryRef: input.successorEntryRef,
                    successorEntryTag,
                }, options)) {
                    moved += 1;
                }
            }
            // Every row in the page lost its conditional write. The set cannot
            // shrink by rereading it, so this pass is over.
            if (moved === 0) return INCOMPLETE;
        }
    } catch (error) {
        // The Collection store is a network-backed boundary; a refusal there is
        // a fact about the store, and the links stay where a retry finds them.
        // Anything else — an abort, or a defect in this module — is not a store
        // answer and must not be reported as one.
        //
        // Cancellation is checked FIRST and deliberately: the host rejects a
        // cancelled call with a real `PluginError` too, so the `isPluginError`
        // arm below would otherwise swallow it and report `incomplete` — a
        // settled store outcome for a read that never finished. The caller
        // stopped asking and learned nothing; saying otherwise invents an answer
        // nobody received. This comment previously promised the behaviour the
        // code did not have.
        if (isHostCancellation(error, input.signal)) throw error;
        if (isPluginError(error)) return INCOMPLETE;
        throw error;
    }
}

/**
 * Moves one link row onto the successor, or collapses it.
 *
 * If the same Session already holds its own successor link, that separate row is
 * the relationship the person can see, and keeping both would show one Session
 * two links to the same entry. The predecessor row is tombstoned instead — the
 * successor row it collapses into is untouched, so its publication identity and
 * its own link time survive.
 */
async function moveOneLink(
    sessionLinks: CorpusCollectionsV1['sessionLinks'],
    revision: number,
    row: CorpusSessionLinkRowV1,
    successor: Readonly<{ successorEntryRef: TriageEntryRefV1; successorEntryTag: string }>,
    options?: PluginCancellationOptions,
): Promise<boolean> {
    const successorLinkTag = await deriveSessionLinkTag(
        sessionLinks,
        successor.successorEntryRef,
        row.sessionId,
        options,
    );
    if (successorLinkTag !== row.linkTag && await sessionLinks.get(successorLinkTag, options) !== null) {
        const collapsed = await sessionLinks.batch(
            [{ kind: 'delete', rowId: row.linkTag, expectedRevision: revision }],
            options,
        );
        return collapsed.status === 'updated';
    }

    const retargeted: CorpusSessionLinkRowV1 = {
        ...row,
        entryTag: successor.successorEntryTag,
        entryRef: successor.successorEntryRef,
    };
    const written = await sessionLinks.batch(
        [{ kind: 'put', value: toCorpusStoredValue(retargeted), expectedRevision: revision }],
        options,
    );
    return written.status === 'updated';
}
