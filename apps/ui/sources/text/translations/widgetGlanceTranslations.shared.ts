

export type WidgetGlanceTranslation = Readonly<{
    changesTitle: string;
    localServicesTitle: string;
    changesSource: string;
    reviewChanges: string;
    notARepo: string;
    noChanges: string;
    changesLoading: string;
    running: string;
    notRunning: string;
    nothingRunning: string;
    servicesLoading: string;
    servicesReadFailed: string;
    noMachine: string;
    appEmptyTitle: string;
    appUnlistedTitle: string;
    appUnlistedOffline: (params: Readonly<{ machine: string }>) => string;
    appUnlistedMany: (params: Readonly<{ count: number }>) => string;
    appEmptyReason: string;
    machineOffline: (params: Readonly<{ machine: string }>) => string;
    machineUnreadable: (params: Readonly<{ machine: string }>) => string;
    machinesNotListed: (params: Readonly<{ count: number }>) => string;
    changedCount: (params: Readonly<{ count: number }>) => string;
    moreFiles: (params: Readonly<{ count: number }>) => string;
    runningCount: (params: Readonly<{ count: number }>) => string;
    openInBrowser: (params: Readonly<{ name: string }>) => string;
    paneLinkA11y: (params: Readonly<{ pane: string }>) => string;
}>;


export const widgetGlanceTranslationsEnglish = { en: {
        changesTitle: 'Changes',
        localServicesTitle: 'Local services',
        changesSource: 'Git',
        reviewChanges: 'Review changes',
        notARepo: 'This session’s folder isn’t a Git repository.',
        noChanges: 'No changes yet. Files the agent edits show up here.',
        changesLoading: 'Loading changes',
        running: 'Running',
        notRunning: 'Not running',
        nothingRunning: 'Nothing running. Services this session starts show up here.',
        servicesLoading: 'Loading local services',
        servicesReadFailed: 'Couldn’t read local services. Try again.',
        noMachine: 'This session has no machine to ask.',
        appEmptyTitle: 'Nothing running',
        appUnlistedTitle: 'Services aren’t listed',
        appUnlistedOffline: ({ machine }) => `${machine} is offline.`,
        appUnlistedMany: ({ count }) => `${count} machines can’t be reached.`,
        appEmptyReason: 'Web servers you run on your machines will appear here.',
        machineOffline: ({ machine }) => `${machine} is offline: its services aren’t listed.`,
        machineUnreadable: ({ machine }) => `${machine}’s services couldn’t be read just now.`,
        machinesNotListed: ({ count }) => `${count} machines can’t be reached: their services aren’t listed.`,
        changedCount: ({ count }) => `${count} changed`,
        moreFiles: ({ count }) => (count === 1 ? '1 more file' : `${count} more files`),
        runningCount: ({ count }) => `${count} running`,
        openInBrowser: ({ name }) => `Open ${name} in the browser`,
        paneLinkA11y: ({ pane }) => `${pane}. Opens beside the chat`,
    } } satisfies Pick<Readonly<Record<string, WidgetGlanceTranslation>>, "en">;