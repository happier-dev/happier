/**
 * Tail-reset discontinuity state for a session's MAIN message chain.
 *
 * `tail_reset_latest_page` catch-up (see `applyMessageCatchUpDecision`) merges only the
 * newest page on top of whatever was already materialized. When the previously loaded
 * prefix does not touch the new island, the loaded set becomes non-contiguous — a state
 * the single monotone-min `beforeSeq` cursor cannot represent (live defect 2026-07-12:
 * scroll-up paged below the OLD prefix while the gap stayed missing forever).
 *
 * This record makes the discontinuity explicit:
 * - `walkCursor` is the older-fetch cursor of the hole-fill walk. Everything at or above
 *   it is contiguous with the live tail; it is also the transcript's display floor so the
 *   stale prefix is never glued onto the tail.
 * - `prefixMaxSeq` is the top of the pre-gap contiguous prefix. When the walk reaches it,
 *   the discontinuity closes and the preserved monotone-min cursor resumes (it still
 *   points below the prefix — no skipped range, no redundant refetch).
 *
 * Stacked resets (another large gap while a hole is still open) keep the DEEPEST prefix:
 * the walk restarts from the newest island and must bridge all the way down. Intermediate
 * islands are re-covered by the walk via the seq-merge dedupe.
 */
export type SessionMessagesTailDiscontinuity = Readonly<{
    prefixMaxSeq: number;
    walkCursor: number;
}>;

function normalizeSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    return Math.trunc(value);
}

export function openTailDiscontinuityFromSnapshot(params: Readonly<{
    prev: SessionMessagesTailDiscontinuity | null;
    prefixMaxSeq: number;
    snapshotMinSeq: number;
}>): SessionMessagesTailDiscontinuity | null {
    const prefixMaxSeq = normalizeSeq(params.prefixMaxSeq);
    const snapshotMinSeq = normalizeSeq(params.snapshotMinSeq);
    // No prior materialized content: the snapshot IS the contiguous suffix.
    if (prefixMaxSeq == null || snapshotMinSeq == null) return params.prev;
    // Contiguous or overlapping snapshot: nothing new opens; an already-open walk keeps
    // its state (a snapshot at the island head does not bridge the existing hole).
    if (snapshotMinSeq <= prefixMaxSeq + 1) return params.prev;

    return {
        prefixMaxSeq: params.prev ? params.prev.prefixMaxSeq : prefixMaxSeq,
        walkCursor: snapshotMinSeq,
    };
}

export function applyTailDiscontinuityOlderPage(params: Readonly<{
    prev: SessionMessagesTailDiscontinuity;
    pageMinSeq: number | null;
    nextBeforeSeq: number | null;
}>): SessionMessagesTailDiscontinuity | null {
    const pageMinSeq = normalizeSeq(params.pageMinSeq);
    const nextBeforeSeq = normalizeSeq(params.nextBeforeSeq);
    // Empty terminal page: nothing exists below the walk cursor any more (server-side
    // truncation or purge). The hole cannot be filled, so close the NETWORK walk. The
    // caller intentionally retains the canonical discontinuity record and its last
    // contiguous display floor; network exhaustion is not evidence that a stale
    // materialized prefix became contiguous.
    if (pageMinSeq == null && nextBeforeSeq == null) return null;

    const candidate = Math.min(pageMinSeq ?? Number.POSITIVE_INFINITY, nextBeforeSeq ?? Number.POSITIVE_INFINITY);
    const walkCursor = Math.min(params.prev.walkCursor, candidate);
    if (walkCursor <= params.prev.prefixMaxSeq + 1) return null;
    if (walkCursor === params.prev.walkCursor) return params.prev;
    return { prefixMaxSeq: params.prev.prefixMaxSeq, walkCursor };
}
