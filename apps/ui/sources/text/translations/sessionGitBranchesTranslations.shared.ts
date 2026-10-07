

export type SessionGitBranchesTranslations = typeof en;



export const en = {
    openA11y: ({ branch }: { branch: string }) => `Branch ${branch}: switch branches or see what was kept aside`,
    searchPlaceholder: 'Switch to or create a branch',
    category: {
        current: 'Current',
        branches: 'Branches',
        remote: 'Remote branches',
        keptAside: 'Kept aside',
        worktrees: 'Worktrees',
        start: 'Start something new',
    },
    tracks: ({ upstream }: { upstream: string }) => `tracks ${upstream}`,
    onlyHere: 'only on this machine',
    changed: ({ count }: { count: string }) => `${count} changed`,
    ahead: ({ count }: { count: string }) => `${count} to push`,
    keptAsideWhen: ({ origin, when }: { origin: string; when: string }) => `${origin} · ${when}`,
    newBranch: ({ branch }: { branch: string }) => `New branch from ${branch}…`,
    newBranchDetached: 'New branch…',
    newBranchSubtitle: 'Type its name in the search field',
    newWorktree: 'New worktree…',
    newWorktreeSubtitle: 'Work on another branch in a new session',
    keepAside: 'Keep changes aside',
    keepAsideSubtitle: ({ count }: { count: string }) => `Put ${count} changes away and start clean`,
    keepAsideNothing: 'No changes to keep',
    keepAsideFailed: 'Couldn’t keep the changes aside.',
    loadFailed: 'Couldn’t load the branches',
    notice: {
        title: ({ branch }: { branch: string }) => `You kept changes aside on ${branch}`,
        reason: ({ when }: { when: string }) => `Kept ${when}. Bring them back to keep working.`,
        reasonUndated: 'Bring them back to keep working.',
        restore: 'Restore changes',
        lookFirst: 'Look first',
        dismiss: 'Not now',
        restoreFailed: 'Couldn’t restore the changes.',
    },
};


export const sessionGitBranchesTranslationsEnglish = { en };