import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { SESSION_DETAILS_TERMINAL_TAB_KEY } from '@/components/sessions/terminal/embeddedTerminalDocking';
import {
    createSessionCommitDetailsTab,
    createSessionDetailsTerminalTab,
    createSessionFileDetailsTab,
    createSessionScmReviewDetailsTab,
    createSessionScmStashDetailsTab,
    SESSION_DETAILS_SCM_REVIEW_TAB_KEY,
    SESSION_DETAILS_SCM_STASH_TAB_KEY,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

export type SessionPaneUrlDetailsTarget =
    | Readonly<{ kind: 'file'; path: string }>
    | Readonly<{ kind: 'commit'; sha: string }>
    | Readonly<{ kind: 'scmReview' }>
    | Readonly<{ kind: 'scmStash' }>
    | Readonly<{ kind: 'terminal' }>;

export type SessionPaneUrlState = Readonly<{
    rightTabId?: 'git' | 'files' | 'terminal';
    bottomTabId?: 'terminal';
    details?: SessionPaneUrlDetailsTarget;
}>;

type PaneScopeStateLike = Readonly<{
    right: Readonly<{ isOpen: boolean; activeTabId: string | null }>;
    bottom: Readonly<{ isOpen: boolean; activeTabId: string | null }>;
    details: Readonly<{ isOpen: boolean; tabs: ReadonlyArray<Readonly<{ key: string; kind: string; resource: unknown }>>; activeTabKey: string | null }>;
}>;

function readSingleStringParam(params: Readonly<Record<string, unknown>>, key: string): string | null {
    const raw = params[key];
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) {
        const first = raw[0];
        return typeof first === 'string' ? first : null;
    }
    return null;
}

export function parseSessionPaneUrlState(params: Readonly<Record<string, unknown>>): SessionPaneUrlState | null {
    const rightRaw = readSingleStringParam(params, 'right')?.trim() ?? '';
    const rightTabId = rightRaw === 'git' || rightRaw === 'files' || rightRaw === 'terminal' ? rightRaw : null;
    const bottomRaw = readSingleStringParam(params, 'bottom')?.trim() ?? '';
    const bottomTabId = bottomRaw === 'terminal' ? bottomRaw : null;

    const detailsRaw = readSingleStringParam(params, 'details')?.trim() ?? '';
    const pathRaw = readSingleStringParam(params, 'path')?.trim() ?? '';
    const shaRaw = readSingleStringParam(params, 'sha')?.trim() ?? '';

    let details: SessionPaneUrlDetailsTarget | null = null;
    if (detailsRaw === 'file' && pathRaw && isSafeWorkspaceRelativePath(pathRaw)) {
        details = { kind: 'file', path: pathRaw.trim() };
    }
    if (detailsRaw === 'commit' && shaRaw) {
        details = { kind: 'commit', sha: shaRaw };
    }
    if (detailsRaw === 'scmReview') {
        details = { kind: 'scmReview' };
    }
    if (detailsRaw === 'scmStash') {
        details = { kind: 'scmStash' };
    }
    if (detailsRaw === 'terminal') {
        details = { kind: 'terminal' };
    }

    if (!rightTabId && !bottomTabId && !details) return null;
    return {
        ...(rightTabId ? { rightTabId } : null),
        ...(bottomTabId ? { bottomTabId } : null),
        ...(details ? { details } : null),
    };
}

export function serializeSessionPaneUrlState(state: SessionPaneUrlState): Record<string, string> {
    const out: Record<string, string> = {};
    if (state.rightTabId) {
        out.right = state.rightTabId;
    }
    if (state.bottomTabId) {
        out.bottom = state.bottomTabId;
    }
    if (state.details?.kind === 'file') {
        out.details = 'file';
        out.path = state.details.path;
    }
    if (state.details?.kind === 'commit') {
        out.details = 'commit';
        out.sha = state.details.sha;
    }
    if (state.details?.kind === 'scmReview') {
        out.details = 'scmReview';
    }
    if (state.details?.kind === 'scmStash') {
        out.details = 'scmStash';
    }
    if (state.details?.kind === 'terminal') {
        out.details = 'terminal';
    }
    return out;
}

export function buildActiveDetailsRouteParams(
    detailsTabs: readonly unknown[],
    activeDetailsKey: string | null
): Record<string, string> {
    const activeTab = (detailsTabs as ReadonlyArray<any>).find((tab) => tab?.key === activeDetailsKey)
        ?? (detailsTabs as ReadonlyArray<any>).at(-1)
        ?? null;
    if (!activeTab) return {};

    if (activeTab.kind === 'file') {
        const path = typeof activeTab.resource?.path === 'string' ? activeTab.resource.path.trim() : '';
        if (!path || !isSafeWorkspaceRelativePath(path)) return {};
        return serializeSessionPaneUrlState({ details: { kind: 'file', path } });
    }

    if (activeTab.kind === 'commit') {
        const rawSha = typeof activeTab.resource?.sha === 'string'
            ? activeTab.resource.sha
            : typeof activeTab.resource?.commitHash === 'string'
                ? activeTab.resource.commitHash
                : '';
        const sha = rawSha.trim().split(/\s+/)[0] ?? '';
        if (!sha) return {};
        return serializeSessionPaneUrlState({ details: { kind: 'commit', sha } });
    }

    if (activeTab.key === SESSION_DETAILS_SCM_REVIEW_TAB_KEY || activeTab.kind === 'scmReview') {
        return serializeSessionPaneUrlState({ details: { kind: 'scmReview' } });
    }

    if (activeTab.key === SESSION_DETAILS_SCM_STASH_TAB_KEY || activeTab.kind === 'scmStash') {
        return serializeSessionPaneUrlState({ details: { kind: 'scmStash' } });
    }

    if (activeTab.key === SESSION_DETAILS_TERMINAL_TAB_KEY || activeTab.kind === 'terminal') {
        return serializeSessionPaneUrlState({ details: { kind: 'terminal' } });
    }

    return {};
}

export function deriveSessionPaneUrlStateFromScopeState(scopeState: PaneScopeStateLike | null): SessionPaneUrlState | null {
    if (!scopeState) return null;
    const rightTabId =
        scopeState.right.isOpen && (scopeState.right.activeTabId === 'git' || scopeState.right.activeTabId === 'files' || scopeState.right.activeTabId === 'terminal')
            ? scopeState.right.activeTabId
            : null;
    const bottomTabId =
        scopeState.bottom.isOpen && scopeState.bottom.activeTabId === 'terminal'
            ? scopeState.bottom.activeTabId
            : null;

    let details: SessionPaneUrlDetailsTarget | null = null;
    if (scopeState.details.isOpen && scopeState.details.activeTabKey) {
        const tab = scopeState.details.tabs.find((t) => t.key === scopeState.details.activeTabKey) ?? null;
        if (tab?.kind === 'file') {
            const path = (tab.resource as any)?.path;
            if (typeof path === 'string' && path.trim()) {
                const trimmedPath = path.trim();
                if (isSafeWorkspaceRelativePath(trimmedPath)) {
                    details = { kind: 'file', path: trimmedPath };
                }
            }
        } else if (tab?.kind === 'commit') {
            const sha = (tab.resource as any)?.sha;
            if (typeof sha === 'string' && sha.trim()) {
                const safeSha = sha.trim().split(/\s+/)[0] ?? '';
                if (safeSha) {
                    details = { kind: 'commit', sha: safeSha };
                }
            }
        } else if (tab?.key === SESSION_DETAILS_SCM_REVIEW_TAB_KEY || tab?.kind === 'scmReview') {
            details = { kind: 'scmReview' };
        } else if (tab?.key === SESSION_DETAILS_SCM_STASH_TAB_KEY || tab?.kind === 'scmStash') {
            details = { kind: 'scmStash' };
        } else if (tab?.key === SESSION_DETAILS_TERMINAL_TAB_KEY || tab?.kind === 'terminal') {
            details = { kind: 'terminal' };
        }
    }

    if (!rightTabId && !bottomTabId && !details) return null;
    return {
        ...(rightTabId ? { rightTabId } : null),
        ...(bottomTabId ? { bottomTabId } : null),
        ...(details ? { details } : null),
    };
}

export function applySessionPaneUrlState(
    pane: Readonly<{
        openRight: (options?: Readonly<{ tabId?: string }>) => void;
        setRightTab: (tabId: string) => void;
        openBottom: (options?: Readonly<{ tabId?: string }>) => void;
        setBottomTab: (tabId: string) => void;
        openDetailsTab: (tab: any, options?: any) => void;
    }>,
    state: SessionPaneUrlState
): void {
    if (state.rightTabId) {
        pane.openRight({ tabId: state.rightTabId });
        pane.setRightTab(state.rightTabId);
    }
    if (state.bottomTabId) {
        pane.openBottom({ tabId: state.bottomTabId });
        pane.setBottomTab(state.bottomTabId);
    }

    if (state.details?.kind === 'file') {
        const fullPath = state.details.path.trim();
        if (!isSafeWorkspaceRelativePath(fullPath)) return;
        pane.openDetailsTab(createSessionFileDetailsTab(fullPath));
        return;
    }

    if (state.details?.kind === 'commit') {
        const tab = createSessionCommitDetailsTab(state.details.sha);
        if (tab) pane.openDetailsTab(tab);
        return;
    }

    if (state.details?.kind === 'terminal') {
        pane.openDetailsTab(createSessionDetailsTerminalTab(), { intent: 'pinned' });
        return;
    }

    if (state.details?.kind === 'scmReview') {
        pane.openDetailsTab(createSessionScmReviewDetailsTab(), { intent: 'pinned' });
        return;
    }

    if (state.details?.kind === 'scmStash') {
        pane.openDetailsTab(createSessionScmStashDetailsTab(), { intent: 'pinned' });
    }
}

export function reconcileSessionPaneScopeFromUrlState(
    pane: Readonly<{
        openRight: (options?: Readonly<{ tabId?: string }>) => void;
        closeRight: () => void;
        setRightTab: (tabId: string) => void;
        openBottom: (options?: Readonly<{ tabId?: string }>) => void;
        closeBottom: () => void;
        setBottomTab: (tabId: string) => void;
        openDetailsTab: (tab: any, options?: any) => void;
        closeDetails: () => void;
    }>,
    state: SessionPaneUrlState | null
): void {
    if (state?.rightTabId) {
        pane.openRight({ tabId: state.rightTabId });
        pane.setRightTab(state.rightTabId);
    } else {
        pane.closeRight();
    }

    if (state?.bottomTabId) {
        pane.openBottom({ tabId: state.bottomTabId });
        pane.setBottomTab(state.bottomTabId);
    } else {
        pane.closeBottom();
    }

    if (state?.details) {
        applySessionPaneUrlState(pane, { details: state.details });
    } else {
        pane.closeDetails();
    }
}
