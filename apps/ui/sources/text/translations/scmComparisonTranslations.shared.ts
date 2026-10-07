

export type ScmComparisonTranslations = {
    -readonly [Key in keyof typeof en]: (typeof en)[Key] extends Readonly<Record<string, unknown>>
        ? { -readonly [Child in keyof (typeof en)[Key]]: (typeof en)[Key][Child] }
        : (typeof en)[Key];
};



export function translated(value: ScmComparisonTranslations): ScmComparisonTranslations {
    return value;
}



export const en = {
    view: {
        files: 'Files',
        walkthrough: 'Walkthrough',
        commits: 'Commits',
    },
    scope: {
        workingTree: 'Pending changes',
        session: 'This session',
        turn: 'Turn',
        latestTurn: 'Latest turn',
        branch: ({ head, base }: { head: string; base: string }) => `${head} vs ${base}`,
        commit: ({ commit }: { commit: string }) => `Commit ${commit}`,
    },
    tabTitle: ({ view, scope }: { view: string; scope: string }) => `${view} · ${scope}`,
    since: ({ time }: { time: string }) => `since ${time}`,
    turnsWithChanges: ({ count }: { count: number }) => `${count} ${count === 1 ? 'turn' : 'turns'} with changes`,
    scopePicker: {
        a11y: 'Changes to show',
        branchChoice: 'Branch vs base',
        commitChoice: 'Commit',
        pullRequestChoice: 'Pull request',
        headRef: 'Head branch or ref',
        baseRef: 'Base branch or ref',
        parentRef: 'Parent ref (optional)',
        explainAndCommit: 'Explain and commit',
        explainOnly: 'Explain only',
        unavailable: 'Not available for this session',
        pendingDescription: 'Not committed · can propose commits',
        sessionDescription: 'Everything it changed, start → now',
        turnDescription: 'In order, as the agent made it',
        branchDescription: 'Changes from the shared base',
        commitDescription: 'Changes introduced by this commit',
        pullRequestDescription: 'Changes proposed by this pull request',
    },
    fileCount: ({ count }: { count: number }) => `${count} ${count === 1 ? 'file' : 'files'}`,
    changeCount: ({ count }: { count: number }) => `${count} ${count === 1 ? 'change' : 'changes'}`,
    changedFiles: 'Changed files',
    startReview: 'Start review',
    proposeCommits: 'Propose commits',
    explain: 'Explain',
    explainA11y: 'Explain: show the walkthrough’s notes beside the changes',
    viewA11y: 'View',
    lockfileTag: 'Lockfile',
    generatedTag: 'Generated',
    lockfileCollapsed: 'Lockfile, collapsed.',
    generatedCollapsed: 'Generated file, collapsed.',
    showDiff: 'Show diff',
    unsupportedReason: 'Files cannot show this comparison yet. Its changes are still in Git.',
    showPendingChanges: 'Show pending changes',
    capturedStale: 'The source changed. These files keep the captured comparison.',
    capturedFreshnessUnknown: 'Showing captured files. The source’s current state could not be checked.',
    keys: {
        nextFile: 'next file',
        nextChange: 'next change',
    },
};


export const scmComparisonTranslationsEnglish = { en: { scmComparison: en as ScmComparisonTranslations } } as const;