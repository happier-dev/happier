

export type SurfaceStateTranslations = Readonly<{
    stillWaiting: (params: Readonly<{ seconds: number }>) => string;
    asOf: (params: Readonly<{ time: string }>) => string;
    howItWorks: string;
    tryAgain: string;
    checkAgain: string;
    paneFailedTitle: string;
    paneFailedReason: string;
    opening: (params: Readonly<{ name: string }>) => string;
    couldNotOpen: (params: Readonly<{ name: string }>) => string;
}>;


export const surfaceStateTranslationsEnglish = { en: {
        stillWaiting: ({ seconds }) => `Still waiting · ${seconds} s`,
        asOf: ({ time }) => `As of ${time}`,
        howItWorks: 'How it works',
        tryAgain: 'Try again',
        checkAgain: 'Check again',
        paneFailedTitle: 'Couldn’t show this pane',
        paneFailedReason: 'Something went wrong while drawing it. Your session isn’t affected.',
        opening: ({ name }) => `Opening ${name}`,
        couldNotOpen: ({ name }) => `Couldn’t open ${name}`,
    } } as const satisfies Pick<Record<string, SurfaceStateTranslations>, "en">;