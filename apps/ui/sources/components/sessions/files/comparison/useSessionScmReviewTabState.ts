import * as React from 'react';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionScmReviewDetailsTab, SESSION_DETAILS_SCM_REVIEW_TAB_KEY, type SessionScmReviewTarget } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { activeReviewFileKeyForComparison, requestActiveReviewFileForComparison, useActiveReviewFilePath } from '@/components/workspaces/scm/review/activeReviewFile';
import { scmComparisonKey } from './filesComparison';
import type { SessionScmReviewComparison, SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { getScmReviewComparison, retainScmReviewComparison, subscribeScmDiffSummaryHostState } from '@/sync/ops/scmDiffSummary/generate';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';

/** An untargeted Review resumes its Session's scope; explicit links and picker choices win. */
export function useSessionScmReviewComparison(sessionId: string, serverId: string | null | undefined,
    comparison: SessionScmReviewComparison | undefined, active: boolean) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const scope = resolution.kind === 'bound' ? resolution.scope : null;
    const getSnapshot = React.useCallback(() => scope ? getScmReviewComparison(scope, sessionId) : null,
        [scope?.serverId, scope?.accountId, sessionId]);
    const subscribe = React.useCallback((listener: () => void) => scope
        ? subscribeScmDiffSummaryHostState({ sessionId }, serverAccountScopeKeySuffix(scope), listener) : () => {},
    [scope?.serverId, scope?.accountId, sessionId]);
    const retained = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    React.useEffect(() => {
        if (binding && active && comparison) retainScmReviewComparison(binding, sessionId, comparison);
    }, [binding, sessionId, comparison, active]);
    return comparison ?? retained;
}

const SCROLL_PERSIST_DEBOUNCE_MS = 250;
const SCROLL_PERSIST_EPSILON_PX = 1;

type ReviewModelChoice = Readonly<{ hostKey: string; preference: string | null; value: string }>;

/** Responsive presenters can remount the form; its draft belongs to the retained review pane. */
export function useScmReviewModelChoice(hostKey: string, preference: string | null, scopeId?: string) {
    const [localChoice, setLocalChoice] = React.useState<ReviewModelChoice | null>(null);
    const pane = useOptionalAppPaneContext(context => {
        const tab = scopeId ? context.state.scopes[scopeId]?.details.tabState[SESSION_DETAILS_SCM_REVIEW_TAB_KEY] : null;
        const choice = tab && typeof tab === 'object' && 'modelChoice' in tab ? tab.modelChoice as ReviewModelChoice | null : null;
        return { dispatch: context.dispatch, choice };
    });
    const dispatch = pane?.dispatch;
    const choice = scopeId && pane ? pane.choice : localChoice;
    const setModel = React.useCallback((value: string) => {
        const modelChoice = { hostKey, preference, value };
        if (scopeId && dispatch) {
            dispatch({ type: 'patchDetailsTabState', scopeId, tabKey: SESSION_DETAILS_SCM_REVIEW_TAB_KEY,
                patch: { modelChoice }, persist: false });
        } else setLocalChoice(modelChoice);
    }, [dispatch, hostKey, preference, scopeId]);
    return { chosenModel: choice?.hostKey === hostKey && choice.preference === preference ? choice.value : null, setModel };
}

type ReviewPaneState = Readonly<{
    scopeState?: Readonly<{ details?: Readonly<{ tabState?: Readonly<Record<string, unknown>> }> }> | null;
}>;

/** Hidden Review retains selection in its incumbent pane, not in the public on-screen projection. */
export function useScmReviewActiveFileSelection(params: Readonly<{
    pane: ReviewPaneState & Pick<AppPaneScopeApi, 'setDetailsTabState'>; hostKey: string; activeFileKey: string;
    persistedSelection?: unknown;
    comparison: SessionScmReviewComparison | null; view: SessionScmReviewView; presented: boolean;
    isCurrent?: () => boolean;
}>) {
    const tabKey = `${SESSION_DETAILS_SCM_REVIEW_TAB_KEY}:activeFile`;
    const activeFileKey = activeReviewFileKeyForComparison(params.activeFileKey, params.comparison);
    const selectionKey = JSON.stringify([params.hostKey, params.comparison ? scmComparisonKey(params.comparison) : null]);
    const raw = params.persistedSelection ?? params.pane.scopeState?.details?.tabState?.[tabKey];
    const saved = raw && typeof raw === 'object' ? raw as { selectionKey?: unknown; path?: unknown } : null;
    const initial = React.useRef<Readonly<{ key: string; path: string | null; restored: boolean }> | null>(null);
    if (!initial.current || initial.current.key !== selectionKey) initial.current = { key: selectionKey,
        path: saved?.selectionKey === selectionKey && typeof saved.path === 'string' ? saved.path : null, restored: false };
    const activePath = useActiveReviewFilePath(activeFileKey);
    const setDetailsTabState = params.pane.setDetailsTabState;
    React.useEffect(() => {
        if (!initial.current) return;
        if (params.view !== 'files') {
            initial.current = { ...initial.current, restored: false };
            return;
        }
        // A hidden Files view keeps its rows and scroll. Restore only after that body retires,
        // rather than issuing another focus/virtualizer scroll every time its tab returns.
        if (!params.presented || !params.comparison || initial.current.restored) return;
        const path = initial.current.path;
        if (path && !requestActiveReviewFileForComparison(activeFileKey, path, params.comparison, params.isCurrent)) return;
        initial.current = { ...initial.current, restored: true };
    }, [activeFileKey, params.comparison, params.isCurrent, params.presented, params.view, selectionKey]);
    React.useEffect(() => {
        if (!params.presented || params.view !== 'files' || !activePath) return;
        if (initial.current) initial.current = { ...initial.current, path: activePath };
        if (saved?.selectionKey !== selectionKey || saved?.path !== activePath) setDetailsTabState(tabKey, { selectionKey, path: activePath });
    }, [activePath, params.presented, params.view, saved?.selectionKey, saved?.path, selectionKey, setDetailsTabState, tabKey]);
    return React.useMemo(() => ({ key: activeFileKey, navigationKey: params.activeFileKey,
        presented: params.presented, externalLifecycle: true }), [activeFileKey, params.activeFileKey, params.presented]);
}

function scrollPositionsEqual(previous: unknown, next: unknown): boolean {
    if (Object.is(previous, next)) return true;
    if (typeof previous !== 'number' || typeof next !== 'number') return false;
    return Number.isFinite(previous) && Number.isFinite(next) && Math.abs(previous - next) < SCROLL_PERSIST_EPSILON_PX;
}

/** Both live and captured Files preserve the existing review tab's scroll and collapse state. */
export function useScmReviewTabState(hostKey: string, pane: ReviewPaneState & Pick<AppPaneScopeApi, 'patchDetailsTabState'>,
    tabKey = SESSION_DETAILS_SCM_REVIEW_TAB_KEY, rawTabState = pane.scopeState?.details?.tabState?.[tabKey]) {
    const raw = rawTabState;
    const persistedReviewTabState = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const rawReviewRunIds = persistedReviewTabState?.reviewRunIds;
    const startedReviewRunIds = React.useMemo(() => Array.isArray(rawReviewRunIds)
        ? rawReviewRunIds.filter((id): id is string => typeof id === 'string') : null, [rawReviewRunIds]);
    const initialStateRef = React.useRef<Readonly<{ hostKey: string; scrollTop: number | null; collapsedPaths: string[] | null }> | null>(null);
    if (!initialStateRef.current || initialStateRef.current.hostKey !== hostKey) {
        const scrollTop = persistedReviewTabState?.scrollTop;
        const collapsedPaths = persistedReviewTabState?.collapsedPaths;
        initialStateRef.current = { hostKey,
            scrollTop: typeof scrollTop === 'number' && Number.isFinite(scrollTop) ? scrollTop : null,
            collapsedPaths: Array.isArray(collapsedPaths) ? collapsedPaths.filter((path): path is string => typeof path === 'string') : null };
    }
    const patchDetailsTabState = pane.patchDetailsTabState;
    const setPersistedReviewTabState = React.useCallback((patch: Record<string, unknown>) => {
        if (initialStateRef.current) initialStateRef.current = {
            ...initialStateRef.current,
            ...(typeof patch.scrollTop === 'number' ? { scrollTop: patch.scrollTop } : {}),
            ...(Array.isArray(patch.collapsedPaths) ? { collapsedPaths: patch.collapsedPaths.filter((path): path is string => typeof path === 'string') } : {}),
        };
        patchDetailsTabState(tabKey, patch);
    }, [patchDetailsTabState, tabKey]);
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
        if (pendingScrollTopRef.current === null && scrollPositionsEqual(initialStateRef.current?.scrollTop, top)) return;
        // View switches remount Files immediately; persistence remains debounced.
        if (initialStateRef.current) initialStateRef.current = { ...initialStateRef.current, scrollTop: top };
        pendingScrollTopRef.current = top;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flushPendingScrollTop, SCROLL_PERSIST_DEBOUNCE_MS);
    }, [flushPendingScrollTop]);
    React.useEffect(() => flushPendingScrollTop, [flushPendingScrollTop]);
    return { persistedReviewTabState, startedReviewRunIds, mountedInitialReviewState: initialStateRef.current,
        setPersistedReviewTabState, onCollapsedPathsChange, onScrollTopChange };
}

/** Session destination authoring stays at the Session adapter; persistence is shared. */
export function useSessionScmReviewTabState(sessionId: string, pane: AppPaneScopeApi, target: SessionScmReviewTarget = {},
    openDetailsTab = pane.openDetailsTab) {
    // Explain is presentation on the semantic destination, shared by UI and session.open.
    const explain = target.explain === true;
    const setExplain = React.useCallback((next: boolean) => {
        openDetailsTab(createSessionScmReviewDetailsTab({ ...target, explain: next }), { intent: 'pinned' });
    }, [openDetailsTab, target]);

    return { ...useScmReviewTabState(sessionId, pane), explain, setExplain };
}
