import type { PluginCollectionUiQueryErrorV1 } from '@happier-dev/plugin-sdk/collections';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { CORPUS_SESSION_LINKS_FIELD } from '../../corpus/collections/ids.js';
import { MAX_TRIAGE_SESSION_LINKED_ENTRY_ROWS_V1 } from './linkedEntriesQuery.js';

/**
 * The Session cockpit's presentation projection.
 *
 * It is pure and owns no I/O: the Data pager owns the query, the cursor and the
 * AccountChange wakeups, and the hydration effect owns the private row reads.
 * What is decided here is only what the reader is told, and the two things that
 * decide it are both honesty rules:
 *
 * - a link is durable Account state, but the *entry* it points at is not stored
 *   anywhere. A link whose private row has not been read yet, has been unlinked
 *   underneath this page, or could not be read at all still occupies its row and
 *   says which of those it is. Dropping it would silently shrink a set the user
 *   committed to;
 * - absence is only ever reported from a settled page. An incomplete, loading,
 *   unavailable or failed page renders as itself, never as "nothing is linked".
 */

/** One private link row as the hydration effect last read it, at that revision. */
export type TriageSessionLinkHydrationV1 =
    | Readonly<{
        kind: 'ready';
        revision: number;
        displayPath: string;
        /**
         * The canonical reference the link was written from, carried exactly as
         * the private row holds it.
         *
         * Unlink is addressed by the entry AND the Session, and the mounted
         * surface knows only the Session. Taking it from the read this row was
         * already rendered from is what lets the reader undo a link they made by
         * mistake without a second private read, and without any surface
         * rebuilding a reference — a rebuilt one would address a different row.
         */
        entryRef: TriageEntryRefV1;
    }>
    /** The private row is no longer there: the link was removed under this page. */
    | Readonly<{ kind: 'unlinked'; revision: number }>
    /** The private read itself failed; nothing is known about this link's entry. */
    | Readonly<{ kind: 'unreadable'; revision: number }>;

export type TriageSessionLinkHydrationMapV1 = ReadonlyMap<string, TriageSessionLinkHydrationV1>;

/** The exact projected facts one pager row carries. Nothing private is here. */
export type TriageSessionLinkQueryRowV1 = Readonly<{
    /** The host-stamped row id: the list key and the private hydration address. */
    rowId: string;
    revision: number;
    fields: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type TriageSessionLinkedEntryPresentationV1 =
    | Readonly<{ kind: 'reading' }>
    | Readonly<{ kind: 'linked'; displayPath: string; entryRef: TriageEntryRefV1 }>
    | Readonly<{ kind: 'unlinked' }>
    | Readonly<{ kind: 'unreadable' }>;

export type TriageSessionLinkedEntryRowV1 = Readonly<{
    key: string;
    /** Our clock, from the plaintext projection; the presentation order only. */
    linkedAtMs: number;
    presentation: TriageSessionLinkedEntryPresentationV1;
}>;

/**
 * The Data-owned typed query failure code.
 *
 * Derived from the published error rather than restated, so a new code cannot
 * appear in the Data contract while this file still believes it knows them all.
 */
export type TriageSessionLinkedEntriesFailureCodeV1 = PluginCollectionUiQueryErrorV1['error'];

/**
 * Every state this projection can produce. It is deliberately query-derived
 * only: whether the mount addresses a Session at all is decided by the mounted
 * target before a query exists, so it is not a member here.
 */
export type TriageSessionLinkedEntriesViewV1 =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable'; message: string }>
    | Readonly<{ kind: 'empty' }>
    | Readonly<{
        kind: 'linked';
        rows: readonly TriageSessionLinkedEntryRowV1[];
        /** More links exist for this Session than this bounded page shows. */
        more: boolean;
        /** Why the shown rows may not be the current set; `null` when they are. */
        notice: string | null;
    }>;

export type TriageSessionLinkedEntriesQueryStateV1 = Readonly<{
    status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
    rows: readonly TriageSessionLinkQueryRowV1[];
    hasMore: boolean;
    /** The pager's typed failure code, or `null` for none / an untyped throw. */
    failure: TriageSessionLinkedEntriesFailureCodeV1 | null;
}>;

const UNREADABLE_MESSAGE = 'Linked PRs and issues could not be read.';

/**
 * One sentence per typed failure. The codes that mean "not ready yet" and
 * "not available for this Account" are deliberately different sentences: the
 * first resolves on its own and the second does not.
 */
function describeFailure(failure: TriageSessionLinkedEntriesFailureCodeV1 | null): string {
    switch (failure) {
        case 'collection_index_not_ready':
            return 'Linked PRs and issues are still being prepared for this account.';
        case 'collection_unavailable':
            return 'Linked PRs and issues are unavailable for this account right now.';
        case 'collection_content_mode_mismatch':
        case 'collection_contract_inconsistent':
            return 'Linked PRs and issues could not be read for this account.';
        default:
            return UNREADABLE_MESSAGE;
    }
}

function readLinkedAtMs(row: TriageSessionLinkQueryRowV1): number {
    const value = row.fields[CORPUS_SESSION_LINKS_FIELD.linkedAtMs];
    // A projected field that is not our clock is not a reason to drop a durable
    // link from the reader's list; it only loses its place in the order.
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function presentationFor(
    row: TriageSessionLinkQueryRowV1,
    hydration: TriageSessionLinkHydrationMapV1,
): TriageSessionLinkedEntryPresentationV1 {
    const known = hydration.get(row.rowId);
    // A hydration read at an older revision describes a row that has since
    // changed, so it is not presented as this row's current state.
    if (known === undefined || known.revision !== row.revision) return { kind: 'reading' };
    if (known.kind === 'ready') {
        return { kind: 'linked', displayPath: known.displayPath, entryRef: known.entryRef };
    }
    if (known.kind === 'unlinked') return { kind: 'unlinked' };
    return { kind: 'unreadable' };
}

/**
 * Newest link first, tie-broken by the host-stamped row id.
 *
 * The declared index orders by `sessionId` alone, so within one Session the
 * store's order is not a contract. Ordering here on the link's own clock keeps
 * a page from reshuffling between reads for reasons the reader cannot see.
 */
function compareRows(
    left: TriageSessionLinkedEntryRowV1,
    right: TriageSessionLinkedEntryRowV1,
): number {
    const byTime = right.linkedAtMs - left.linkedAtMs;
    if (byTime !== 0) return byTime;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

export function projectTriageSessionLinkedEntries(input: Readonly<{
    query: TriageSessionLinkedEntriesQueryStateV1;
    hydration: TriageSessionLinkHydrationMapV1;
}>): TriageSessionLinkedEntriesViewV1 {
    const { query, hydration } = input;
    const failed = query.status === 'unavailable' || query.status === 'error';

    if (query.rows.length === 0) {
        // Absence is only authoritative from a settled page.
        if (failed) return { kind: 'unavailable', message: describeFailure(query.failure) };
        return query.status === 'ready' ? { kind: 'empty' } : { kind: 'loading' };
    }

    const ordered = query.rows
        .map((row) => Object.freeze({
            key: row.rowId,
            linkedAtMs: readLinkedAtMs(row),
            presentation: presentationFor(row, hydration),
        }))
        .sort(compareRows);
    const bounded = ordered.slice(0, MAX_TRIAGE_SESSION_LINKED_ENTRY_ROWS_V1);

    return Object.freeze({
        kind: 'linked',
        rows: Object.freeze(bounded),
        more: query.hasMore || bounded.length < ordered.length,
        // Last-known-good rows stay on screen; the reason they may be stale is
        // said out loud rather than implied by their silence.
        notice: failed ? describeFailure(query.failure) : null,
    });
}

/** The row ids this page needs hydrated, in the exact bounded set it renders. */
export function triageSessionLinkHydrationTargets(
    query: TriageSessionLinkedEntriesQueryStateV1,
): readonly TriageSessionLinkQueryRowV1[] {
    return [...query.rows]
        .sort((left, right) => {
            const byTime = readLinkedAtMs(right) - readLinkedAtMs(left);
            if (byTime !== 0) return byTime;
            return left.rowId < right.rowId ? -1 : left.rowId > right.rowId ? 1 : 0;
        })
        .slice(0, MAX_TRIAGE_SESSION_LINKED_ENTRY_ROWS_V1);
}
