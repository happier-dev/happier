

export type HomeWidgetTranslation = Readonly<{
    /** The frame's footer row: where the widget leads. */
    open: (params: Readonly<{ destination: string }>) => string;
    /** The stale footer: last-known rows are shown because the refresh did not answer. */
    refreshFailed: string;
    latestRunsTitle: string;
    latestRunsLoading: string;
    latestRunsEmptyTitle: string;
    latestRunsEmptyReason: string;
    latestRunsErrorTitle: string;
    latestRunsErrorReason: string;
}>;


export const homeWidgetTranslationsEnglish = { en: {
        open: ({ destination }) => `Open ${destination}`,
        refreshFailed: 'Couldn’t refresh',
        latestRunsTitle: 'Latest runs',
        latestRunsLoading: 'Loading the latest runs',
        latestRunsEmptyTitle: 'No runs yet',
        latestRunsEmptyReason: 'When your automations run, how each run went shows up here.',
        latestRunsErrorTitle: 'Couldn’t load the latest runs',
        latestRunsErrorReason: 'Your Home didn’t answer. Check the connection, then try again.',
    } } satisfies Pick<Readonly<Record<string, HomeWidgetTranslation>>, "en">;