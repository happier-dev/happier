export type SessionGitSubTabId = 'commit' | 'update' | 'history';

export function shouldLoadSessionGitHistory(params: Readonly<{
    activeSubTab: SessionGitSubTabId;
    sessionPath: string | null;
    commitHistoryInitKey: string;
    loadedCommitHistoryInitKey: string | null;
}>): boolean {
    return (
        params.activeSubTab === 'history'
        && Boolean(params.sessionPath)
        && params.loadedCommitHistoryInitKey !== params.commitHistoryInitKey
    );
}
