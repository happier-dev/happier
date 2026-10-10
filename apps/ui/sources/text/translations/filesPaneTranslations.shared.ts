

export type FilesPaneTranslations = Readonly<{
    changedOnly: string;
    showAllFiles: string;
    viewOptions: string;
    sizeAndDate: string;
    newMenu: string;
    newFile: string;
    newFolder: string;
    noChangedFilesTitle: string;
    noChangedFilesReason: string;
    rootErrorTitle: (params: Readonly<{ machine: string }>) => string;
    rootErrorTitleUnnamed: string;
    workspaceUnavailableReason: string;
}>;


export const filesPaneTranslationsEnglish = { en: {
        changedOnly: 'Changed only',
        showAllFiles: 'Show all files',
        viewOptions: 'View options',
        sizeAndDate: 'Size and date',
        newMenu: 'New file, new folder or upload',
        newFile: 'New file',
        newFolder: 'New folder',
        noChangedFilesTitle: 'Nothing has changed',
        noChangedFilesReason: 'The working copy matches the last commit.',
        rootErrorTitle: ({ machine }) => `Couldn’t list files on ${machine}`,
        rootErrorTitleUnnamed: 'Couldn’t list files',
        workspaceUnavailableReason: 'Happier could not resolve a machine and folder for this session.',
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "en">;
