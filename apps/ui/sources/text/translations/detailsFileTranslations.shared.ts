

export type DetailsFileTranslations = Readonly<{
    areaUnstaged: string;
    areaStaged: string;
    areaBoth: string;
    areaLabel: string;
    preview: string;
    viewLabel: string;
    compare: string;
    stage: string;
    unstage: string;
    addToCommit: string;
    removeFromCommit: string;
    editing: string;
    editingUnsaved: string;
    statusModified: string;
    statusAdded: string;
    statusDeleted: string;
    statusRenamed: string;
    statusCopied: string;
    statusUntracked: string;
    statusConflicted: string;
    noChanges: string;
    lines: (params: Readonly<{ count: number }>) => string;
}>;


export const detailsFileTranslationsEnglish = { en: {
        areaUnstaged: 'Unstaged',
        areaStaged: 'Staged',
        areaBoth: 'Both',
        areaLabel: 'Changes',
        preview: 'Preview',
        viewLabel: 'View',
        compare: 'Compare',
        stage: 'Stage',
        unstage: 'Unstage',
        addToCommit: 'Add to commit',
        removeFromCommit: 'Remove from commit',
        editing: 'Editing',
        editingUnsaved: 'Editing · unsaved changes',
        statusModified: 'Modified',
        statusAdded: 'Added',
        statusDeleted: 'Deleted',
        statusRenamed: 'Renamed',
        statusCopied: 'Copied',
        statusUntracked: 'New, not tracked yet',
        statusConflicted: 'Has conflicts',
        noChanges: 'No changes',
        lines: ({ count }) => (count === 1 ? '1 line' : `${count} lines`),
    } } satisfies Pick<Record<string, DetailsFileTranslations>, "en">;