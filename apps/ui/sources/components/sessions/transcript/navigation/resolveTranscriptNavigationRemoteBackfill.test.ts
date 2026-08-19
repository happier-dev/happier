import { describe, expect, it } from 'vitest';

import {
    TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_MAX_PAGES,
    TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_USER_TURN_TARGET,
    shouldRequestTranscriptNavigationRemotePage,
} from './resolveTranscriptNavigationRemoteBackfill';

/**
 * The rail's target is about what NAVIGATION HOLDS, not about what it downloaded.
 *
 * Measured on device 2026-08-18: opening one session fetched and decrypted 630 raw
 * messages across 13 pages. Twelve of those were this backfill running to its page
 * ceiling — `MAX_PAGES` is 12 and the decrypt telemetry reported `older: 12` exactly —
 * while the transcript itself needed a single page. The rail's own entries are built from
 * the loaded window PLUS the remote rows, but the stop condition counted the remote rows
 * alone, so every turn the transcript had already loaded and already displays counted for
 * nothing and the backfill kept paging as if it held none of them.
 */

const baseInput = {
    hasMore: true,
    pagesLoaded: 0,
    loadedUserTurnCount: 0,
    remoteUserTurnCount: 0,
    hasVisibleConsumer: true,
} as const;

describe('transcript navigation remote backfill', () => {
    it('fetches nothing when no surface can display the result', () => {
        // The rail is hidden on native unconditionally (`deriveTranscriptNavigationRailLayout`
        // returns `hiddenReason: 'native-platform'`), and the phone cockpit reaches navigation
        // through a pane that mounts its own consumer when the reader opens it. So the
        // always-mounted transcript path on native was downloading and DECRYPTING up to twelve
        // pages of history for a surface that never appears — measured on device 2026-08-18 as
        // ~576 messages per cold open, on the JS thread, while the transcript was still painting.
        expect(shouldRequestTranscriptNavigationRemotePage({
            ...baseInput,
            hasVisibleConsumer: false,
        })).toBe(false);
    });

    it('does not page when the cursor is exhausted', () => {
        expect(shouldRequestTranscriptNavigationRemotePage({ ...baseInput, hasMore: false })).toBe(false);
    });

    it('stops at the page ceiling even when the turn target is unmet', () => {
        expect(shouldRequestTranscriptNavigationRemotePage({
            ...baseInput,
            pagesLoaded: TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_MAX_PAGES,
        })).toBe(false);
    });

    it('stops once the remote rows alone satisfy the target', () => {
        expect(shouldRequestTranscriptNavigationRemotePage({
            ...baseInput,
            remoteUserTurnCount: TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_USER_TURN_TARGET,
        })).toBe(false);
    });

    it('counts the turns the transcript already loaded, and fetches nothing when they suffice', () => {
        // The rail renders loaded turns and remote turns together, so a transcript window
        // that already holds the target has nothing to backfill. Downloading 60 more is
        // pure session-open cost for entries the rail was already going to show.
        expect(shouldRequestTranscriptNavigationRemotePage({
            ...baseInput,
            loadedUserTurnCount: TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_USER_TURN_TARGET,
        })).toBe(false);
    });

    it('counts loaded and remote turns together toward the target', () => {
        const half = Math.floor(TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_USER_TURN_TARGET / 2);
        // Short of the target between them: still worth a page.
        expect(shouldRequestTranscriptNavigationRemotePage({
            ...baseInput,
            loadedUserTurnCount: half - 1,
            remoteUserTurnCount: half - 1,
        })).toBe(true);
        // Together they clear it: stop.
        expect(shouldRequestTranscriptNavigationRemotePage({
            ...baseInput,
            loadedUserTurnCount: half,
            remoteUserTurnCount: TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_USER_TURN_TARGET - half,
        })).toBe(false);
    });
});
