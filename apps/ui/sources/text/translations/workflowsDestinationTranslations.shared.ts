

export type WorkflowsDestinationTranslations = typeof en;



export const en = {
    description: 'Recipes your agents run on your machines — when you choose, on a schedule, or when something happens.',
    import: 'Import',
    addAccessibility: 'Add a workflow',
    moreAccessibility: 'More workflow options',
    addMenu: {
        newWorkflowSubtitle: 'Start from a blank draft',
        importSubtitle: 'A workflow JSON file',
    },
    sections: {
        needsYou: 'Needs you',
        running: 'Running',
        library: 'Library',
        sharedWithYou: 'Shared with you',
        triggers: 'Triggers',
        history: 'History',
    },
    allRuns: 'All runs',
    lastRun: ({ age }: { age: string }) => `last run ${age}`,
    strip: {
        label: ({ count, parts }: { count: number; parts: string }) => `Last ${count === 1 ? 'run' : `${count} runs`}: ${parts}`,
        labelPlain: ({ count }: { count: number }) => `Last ${count === 1 ? 'run' : `${count} runs`}`,
        completed: ({ count }: { count: number }) => `${count} completed`,
        failed: ({ count }: { count: number }) => `${count} failed`,
        needsYou: ({ count }: { count: number }) => `${count} ${count === 1 ? 'needs' : 'need'} you`,
        separator: ', ',
    },
    runSettings: 'Run settings',
    libraryEmpty: 'Workflows you save appear here.',
    waitingForYou: ({ age }: { age: string }) => `Waiting for you · ${age}`,
    stateAge: ({ state, age }: { state: string; age: string }) => `${state} · ${age}`,
    triggerRow: ({ when, then }: { when: string; then: string }) => `${when} · ${then}`,
    thenSendPrompt: 'Send a prompt',
    thenRunWorkflow: 'Run a workflow',
    offline: 'Offline',
    off: 'Off',
    columnLoadFailed: 'Could not load workflows. Nothing you saved is lost.',
    firstVisitTitle: 'Save prompts that work, then run them again',
    firstVisitBody: 'A workflow is a set of steps your agents run in order, side by side, or once per item — when you choose, on a schedule, or when something happens.',
    importPrompt: 'Have a workflow file?',
    loadMoreWorkflows: 'Load more workflows',
    searchPlaceholder: 'Search workflows',
    noMatch: ({ query }: { query: string }) => `No workflows match “${query}”`,
    views: {
        all: 'All',
        triggered: 'Triggered',
        active: 'Active',
        needsYou: 'Needs you',
        libraryAccessibility: 'Which workflows to show',
        historyAccessibility: 'Which runs to show',
    },
    history: {
        title: 'History',
        description: 'Every run you started, whichever way it started.',
        loadMore: 'Load more runs',
        loadFailedTitle: 'Could not load runs',
        loadFailedBody: 'Your work is unaffected.',
        review: 'Review',
        rowMeta: ({ origin, machine, age }: { origin: string; machine: string; age: string }) => `${origin} · ${machine} · ${age}`,
    },
    rowMenu: {
        accessibility: 'Workflow options',
        runNow: 'Run now',
        share: 'Share…',
    },
    deleteTitle: 'Delete this workflow?',
    deleteFailedTitle: 'Could not delete workflow',
    exportFailedTitle: 'Could not export workflow',
    gate: {
        localTitle: 'Automations are turned off on this device',
        localBody: 'Turn them on to run workflows and their triggers.',
        dependencyTitle: 'Workflows need Automations',
        dependencyBody: 'Turn on Automations to create and run workflows.',
        openSettings: 'Open Settings',
    },
    runSettingsPage: {
        title: 'Run settings',
        description: 'How many runs each machine takes at once, and how long run history is kept.',
        saveFailed: 'Could not save run settings. Your changes are still here.',
    },
};


export const workflowsDestinationTranslationsEnglish = { en } as const;
