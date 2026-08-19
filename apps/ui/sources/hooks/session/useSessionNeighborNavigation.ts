/**
 * The single seam between the frozen session-navigation cursor and any input that wants to move
 * to the neighbouring session — a lateral swipe, an accessibility action, anything later.
 *
 * It answers three questions and owns nothing else: where the current route sits in the captured
 * order, which entries sit either side of it, and what happened when a step was asked for. The
 * cursor itself, the walk, and the navigate are each owned elsewhere; this hook only wires them
 * to the live route.
 *
 * The virtual cursor is why two swipes in a row move two sessions. `router.navigate` returns
 * before the route reports the new session, so a second step that re-read the route would anchor
 * on the session the user already left and oscillate. The hook therefore anchors on the last
 * entry it stepped to until the route catches up, and drops back to the route the moment the
 * user leaves the stepping chain by any other means.
 */

import * as React from 'react';
import { useLocalSearchParams, usePathname } from 'expo-router';

import { readSessionIdFromPathname } from '@/components/sessions/shell/readSessionIdFromPathname';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import {
    resolveSessionNavigationCursorStep,
    type SessionNavigationCursorOrigin,
} from '@/sync/domains/session/navigation/sessionNavigationCursor';
import {
    readSessionNavigationCursor,
    useSessionNavigationCursor,
} from '@/sync/domains/session/navigation/sessionNavigationCursorStore';
import {
    findVisibleSessionNavigationEntryByScope,
    type SessionNavigationDirection,
    type VisibleSessionNavigationEntry,
} from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { getStorage } from '@/sync/domains/state/storageStore';

import { readSessionRouteServerId } from './sessionRouteServerScope';
import { useNavigateToSession } from './useNavigateToSession';

export type SessionNeighborNavigationStep =
    | Readonly<{ kind: 'target'; entry: VisibleSessionNavigationEntry }>
    /** The captured order has no further entry in that direction. */
    | Readonly<{ kind: 'edge' }>
    /** There is no captured order, or the current route is not part of it. */
    | Readonly<{ kind: 'unavailable' }>;

export type SessionNeighborNavigation = Readonly<{
    previousEntry: VisibleSessionNavigationEntry | null;
    nextEntry: VisibleSessionNavigationEntry | null;
    step: (direction: SessionNavigationDirection) => SessionNeighborNavigationStep;
}>;

/**
 * Whether a captured entry can still be opened. A cache miss is deliberately not treated as
 * evidence that the session is gone — the session maps are list-scoped caches, not a record of
 * what exists — so only a positive deletion, a hidden system session, or an archived session
 * removes an entry from the walk. The archived screen captures archived sessions on purpose, so
 * a cursor from that surface keeps them.
 */
function isSessionNavigationEntryNavigable(
    entry: VisibleSessionNavigationEntry,
    origin: SessionNavigationCursorOrigin | null,
): boolean {
    const state = getStorage().getState();
    if (state.deletedSessionIds[entry.sessionId] === true) return false;
    const record = state.sessions[entry.sessionId] ?? state.sessionListRenderables[entry.sessionId] ?? null;
    if (!record) return true;
    if (!isUserFacingSession(record)) return false;
    if (origin !== 'archived' && record.archivedAt != null) return false;
    return true;
}

export function useSessionNeighborNavigation(): SessionNeighborNavigation {
    const cursor = useSessionNavigationCursor();
    const pathname = usePathname();
    const routeParams = useLocalSearchParams();
    const navigateToSession = useNavigateToSession();

    const routeSessionId = React.useMemo(() => readSessionIdFromPathname(pathname), [pathname]);
    const routeServerId = readSessionRouteServerId(routeParams as Record<string, unknown>);

    const routeAnchorSessionKey = React.useMemo(() => {
        if (!cursor || !routeSessionId) return null;
        return findVisibleSessionNavigationEntryByScope(cursor.entries, routeSessionId, routeServerId)?.sessionKey
            ?? null;
    }, [cursor, routeServerId, routeSessionId]);

    // Rendered previews read the state copy; `step` reads the ref so two steps inside one tick
    // still see the first one's target.
    const [virtualCursorSessionKey, setVirtualCursorSessionKeyState] = React.useState<string | null>(null);
    const virtualCursorSessionKeyRef = React.useRef<string | null>(null);
    const steppedSessionKeysRef = React.useRef<Set<string>>(new Set());
    const routeAnchorSessionKeyRef = React.useRef<string | null>(routeAnchorSessionKey);
    routeAnchorSessionKeyRef.current = routeAnchorSessionKey;

    const resetVirtualCursor = React.useCallback(() => {
        virtualCursorSessionKeyRef.current = null;
        steppedSessionKeysRef.current = new Set();
        setVirtualCursorSessionKeyState(null);
    }, []);

    React.useEffect(() => {
        if (virtualCursorSessionKeyRef.current === null) return;
        if (routeAnchorSessionKey === null) return;
        // Still catching up with a step this hook made; keep the virtual cursor ahead of the route.
        if (steppedSessionKeysRef.current.has(routeAnchorSessionKey)) return;
        resetVirtualCursor();
    }, [resetVirtualCursor, routeAnchorSessionKey]);

    // A replaced cursor is a different captured order; nothing about the old walk carries over.
    React.useEffect(() => {
        resetVirtualCursor();
    }, [cursor, resetVirtualCursor]);

    const cursorOrigin = cursor?.identity.origin ?? null;
    const isEntryNavigable = React.useCallback(
        (entry: VisibleSessionNavigationEntry) => isSessionNavigationEntryNavigable(entry, cursorOrigin),
        [cursorOrigin],
    );

    const step = React.useCallback((direction: SessionNavigationDirection): SessionNeighborNavigationStep => {
        const result = resolveSessionNavigationCursorStep({
            cursor: readSessionNavigationCursor(),
            anchorSessionKey: virtualCursorSessionKeyRef.current ?? routeAnchorSessionKeyRef.current,
            direction,
            isEntryNavigable,
        });
        if (result.kind !== 'target') return result;

        virtualCursorSessionKeyRef.current = result.cursorSessionKey;
        steppedSessionKeysRef.current.add(result.cursorSessionKey);
        setVirtualCursorSessionKeyState(result.cursorSessionKey);
        void navigateToSession(
            result.entry.sessionId,
            result.entry.serverId ? { serverId: result.entry.serverId } : undefined,
        );
        return { kind: 'target', entry: result.entry };
    }, [isEntryNavigable, navigateToSession]);

    const anchorSessionKey = virtualCursorSessionKey ?? routeAnchorSessionKey;
    const previousEntry = React.useMemo(() => {
        const result = resolveSessionNavigationCursorStep({
            cursor,
            anchorSessionKey,
            direction: 'previous',
            isEntryNavigable,
        });
        return result.kind === 'target' ? result.entry : null;
    }, [anchorSessionKey, cursor, isEntryNavigable]);
    const nextEntry = React.useMemo(() => {
        const result = resolveSessionNavigationCursorStep({
            cursor,
            anchorSessionKey,
            direction: 'next',
            isEntryNavigable,
        });
        return result.kind === 'target' ? result.entry : null;
    }, [anchorSessionKey, cursor, isEntryNavigable]);

    return React.useMemo(
        () => ({ previousEntry, nextEntry, step }),
        [nextEntry, previousEntry, step],
    );
}
