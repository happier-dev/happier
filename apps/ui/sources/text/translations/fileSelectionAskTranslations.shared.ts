export const fileSelectionAskTranslations = {
    en: { ask: 'Ask', comment: 'Comment', copy: 'Copy', toolbarLabel: 'Selection', moreWaysToAsk: 'More ways to ask', lineCount: ({ count }: { count: number }) => `${count} ${count === 1 ? 'line' : 'lines'}`, sideRun: 'Ask in a side run', targetTitle: 'Ask without a session', targetDescription: 'Where a question about a selection goes when no session is open.', detachedRun: 'Side run', newSession: 'New session' },
} as const;
