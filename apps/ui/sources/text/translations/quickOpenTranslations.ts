import type { SupportedLanguage } from '../_all';

export type QuickOpenCopy = Readonly<{
    commands: { searchFiles: string; searchSymbols: string };
    search: { recent: string; changed: string; changedInFolder: string; openFile: string; showMore: string; symbolsNeedFile: string;
        searchEverything: string;
        noMatch: (params: { query: string; scope: string }) => string;
        filesInScope: (params: { scope: string }) => string;
        symbolsInFile: (params: { file: string }) => string;
        symbols: string;
        /** The symbol a preview lands on: "formatRetryLabel, line 3". */
        symbolAtLine: (params: { name: string; line: number }) => string;
        symbolsUnavailable: (params: { file: string }) => string;
        offline: (params: { machine: string }) => string };
}>;

export const quickOpenTranslations = {
    en: { commands: { searchFiles: 'Open file', searchSymbols: 'Go to symbol' }, search: { recent: 'Recent', changed: 'Changed in this session', changedInFolder: 'Changed files', openFile: 'Open file…', showMore: 'Show more', searchEverything: 'Search everything', noMatch: ({ query, scope }) => `No files match “${query}” in ${scope}`, symbolsNeedFile: 'Symbols need an open file', filesInScope: ({ scope }) => `Files in ${scope}`, symbolsUnavailable: ({ file }) => `Symbols for ${file} aren’t available yet`, symbols: 'Symbols', symbolAtLine: ({ name, line }) => `${name}, line ${line}`, symbolsInFile: ({ file }) => `Symbols in ${file}`, offline: ({ machine }) => `${machine} isn't answering. Showing files you opened recently.` } },
} satisfies Pick<Record<SupportedLanguage, QuickOpenCopy>, 'en'>;
