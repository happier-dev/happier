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
    const gitTabStateRef = React.useRef<Record<string, unknown>>({});
    gitTabStateRef.current = gitTabState ?? {};
    const activeGitSubTab = (gitTabState?.activeSubTabId as GitSubTabId | null) ?? 'commit';
    const commitDraftMessage = typeof gitTabState?.commitMessageDraft === 'string' ? (gitTabState.commitMessageDraft as string) : '';

    const mergeGitTabState = React.useCallback((patch: Record<string, unknown>) => {
        pane.setRightTabState('git', { ...gitTabStateRef.current, ...patch });
    }, [pane]);

    const setCommitDraftMessage = React.useCallback((value: string) => {
        mergeGitTabState({ commitMessageDraft: value });
    }, [mergeGitTabState]);

    const setActiveGitSubTab = React.useCallback((subTabId: GitSubTabId) => {
        mergeGitTabState({ activeSubTabId: subTabId });
    }, [mergeGitTabState]);

    return {
        activeGitSubTab,
        commitDraftMessage,
        setCommitDraftMessage,
        setActiveGitSubTab,
    };
}
