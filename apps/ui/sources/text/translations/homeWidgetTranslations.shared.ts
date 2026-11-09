

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
    /** The "Your Home" widget: the Home as a planet, its machines as moons (atmosphere moment). */
    yourHomeTitle: string;
    yourHomeDescription: string;
    yourHomeOnline: (params: Readonly<{ online: number; total: number }>) => string;
    yourHomeSessions: (params: Readonly<{ count: number }>) => string;
    yourHomeWorking: (params: Readonly<{ count: number }>) => string;
    yourHomeOffline: (params: Readonly<{ lastSeen: string }>) => string;
    yourHomeEmptyTitle: string;
    yourHomeEmptyBody: string;
    /** Machines that do not fit the legend, as one row. */
    yourHomeMore: (params: Readonly<{ count: number }>) => string;
}>;


export const homeWidgetTranslationsEnglish = { en: {
        open: ({ destination }) => `Open ${destination}`,
        refreshFailed: 'Couldn’t refresh',
        latestRunsTitle: 'Latest runs',
        latestRunsLoading: 'Loading the latest runs',
        latestRunsEmptyTitle: 'No runs yet',
        latestRunsEmptyReason: 'Each workflow run shows here, with how it went.',
        latestRunsErrorTitle: 'Couldn’t load the latest runs',
        latestRunsErrorReason: 'Your Home didn’t answer. Check the connection, then try again.',
        yourHomeTitle: 'Your Home',
        yourHomeDescription: 'Your machines circling your Home, and what needs you',
        yourHomeOnline: ({ online, total }) => `${online} of ${total} online`,
        yourHomeSessions: ({ count }) => (count === 1 ? '1 session' : `${count} sessions`),
        yourHomeWorking: ({ count }) => `${count} working`,
        yourHomeOffline: ({ lastSeen }) => `Offline · last seen ${lastSeen}`,
        yourHomeEmptyTitle: 'No machines yet',
        yourHomeEmptyBody: 'Machines circle your Home once they join.',
        yourHomeMore: ({ count }) => `${count} more`,
    } } satisfies Pick<Readonly<Record<string, HomeWidgetTranslation>>, "en">;
