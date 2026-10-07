

export type FindTranslations = Readonly<{
    open: string;
    openedForMatch: string;
    foldAgain: string;
    showHiddenLines: (params: Readonly<{ count: number }>) => string;
    surface: Readonly<{
        chat: string;
        changes: string;
        file: string;
        terminal: (params: Readonly<{ name: string }>) => string;
    }>;
    previous: string;
    next: string;
    matchCase: string;
    regex: string;
    /** The regex switch's printed name on the phone's options row. */
    regexShort: string;
    /** The phone's options disclosure. */
    options: string;
    close: string;
    done: string;
    stop: string;
    noMatches: string;
    noneFound: string;
    invalidPattern: string;
    offline: string;
    unsupported: string;
    /** "3 of 8" with a current match, "8 matches" without one. */
    count: (params: Readonly<{ current: number | null; total: number }>) => string;
    files: (params: Readonly<{ count: number }>) => string;
    soFar: string;
    loaded: string;
    note: Readonly<{
        searchingOlder: string;
        offlineOlder: string;
        terminalKept: (params: Readonly<{ lines: string }>) => string;
    }>;
}>;



export function slavicPlural(count: number, one: string, few: string, many: string): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (count === 1) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}



export function russianPlural(count: number, one: string, few: string, many: string): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}



export const en: FindTranslations = {
    open: 'Find…',
    openedForMatch: 'Opened for a match', foldAgain: 'Fold again', showHiddenLines: ({ count }) => `Show ${count} hidden ${count === 1 ? 'line' : 'lines'}`,
    surface: {
        chat: 'Find in chat',
        changes: 'Find in changes',
        file: 'Find in file',
        terminal: ({ name }) => `Find in ${name}`,
    },
    previous: 'Previous match',
    next: 'Next match',
    matchCase: 'Match case',
    regex: 'Use regular expression',
    regexShort: 'Regular expression',
    options: 'Match options',
    close: 'Close Find',
    done: 'Done',
    stop: 'Stop',
    noMatches: 'No matches',
    noneFound: 'None found',
    invalidPattern: 'Invalid pattern',
    offline: 'Offline',
    unsupported: 'Not searchable here',
    count: ({ current, total }) => (current === null ? `${total} ${total === 1 ? 'match' : 'matches'}` : `${current} of ${total}`),
    files: ({ count }) => `${count} ${count === 1 ? 'file' : 'files'}`,
    soFar: 'so far',
    loaded: 'loaded',
    note: {
        searchingOlder: 'Looking through older messages, decrypted on this device',
        offlineOlder: 'Older messages can be searched once you’re back online.',
        terminalKept: ({ lines }) => `Searched the last ${lines} lines this terminal keeps.`,
    },
};


export const findTranslationsEnglish = { en };