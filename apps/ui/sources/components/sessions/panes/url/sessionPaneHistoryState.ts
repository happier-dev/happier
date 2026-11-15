import { writeStoredSessionPaneUrlState } from './sessionPaneStoredState';
import { parseSessionPaneUrlState } from './sessionPaneUrlState';
import { createSessionPaneScopeId } from '../sessionPaneScopeId';

const SESSION_PANE_HISTORY_STATE_KEY = 'happierSessionPane';
let pendingHistoryStateWriteTimer: ReturnType<typeof setTimeout> | null = null;
let pendingHistoryTraversalLocationKey: string | null = null;
let historyTraversalSubscribers = 0;
let removeHistoryTraversalListener: (() => void) | null = null;

type SessionPaneHistoryState = Readonly<{
    scopeKey: string;
    urlSig: string;
}>;

function readCurrentLocationKey(): string | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const location = window.location;
    if (!location) {
        return null;
    }

    const pathname = location.pathname;
    const search = location.search;
    if (typeof pathname === 'string' || typeof search === 'string') {
        return `${pathname ?? ''}${search ?? ''}`;
    }

    if (typeof location.href === 'string') {
        try {
            const url = new URL(location.href);
            return `${url.pathname}${url.search}`;
        } catch {
            return location.href;
        }
    }

    return null;
}

function readCurrentUrl(): URL | null {
    const locationKey = readCurrentLocationKey();
    if (!locationKey || typeof window === 'undefined') {
        return null;
    }

    try {
        return new URL(window.location.href);
    } catch {
        return null;
    }
}

function readSessionScopeKeyFromCurrentLocation(): string | null {
    const url = readCurrentUrl();
    const pathname = url?.pathname ?? '';
    const match = pathname.match(/^\/session\/([^/?#]+)/);
    const sessionId = match?.[1];
    if (!sessionId) {
        return null;
    }

    const serverId = url?.searchParams.get('serverId') ?? null;
    try {
        return createSessionPaneScopeId(decodeURIComponent(sessionId), serverId);
    } catch {
        return createSessionPaneScopeId(sessionId, serverId);
    }
}

/** The same parser the pane URL fact reads, so "this location carries pane state" has one owner. */
function currentLocationHasExplicitPaneParams(): boolean {
    const url = readCurrentUrl();
    return url !== null && parseSessionPaneUrlState(Object.fromEntries(url.searchParams)) !== null;
}

function readHistoryStateRecord(): Record<string, unknown> | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const state = window.history?.state;
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return null;
    }

    return state as Record<string, unknown>;
}

export function primeSessionPaneHistoryTraversalTracking(): () => void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return () => {};
    }
    if (historyTraversalSubscribers === 0) {
        const targetWindow = window;
        const onPopState = () => {
            pendingHistoryTraversalLocationKey = readCurrentLocationKey();
            const scopeKey = readSessionScopeKeyFromCurrentLocation();
            if (scopeKey && !currentLocationHasExplicitPaneParams()) {
                writeStoredSessionPaneUrlState(scopeKey, null);
            }
        };
        targetWindow.addEventListener('popstate', onPopState);
        removeHistoryTraversalListener = () => targetWindow.removeEventListener?.('popstate', onPopState);
    }
    historyTraversalSubscribers += 1;
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        historyTraversalSubscribers -= 1;
        if (historyTraversalSubscribers !== 0) return;
        removeHistoryTraversalListener?.();
        removeHistoryTraversalListener = null;
        pendingHistoryTraversalLocationKey = null;
        if (pendingHistoryStateWriteTimer !== null) clearTimeout(pendingHistoryStateWriteTimer);
        pendingHistoryStateWriteTimer = null;
    };
}

export function consumeSessionPaneHistoryTraversalForCurrentLocation(): boolean {
    const currentLocationKey = readCurrentLocationKey();
    if (!currentLocationKey || pendingHistoryTraversalLocationKey !== currentLocationKey) {
        return false;
    }

    pendingHistoryTraversalLocationKey = null;
    return true;
}

export function readCurrentSessionPaneHistoryState(scopeKey: string): SessionPaneHistoryState | null {
    const state = readHistoryStateRecord();
    const raw = state?.[SESSION_PANE_HISTORY_STATE_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }

    const rawScopeKey = (raw as Record<string, unknown>).scopeKey;
    const rawUrlSig = (raw as Record<string, unknown>).urlSig;
    if (rawScopeKey !== scopeKey || typeof rawUrlSig !== 'string') {
        return null;
    }

    return {
        scopeKey,
        urlSig: rawUrlSig,
    };
}

export function writeCurrentSessionPaneHistoryState(nextState: SessionPaneHistoryState): void {
    if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') {
        return;
    }

    const currentState = readHistoryStateRecord() ?? {};
    const currentMarker = readCurrentSessionPaneHistoryState(nextState.scopeKey);
    if (currentMarker?.urlSig === nextState.urlSig) {
        return;
    }

    window.history.replaceState(
        {
            ...currentState,
            [SESSION_PANE_HISTORY_STATE_KEY]: nextState,
        },
        '',
        window.location?.href ?? undefined
    );
}

export function scheduleCurrentSessionPaneHistoryState(nextState: SessionPaneHistoryState): void {
    const run = () => {
        pendingHistoryStateWriteTimer = null;
        writeCurrentSessionPaneHistoryState(nextState);
    };

    if (pendingHistoryStateWriteTimer !== null) {
        clearTimeout(pendingHistoryStateWriteTimer);
    }

    if (typeof setTimeout === 'function') {
        pendingHistoryStateWriteTimer = setTimeout(run, 0);
        return;
    }

    Promise.resolve()
        .then(run)
        .catch(() => {});
}
