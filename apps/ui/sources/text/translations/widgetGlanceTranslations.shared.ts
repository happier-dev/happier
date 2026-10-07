

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
        changedCount: ({ count }) => `${count} changed`,
        moreFiles: ({ count }) => (count === 1 ? '1 more file' : `${count} more files`),
        runningCount: ({ count }) => `${count} running`,
        openInBrowser: ({ name }) => `Open ${name} in the browser`,
        paneLinkA11y: ({ pane }) => `${pane}. Opens beside the chat`,
    } } satisfies Pick<Readonly<Record<string, WidgetGlanceTranslation>>, "en">;