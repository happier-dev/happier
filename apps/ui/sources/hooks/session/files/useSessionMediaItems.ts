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
 */
export function useSessionMediaItems(sessionId: string, enabled: boolean, limit: number | null): Readonly<{
    items: readonly SessionMediaGalleryItem[];
    isLoaded: boolean;
    /** Older pages are still being fetched to satisfy `limit`. */
    isLoadingHistory: boolean;
    /** There is no older history left to fetch. */
    historyExhausted: boolean;
}> {
    const { messages, isLoaded } = useSessionMessages(sessionId, { enabled });
    const [exhaustedFor, setExhaustedFor] = React.useState<string | null>(null);
    // Bumped after each page so the paging effect re-evaluates against the newly collected count.
    const [pageTick, setPageTick] = React.useState(0);

    const items = React.useMemo(
        () => (enabled ? collectSessionMediaItems(messages) : NO_MEDIA_ITEMS),
        [enabled, messages],
    );
    const historyExhausted = exhaustedFor === sessionId;
    const needsMore = enabled && !historyExhausted && (limit === null || items.length < limit);

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
            if (result?.status === 'loaded' && result.hasMore) {
                setPageTick((tick) => tick + 1);
                return;
            }
            // no_more, not_ready or a failed load: show what the transcript holds.
            setExhaustedFor(sessionId);
        };
        void loadPage();

        return () => {
            cancelled = true;
            if (retryTimer !== null) clearTimeout(retryTimer);
        };
    }, [needsMore, sessionId, pageTick]);

    return { items, isLoaded, isLoadingHistory: needsMore, historyExhausted };
}
