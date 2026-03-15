import * as React from 'react';

import type { GitSubTabId } from './SessionRightPanelGitSubTabsBar';

type PaneLike = Readonly<{
    scopeState: unknown;
    setRightTabState: (tabId: string, state: unknown) => void;
}>;

function readGitTabState(scopeState: unknown): Record<string, unknown> | null {
    const candidate = (scopeState as any)?.right?.tabState;
    const git = candidate?.git;
    return git && typeof git === 'object' ? (git as Record<string, unknown>) : null;
}

export function useSessionRightPanelGitTabState(pane: PaneLike): Readonly<{
    activeGitSubTab: GitSubTabId;
    commitDraftMessage: string;
    setCommitDraftMessage: (value: string) => void;
    setActiveGitSubTab: (subTabId: GitSubTabId) => void;
}> {
    const gitTabState = readGitTabState(pane.scopeState);
    const activeGitSubTab = (gitTabState?.activeSubTabId as GitSubTabId | null) ?? 'commit';
    const commitDraftMessage = typeof gitTabState?.commitMessageDraft === 'string' ? (gitTabState.commitMessageDraft as string) : '';

    const setCommitDraftMessage = React.useCallback((value: string) => {
        const base = gitTabState ?? {};
        pane.setRightTabState('git', { ...base, commitMessageDraft: value });
    }, [gitTabState, pane]);

    const setActiveGitSubTab = React.useCallback((subTabId: GitSubTabId) => {
        const base = gitTabState ?? {};
        pane.setRightTabState('git', { ...base, activeSubTabId: subTabId });
    }, [gitTabState, pane]);

    return {
        activeGitSubTab,
        commitDraftMessage,
        setCommitDraftMessage,
        setActiveGitSubTab,
    };
}
