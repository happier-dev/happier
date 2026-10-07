

export type Count = Readonly<{ count: number }>;



export type Branch = Readonly<{ branch: string }>;



export type Folder = Readonly<{ folder: string }>;



export type DetailsHistoryTranslations = Readonly<{
    copyCommitSha: string;
    filesChanged: (params: Count) => string;
    files: (params: Count) => string;
    revertEllipsis: string;
    stashKeptOn: (params: Branch) => string;
    stashOriginBranch: (params: Branch) => string;
    stashOriginBranchShort: string;
    stashOriginTransient: string;
    stashOriginUnmanaged: string;
    stashRestoreExplains: (params: Folder) => string;
    stashApply: string;
    stashApplyA11y: string;
    stashDiscardEllipsis: string;
    stashSwitcherA11y: string;
    stashCount: (params: Count) => string;
}>;


export const detailsHistoryTranslationsEnglish = { en: {
        copyCommitSha: 'Copy commit SHA',
        filesChanged: ({ count }) => (count === 1 ? '1 file changed' : `${count} files changed`),
        files: ({ count }) => (count === 1 ? '1 file' : `${count} files`),
        revertEllipsis: 'Revert…',
        stashKeptOn: ({ branch }) => `Kept on ${branch}`,
        stashOriginBranch: ({ branch }) => `Saved when you switched away from ${branch}`,
        stashOriginBranchShort: 'When you switched branches',
        stashOriginTransient: 'Saved by Happier',
        stashOriginUnmanaged: 'Made outside Happier',
        stashRestoreExplains: ({ folder }) => `Restoring puts these changes back in ${folder} and removes the stash. Nothing else in the folder changes.`,
        stashApply: 'Apply',
        stashApplyA11y: 'Apply these changes and keep the stash',
        stashDiscardEllipsis: 'Discard…',
        stashSwitcherA11y: 'Choose a stash',
        stashCount: ({ count }) => (count === 1 ? '1 stash' : `${count} stashes`),
    } } satisfies Pick<Record<string, DetailsHistoryTranslations>, "en">;