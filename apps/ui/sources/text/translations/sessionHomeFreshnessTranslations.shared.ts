

export function translated(value: typeof en): typeof en { return value; }



export const en = {
    offline: 'Offline',
    stale: "Couldn't refresh",
    lastUpdated: ({ ago }: { ago: string }) => `Last updated ${ago} ago`,
};


export const sessionHomeFreshnessTranslationsEnglish = { en };