

export const en = {
    title: ({ machine }: { machine: string }) => `This chat’s private folder is no longer on ${machine}.`,
    body: 'You can continue in a fresh, empty folder. Your chat history will stay here, but local files from the old folder will not be restored.',
    continue: 'Continue in a fresh folder',
    notNow: 'Not now',
    offlineDelete: ({ machine }: { machine: string }) => `Its private folder on ${machine} will stay until you remove it from Storage.`,
    filesNotRemoved: ({ machine }: { machine: string }) => `Files on ${machine} were not removed.`,
};


export const sessionDirectoryRecoveryTranslationsEnglish = { en } satisfies Pick<Record<import('../_all').SupportedLanguage, typeof en>, "en">;