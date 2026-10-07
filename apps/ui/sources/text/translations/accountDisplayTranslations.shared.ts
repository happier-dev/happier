

export type AccountDisplayTranslation = Readonly<{
    unnamed: string;
    /** The viewer's own Account while it has no name. */
    yours: string;
    /** The short, stable id suffix that tells unnamed Accounts apart. */
    shortId: (params: Readonly<{ id: string }>) => string;
}>;


export const accountDisplayTranslationsEnglish = { en: { unnamed: 'Unnamed account', yours: 'Your account', shortId: ({ id }) => `ID …${id}` } } as const satisfies Pick<Record<string, AccountDisplayTranslation>, "en">;