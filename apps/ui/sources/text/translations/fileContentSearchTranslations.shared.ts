


export const fileContentSearchTranslationsEnglish = { "en": {
        allMatches: ({ matches, files }: { matches: number; files: number }) => `All ${matches} matches in ${files} files`,
        moreMatches: "All matches",
        searchInFolder: ({ name }: { name: string }) => `Search in ${name}`,
        matchesInFiles: ({ matches, files }: { matches: number; files: number }) => `${matches} matches in ${files} files`,
        textInFiles: "Text in files",
        textInScope: ({ scope }: { scope: string }) => `Text in ${scope}`,
        atLine: ({ line }: { line: number }) => `line ${line}`,
        everything: "Search everything",
        refineSearch: "Refine your search",
        partial: "Some files could not be searched. Results shown are incomplete.",
        noTextMatches: ({ scope, query }: { scope: string; query: string }) => `No text in ${scope} matches “${query}”`,
        noTextMatchesPartial: ({ scope, query }: { scope: string; query: string }) => `No searchable text in ${scope} matches “${query}” · some files couldn’t be read`,
        updateRequired: "Update Happier on this machine to search text in files.",
        invalidPattern: "The regular expression is invalid. Edit the pattern and try again.",
        unavailable: "Text search is unavailable. Check the machine connection.",
        noFolder: "Open a project or folder to search the text in its files.",
        placeholder: "Search files, sessions, settings and more",
        matchCase: "Match case",
        regex: "Regular expression",
        findMode: "Find in",
        findFiles: "Files",
        findText: "Text",
    } };
