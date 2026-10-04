import * as React from 'react';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';

const REVIEW_TAB_KEY = 'scmReview:working';
const SCROLL_PERSIST_DEBOUNCE_MS = 250;
const SCROLL_PERSIST_EPSILON_PX = 1;

function scrollPositionsEqual(previous: unknown, next: unknown): boolean {
    if (Object.is(previous, next)) return true;
    if (typeof previous !== 'number' || typeof next !== 'number') return false;
    return Number.isFinite(previous) && Number.isFinite(next) && Math.abs(previous - next) < SCROLL_PERSIST_EPSILON_PX;
}

function valuesEqual(key: string, previous: unknown, next: unknown): boolean {
    if (key === 'scrollTop') return scrollPositionsEqual(previous, next);
    if (Object.is(previous, next)) return true;
    if (Array.isArray(previous) || Array.isArray(next)) {
        const before = Array.isArray(previous) ? previous : [];
        const after = Array.isArray(next) ? next : [];
        return before.length === after.length && before.every((value, index) => Object.is(value, after[index]));
    }
    return false;
}

/** Both live and captured Files preserve the existing review tab's scroll and collapse state. */
export function useSessionScmReviewTabState(sessionId: string, pane: ReturnType<typeof useAppPaneScope>) {
    const raw = pane.scopeState?.details?.tabState?.[REVIEW_TAB_KEY];
    const persistedReviewTabState = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const initialStateRef = React.useRef<Readonly<{ sessionId: string; scrollTop: number | null; collapsedPaths: string[] | null }> | null>(null);
    if (!initialStateRef.current || initialStateRef.current.sessionId !== sessionId) {
        const scrollTop = persistedReviewTabState?.scrollTop;
        const collapsedPaths = persistedReviewTabState?.collapsedPaths;
        initialStateRef.current = { sessionId,
            scrollTop: typeof scrollTop === 'number' && Number.isFinite(scrollTop) ? scrollTop : null,
            collapsedPaths: Array.isArray(collapsedPaths) ? collapsedPaths.filter((path): path is string => typeof path === 'string') : null };
    }
    const stateRef = React.useRef<Record<string, unknown>>({});
    React.useEffect(() => { stateRef.current = persistedReviewTabState ?? {}; }, [persistedReviewTabState]);
    const setDetailsTabState = pane.setDetailsTabState;
    const setPersistedReviewTabState = React.useCallback((patch: Record<string, unknown>) => {
        const previous = stateRef.current;
        if (!Object.entries(patch).some(([key, value]) => !valuesEqual(key, previous[key], value))) return;
        const next = { ...previous, ...patch };
        stateRef.current = next;
        setDetailsTabState(REVIEW_TAB_KEY, next);
    }, [setDetailsTabState]);
    const onCollapsedPathsChange = React.useCallback((paths: string[]) => setPersistedReviewTabState({ collapsedPaths: paths }), [setPersistedReviewTabState]);
    const pendingScrollTopRef = React.useRef<number | null>(null);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const flushPendingScrollTop = React.useCallback(() => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        const top = pendingScrollTopRef.current;
        pendingScrollTopRef.current = null;
        if (typeof top === 'number' && Number.isFinite(top)) setPersistedReviewTabState({ scrollTop: top });
    }, [setPersistedReviewTabState]);
    const onScrollTopChange = React.useCallback((top: number) => {
        if (!Number.isFinite(top) || scrollPositionsEqual(pendingScrollTopRef.current, top)) return;
        if (pendingScrollTopRef.current === null && scrollPositionsEqual(stateRef.current.scrollTop, top)) return;
        pendingScrollTopRef.current = top;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flushPendingScrollTop, SCROLL_PERSIST_DEBOUNCE_MS);
    }, [flushPendingScrollTop]);
    React.useEffect(() => flushPendingScrollTop, [flushPendingScrollTop]);
    return { persistedReviewTabState, mountedInitialReviewState: initialStateRef.current,
        setPersistedReviewTabState, onCollapsedPathsChange, onScrollTopChange };
}
