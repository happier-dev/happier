

export type TurnChangesTranslations = { -readonly [Key in keyof typeof en]: (typeof en)[Key] };



export function translated(value: TurnChangesTranslations): TurnChangesTranslations {
    return value;
}



export const en = {
    edited: ({ count }: { count: number }) => `Edited ${count} ${count === 1 ? 'file' : 'files'}`,
    walkThrough: 'Walk me through',
    openInFiles: 'Open in Files',
    fileCount: ({ count }: { count: number }) => `${count} ${count === 1 ? 'file' : 'files'}`,
    fileCountInFolders: ({ count, folders }: { count: number; folders: number }) =>
        `${count} ${count === 1 ? 'file' : 'files'} in ${folders} folders`,
    showMore: ({ count }: { count: number }) => `Show ${count} more`,
    groupA11y: 'Changes in this turn',
};


export const turnChangesTranslationsEnglish = { en: { turnChanges: { card: en as TurnChangesTranslations } } } as const;