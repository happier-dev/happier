import { isPluginError, PluginError, type PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { TriageEntryRefV1, TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';

import type { CorpusCollectionsV1 } from '../collections/bindCorpusCollections.js';
import { putCorpusRowOnce } from '../collections/putRowOnce.js';
import { fromCorpusStoredRow } from '../collections/rowCodec.js';
import type {
    CorpusFixPullRequestsV1,
    CorpusUserMarkDisplayV1,
    CorpusUserMarkRowV1,
} from '../collections/rows.js';
import { toCorpusStoredValue } from '../collections/rowCodec.js';
import { sameTriageEntryReference } from '../identity/components.js';
import { deriveUserMarkTag } from '../identity/tags.js';
import { isKnownNonPullRequestSubject } from './fixPullRequests.js';

/**
 * The one canonical `user-marks` writer: Pin/Unpin and the fix-PR choice
 * (`setFixPullRequest`, `design/FIX-LINK.md`) share this module because they
 * share the row, so the two concerns can never race each other inside it
 * through two writers that each think they own it.
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

/**
 * Rewrite a live mark at its read revision. `false` means another writer moved
 * the row in between, exactly as the store said; every other refusal is raised.
 */
async function rewriteLiveMark(
    collections: MarkCollections,
    revision: number,
    row: CorpusUserMarkRowV1,
    signal?: AbortSignal,
): Promise<boolean> {
    const result = await collections.userMarks.batch(
        [{ kind: 'put', value: toCorpusStoredValue(row), expectedRevision: revision }],
        signal ? { signal } : undefined,
    );
    return result.status === 'updated';
}

function withoutFixPullRequests(row: CorpusUserMarkRowV1): CorpusUserMarkRowV1 {
    const { fixPullRequests: _dropped, ...rest } = row;
    return rest;
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
        if (existing.value.pinned === false) return { status: 'unpinned', markTag };
        // The row also carries the reader's fix-PR choice. Unpin removes the
        // pin, never that choice, so the row stays live as `pinned: false`.
        if (existing.value.fixPullRequests !== undefined) {
            return await rewriteLiveMark(
                collections,
                existing.revision,
                { ...existing.value, pinned: false },
                input.signal,
            )
                ? { status: 'unpinned', markTag }
                : { status: 'conflict', markTag };
        }
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
    // A live unpinned mark that holds a fix-PR choice is pinned in place, keeping
    // the choice. A live unpinned mark WITHOUT one is not a state this writer
    // produces, so it stays a conflict rather than being overwritten.
    if (existing?.value.fixPullRequests !== undefined) {
        return await rewriteLiveMark(
            collections,
            existing.revision,
            { ...existing.value, pinned: true, markedAtMs: nowMs, displayAtMark: input.displayAtMark },
            input.signal,
        )
            ? { status: 'pinned', markTag }
            : { status: 'conflict', markTag };
    }

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

export type CorpusSetFixPullRequestResultV1 =
    | Readonly<{ status: 'linked' }>
    | Readonly<{ status: 'unlinked' }>
    /** Another writer moved the mark first; the caller re-reads rather than forcing. */
    | Readonly<{ status: 'conflict' }>;

/**
 * Link or unlink one fix pull request for the marked entry.
 *
 * - Link adds the PR to `linked` (replacing an earlier link to the same PR) and
 *   removes it from `dismissed`.
 * - Unlink removes it from `linked` and adds it to `dismissed`, so an unlink
 *   wins over a candidate a shared Session link implies. It never touches
 *   `session-links`: the Session still worked on that PR.
 *
 * Both carry the marked entry's own display pair, because the first fix-PR
 * choice on an unpinned entry creates its mark row and a mark must be nameable
 * on its own bytes. An existing row keeps its own `displayAtMark` and pin.
 * Durable choices are not relationship query pages: link and unlink preserve
 * all earlier intent rather than refusing or evicting it at a page boundary.
 */
export async function setFixPullRequest(input: Readonly<{
    collections: MarkCollections;
    entryRef: TriageEntryRefV1;
    displayAtMark: CorpusUserMarkDisplayV1;
    fixPullRequest: TriageEntryRefV1;
    /** Current admitted kind fact, supplied by the domain projection; absent stays unknown. */
    fixPullRequestWorkflowSubject?: TriageSourceWorkflowSubjectV1 | null;
    nowMs: number;
    signal?: AbortSignal;
}> & (
    | Readonly<{ linked: true; displayAtLink: CorpusUserMarkDisplayV1 }>
    | Readonly<{ linked: false }>
)): Promise<CorpusSetFixPullRequestResultV1> {
    if (input.linked && isKnownNonPullRequestSubject(input.fixPullRequestWorkflowSubject)) {
        throw new PluginError({ code: 'triage_fix_pull_request_kind_invalid', message: 'The selected entry is not a pull request.' });
    }
    const { collections, entryRef, fixPullRequest, nowMs } = input;
    const options = input.signal ? { signal: input.signal } : undefined;
    const markTag = await deriveUserMarkTag(collections.userMarks, entryRef, options);
    const existing = await readLiveMark(collections, markTag, options);

    const current: CorpusFixPullRequestsV1 = existing?.value.fixPullRequests ?? { linked: [], dismissed: [] };
    const isTarget = (ref: TriageEntryRefV1) => sameTriageEntryReference(ref, fixPullRequest);
    const linked = current.linked.filter((link) => !isTarget(link.entryRef));
    const dismissed = current.dismissed.filter((ref) => !isTarget(ref));
    const next: CorpusFixPullRequestsV1 = input.linked
        ? {
            linked: [...linked, { entryRef: fixPullRequest, displayAtLink: input.displayAtLink, linkedAtMs: nowMs }],
            dismissed,
        }
        : { linked, dismissed: [...dismissed, fixPullRequest] };
    const settled = input.linked ? { status: 'linked' as const } : { status: 'unlinked' as const };

    if (existing) {
        return await rewriteLiveMark(
            collections,
            existing.revision,
            { ...withoutFixPullRequests(existing.value), fixPullRequests: next },
            input.signal,
        )
            ? settled
            : { status: 'conflict' };
    }
    const written = await putCorpusRowOnce<CorpusUserMarkRowV1>({
        collection: collections.userMarks,
        rowId: markTag,
        row: {
            markTag,
            pinned: false,
            markedAtMs: nowMs,
            entryRef,
            displayAtMark: input.displayAtMark,
            fixPullRequests: next,
        },
        ...(input.signal ? { signal: input.signal } : {}),
    });
    return written.status === 'written' ? settled : { status: 'conflict' };
}
