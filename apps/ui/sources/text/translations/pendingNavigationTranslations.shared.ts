

export type Count = { count: number };



export const en = {
    nextWithCount: ({ count }: Count) => `${count} ${count === 1 ? 'needs' : 'need'} you`,
    next: 'Next', answeredElsewhere: 'Already answered',
    unavailableTitle: 'Couldn’t open the next request',
    unavailableBody: 'Some waiting sessions are unavailable. Reconnect and try again.',
    skippedUnavailable: ({ count }: Count) => `${count} unavailable ${count === 1 ? 'session was' : 'sessions were'} skipped.`,
    waitsForPermission: 'wants your permission',
    waitsForInput: 'is waiting for your answer',
    sessionsWaiting: ({ count }: Count) => `${count} sessions are waiting`,
    go: 'Go',
    dismiss: 'Not now',
};


export const pendingNavigationTranslationsEnglish = { en };