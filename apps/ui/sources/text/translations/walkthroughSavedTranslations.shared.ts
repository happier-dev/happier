

export type SavedCopy = { [K in keyof typeof en]: string };



export const en = {
    discuss: 'Discuss', message: 'Message',
    edit: 'Edit walkthrough', title: 'Walkthrough title', stopTitle: 'Stop title', prose: 'Explanation',
    refine: 'Refine', instructions: 'What should change?', moveUp: 'Move up', moveDown: 'Move down', mergeNext: 'Merge with next stop',
    addSummary: 'Add summary', addCommitPlan: 'Propose commits', updated: 'Saved result updated',
    conflict: 'This walkthrough changed elsewhere. Your draft is kept. Load the latest version and review it before saving again.',
    reload: 'Load latest version', applicationLocked: 'Commit application is in progress. Editing is paused.',
    missingStop: "This stop is no longer in the latest walkthrough. Your draft is kept; select another stop to continue.",
};


export const walkthroughSavedTranslationsEnglish = { en } satisfies Pick<Record<string, SavedCopy>, "en">;
