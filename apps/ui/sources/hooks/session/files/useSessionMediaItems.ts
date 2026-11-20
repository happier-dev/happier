import * as React from 'react';

import { sync } from '@/sync/sync';
import { useSessionMessages } from '@/sync/store/hooks';
import {
    collectSessionMediaItems,
    type SessionMediaGalleryItem,
} from '@/sync/domains/sessionMedia/collectSessionMediaItems';

const NO_MEDIA_ITEMS: readonly SessionMediaGalleryItem[] = Object.freeze([]);
// The transcript's own older-page load owns an in-flight request; wait for it to settle, then resume.
const IN_FLIGHT_RETRY_MS = 250;

/**
 * Session-wide media for the Files "Session" tab. The transcript only holds the newest pages until
 * the user scrolls up, so while the tab is presented this pages older history in through the
 * canonical `sync.loadOlderMessages` — but only until `limit` media items are available
 * (`null` = the whole history), so a long session is not pulled in until the user asks for it.
 * The subscription, the paging and the scan only exist while `enabled`, so the closed tab costs nothing.
 *
 * History counts as exhausted only when the loader confirms it. A page that is not ready or makes no
 * progress (the loader reports a failed request as `loaded: 0`) stops the automatic paging as a
 * stall instead of retrying in a loop; `retry` resumes it.
 */
export function useSessionMediaItems(sessionId: string, enabled: boolean, limit: number | null): Readonly<{
    items: readonly SessionMediaGalleryItem[];
    isLoaded: boolean;
    /** Older pages are still being fetched to satisfy `limit`. */
    isLoadingHistory: boolean;
    /** There is no older history left to fetch. */
    historyExhausted: boolean;
    /** Paging stopped without confirming the end of history; `retry` tries again. */
    historyStalled: boolean;
    retry: () => void;
}> {
    const { messages, isLoaded } = useSessionMessages(sessionId, { enabled });
    const [exhaustedFor, setExhaustedFor] = React.useState<string | null>(null);
    const [stalledFor, setStalledFor] = React.useState<string | null>(null);
    // Bumped after each page so the paging effect re-evaluates against the newly collected count.
    const [pageTick, setPageTick] = React.useState(0);

    const items = React.useMemo(
        () => (enabled ? collectSessionMediaItems(messages) : NO_MEDIA_ITEMS),
        [enabled, messages],
    );
    const historyExhausted = exhaustedFor === sessionId;
    const historyStalled = stalledFor === sessionId;
    const needsMore = enabled && isLoaded && !historyExhausted && !historyStalled
        && (limit === null || items.length < limit);

    React.useEffect(() => {
        if (!needsMore) return;
        let cancelled = false;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;

        const loadPage = async () => {
            const result = await sync.loadOlderMessages(sessionId).catch(() => null);
            if (cancelled) return;
            if (result?.status === 'in_flight') {
                retryTimer = setTimeout(() => { void loadPage(); }, IN_FLIGHT_RETRY_MS);
                return;
            }
            if (result?.status === 'no_more' || (result?.status === 'loaded' && !result.hasMore)) {
                setExhaustedFor(sessionId);
                return;
            }
            if (result?.status === 'loaded' && result.loaded > 0) {
                setPageTick((tick) => tick + 1);
                return;
            }
            // not_ready, a failed request, or a page that added nothing: do not loop on it.
            setStalledFor(sessionId);
        };
        void loadPage();

        return () => {
            cancelled = true;
            if (retryTimer !== null) clearTimeout(retryTimer);
        };
    }, [needsMore, sessionId, pageTick]);

    const retry = React.useCallback(() => setStalledFor(null), []);

    return { items, isLoaded, isLoadingHistory: needsMore, historyExhausted, historyStalled, retry };
}
