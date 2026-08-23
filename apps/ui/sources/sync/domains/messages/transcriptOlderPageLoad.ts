/**
 * Canonical result contract for ONE older-transcript-page read.
 *
 * Every layer on the older-page path returns this exact shape — the sync readers, the
 * list shells that adapt them, and the pagination machine that consumes them — so a new
 * outcome cannot be added to one layer while the others keep collapsing it into a
 * neighbouring status. It previously lived as nine independently declared inline unions
 * that had to change in lockstep.
 *
 * Statuses:
 * - `loaded`: the read succeeded; `loaded` rows were applied and `hasMore` is authoritative.
 * - `no_more`: the read succeeded and reached the oldest row of this chain.
 * - `not_ready`: no read was attempted because a precondition (cursor, authority, scope)
 *   is not established yet. Not a failure, and not user-actionable.
 * - `in_flight`: another read for the same chain already owns the cursor.
 * - `retryable_error`: the read was ATTEMPTED and FAILED. Rows and the older cursor are
 *   retained unchanged, so the exact same read can be retried. This must never be
 *   reported as `loaded`: a zero-row success and a failed read are different facts, and
 *   collapsing them hides the failure from the reader and removes the retry.
 */
export type TranscriptOlderPageLoadStatus =
    | 'loaded'
    | 'no_more'
    | 'not_ready'
    | 'in_flight'
    | 'retryable_error';

export type TranscriptOlderPageLoadResult = Readonly<{
    loaded: number;
    hasMore: boolean;
    status: TranscriptOlderPageLoadStatus;
}>;
