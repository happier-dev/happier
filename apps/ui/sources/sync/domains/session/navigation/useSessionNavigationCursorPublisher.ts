/**
 * The one way an ordered session surface publishes the order it is showing.
 *
 * Every ordered surface — the session list, the archived screen, the recent screen — calls this
 * with the rows it actually renders. While the surface is active it keeps the cursor in step with
 * what is on screen; when it goes inactive it simply stops publishing, which is what freezes the
 * cursor at the order the user last saw. Nothing clears on the way out: the whole point is that
 * the last published order survives leaving the surface.
 *
 * A cursor is only replaced when the captured order actually differs, so a surface whose item
 * array is rebuilt for unrelated reasons neither re-stamps `capturedAtMs` nor wakes subscribers.
 * `items` should still be a memoized array — this is a cheap guard, not licence for churn.
 */

import * as React from 'react';

import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';

import {
    areSessionNavigationCursorsEquivalent,
    buildSessionNavigationCursor,
    type SessionNavigationCursorOrigin,
} from './sessionNavigationCursor';
import {
    clearSessionNavigationCursor,
    publishSessionNavigationCursor,
    readSessionNavigationCursor,
} from './sessionNavigationCursorStore';
import type { SessionListLikeItem } from './sessionNavigationOrder';

export function useSessionNavigationCursorPublisher(params: Readonly<{
    /** Whether this surface is the one the user is currently looking at. */
    active: boolean;
    origin: SessionNavigationCursorOrigin;
    sourceScopeKey: string;
    storageKind: SessionListStorageFilter;
    /** The rendered rows, in render order. Memoize it. */
    items: readonly SessionListLikeItem[] | null | undefined;
}>): void {
    const { active, origin, sourceScopeKey, storageKind, items } = params;

    React.useEffect(() => {
        if (!active) return;
        const cursor = buildSessionNavigationCursor({
            identity: { origin, sourceScopeKey, storageKind },
            items,
            nowMs: Date.now(),
        });
        if (!cursor) {
            // The active surface cannot support a step, so no order may claim to describe it.
            clearSessionNavigationCursor();
            return;
        }
        if (areSessionNavigationCursorsEquivalent(readSessionNavigationCursor(), cursor)) return;
        publishSessionNavigationCursor(cursor);
    }, [active, items, origin, sourceScopeKey, storageKind]);
}
