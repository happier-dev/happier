import * as React from 'react';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionScmReviewDetailsTab, SESSION_DETAILS_SCM_REVIEW_TAB_KEY, type SessionScmReviewTarget } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { requestActiveReviewFileForComparison, useActiveReviewFilePath } from '@/components/workspaces/scm/review/activeReviewFile';
import { scmComparisonKey } from './filesComparison';
import type { SessionScmReviewComparison, SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

const SCROLL_PERSIST_DEBOUNCE_MS = 250;
const SCROLL_PERSIST_EPSILON_PX = 1;

/** Hidden Review retains selection in its incumbent pane, not in the public on-screen projection. */
export function useScmReviewActiveFileSelection(params: Readonly<{
    pane: ReturnType<typeof useAppPaneScope>; hostKey: string; activeFileKey: string;
    comparison: SessionScmReviewComparison | null; view: SessionScmReviewView; presented: boolean;
    isCurrent?: () => boolean;
}>) {
    const tabKey = `${SESSION_DETAILS_SCM_REVIEW_TAB_KEY}:activeFile`;
    const selectionKey = JSON.stringify([params.hostKey, params.comparison ? scmComparisonKey(params.comparison) : null]);
    const raw = params.pane.scopeState?.details.tabState[tabKey];
    const saved = raw && typeof raw === 'object' ? raw as { selectionKey?: unknown; path?: unknown } : null;
    const initial = React.useRef<Readonly<{ key: string; path: string | null; restored: boolean }> | null>(null);
    if (!initial.current || initial.current.key !== selectionKey) initial.current = { key: selectionKey,
        path: saved?.selectionKey === selectionKey && typeof saved.path === 'string' ? saved.path : null, restored: false };
    const activePath = useActiveReviewFilePath(params.activeFileKey);
    const setDetailsTabState = params.pane.setDetailsTabState;
    React.useEffect(() => {
        if (!initial.current) return;
        if (!params.presented || params.view !== 'files') {
            initial.current = { ...initial.current, restored: false };
            return;
        }
        if (!params.comparison || initial.current.restored) return;
        const path = initial.current.path;
        if (path && !requestActiveReviewFileForComparison(params.activeFileKey, path, params.comparison, params.isCurrent)) return;
        initial.current = { ...initial.current, restored: true };
    }, [params.activeFileKey, params.comparison, params.isCurrent, params.presented, params.view, selectionKey]);
    React.useEffect(() => {
        if (!params.presented || params.view !== 'files' || !activePath) return;
        if (initial.current) initial.current = { ...initial.current, path: activePath };
        if (saved?.selectionKey !== selectionKey || saved?.path !== activePath) setDetailsTabState(tabKey, { selectionKey, path: activePath });
    }, [activePath, params.presented, params.view, saved?.selectionKey, saved?.path, selectionKey, setDetailsTabState, tabKey]);
}

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
export function useScmReviewTabState(hostKey: string, pane: ReturnType<typeof useAppPaneScope>, tabKey = SESSION_DETAILS_SCM_REVIEW_TAB_KEY) {
    const raw = pane.scopeState?.details?.tabState?.[tabKey];
    const persistedReviewTabState = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const initialStateRef = React.useRef<Readonly<{ hostKey: string; scrollTop: number | null; collapsedPaths: string[] | null }> | null>(null);
    if (!initialStateRef.current || initialStateRef.current.hostKey !== hostKey) {
        const scrollTop = persistedReviewTabState?.scrollTop;
        const collapsedPaths = persistedReviewTabState?.collapsedPaths;
        initialStateRef.current = { hostKey,
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
        if (initialStateRef.current) initialStateRef.current = {
            ...initialStateRef.current,
            ...(typeof next.scrollTop === 'number' ? { scrollTop: next.scrollTop } : {}),
            ...(Array.isArray(next.collapsedPaths) ? { collapsedPaths: next.collapsedPaths.filter((path): path is string => typeof path === 'string') } : {}),
        };
        setDetailsTabState(tabKey, next);
    }, [setDetailsTabState, tabKey]);
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
        // View switches remount Files immediately; persistence remains debounced.
        if (initialStateRef.current) initialStateRef.current = { ...initialStateRef.current, scrollTop: top };
        pendingScrollTopRef.current = top;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flushPendingScrollTop, SCROLL_PERSIST_DEBOUNCE_MS);
    }, [flushPendingScrollTop]);
    React.useEffect(() => flushPendingScrollTop, [flushPendingScrollTop]);
    return { persistedReviewTabState, mountedInitialReviewState: initialStateRef.current,
        setPersistedReviewTabState, onCollapsedPathsChange, onScrollTopChange };
}

/** Session destination authoring stays at the Session adapter; persistence is shared. */
export function useSessionScmReviewTabState(sessionId: string, pane: ReturnType<typeof useAppPaneScope>, target: SessionScmReviewTarget = {}) {
    // Explain is presentation on the semantic destination, shared by UI and session.open.
    const explain = target.explain === true;
    const openDetailsTab = pane.openDetailsTab;
    const setExplain = React.useCallback((next: boolean) => {
        openDetailsTab(createSessionScmReviewDetailsTab({ ...target, explain: next }), { intent: 'pinned' });
    }, [openDetailsTab, target]);

    return { ...useScmReviewTabState(sessionId, pane), explain, setExplain };
}
