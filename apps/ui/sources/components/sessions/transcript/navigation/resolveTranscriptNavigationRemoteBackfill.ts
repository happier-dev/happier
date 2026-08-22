/**
 * Whether the transcript navigation rail should pull another page of older history.
 *
 * Extracted from the inline effect in `useSessionTranscriptNavigationEntries` so the
 * policy has one owner and can be tested without a hook harness. The rail's backfill is
 * the single most expensive thing a session open does that the transcript itself does not
 * need — measured on device 2026-08-18, a cold open ran this to its 12-page ceiling and
 * decrypted ~576 messages the transcript never asked for, on the JS thread, while the user
 * waited for first paint.
 */

/** User turns the rail wants before it stops paging backwards. */
export const TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_USER_TURN_TARGET = 60;

/** Absolute page ceiling, so a session with sparse user turns cannot page forever. */
export const TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_MAX_PAGES = 12;

export type TranscriptNavigationRemoteBackfillInput = Readonly<{
    /** Whether the remote history cursor has more pages at all. */
    hasMore: boolean;
    /** Remote pages already fetched for this session. */
    pagesLoaded: number;
    /** User turns the transcript's own loaded window already provides to navigation. */
    loadedUserTurnCount: number;
    /** User turns fetched remotely by the backfill. */
    remoteUserTurnCount: number;
    /**
     * Whether any surface can actually display these entries right now.
     *
     * The rail is web-only (`isTranscriptNavigationRailSupportedPlatform`) and the phone
     * cockpit reaches navigation through a pane that mounts its own consumer on demand, so
     * the always-mounted transcript path on native has no viewer for this data at all.
     * Downloading and decrypting it there is pure session-open cost.
     */
    hasVisibleConsumer: boolean;
}>;

export function shouldRequestTranscriptNavigationRemotePage(
    input: TranscriptNavigationRemoteBackfillInput,
): boolean {
    if (!input.hasVisibleConsumer) return false;
    if (!input.hasMore) return false;
    if (input.pagesLoaded >= TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_MAX_PAGES) return false;
    // Loaded AND remote, because the rail renders both. Counting remote rows alone made
    // every turn the transcript had already loaded worth nothing to the stop condition, so
    // the backfill downloaded a full target's worth of history the rail was already able
    // to show.
    const heldUserTurnCount = Math.max(0, input.loadedUserTurnCount) + Math.max(0, input.remoteUserTurnCount);
    if (heldUserTurnCount >= TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_USER_TURN_TARGET) return false;
    return true;
}
