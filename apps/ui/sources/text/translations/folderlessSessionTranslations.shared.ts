

export type FolderlessSessionTranslations = typeof en;



export const en = {
    composer: {
        addFolder: 'Add folder',
        noFolder: 'No folder',
        noFolderDescription: 'Happier keeps a private folder for this chat',
        removeFolder: 'Remove folder',
        a11y: {
            folder: ({ path }: { path: string }) => `Folder: ${path}. Opens folder choices.`,
            none: 'No folder. Happier keeps a private folder for this chat. Add folder.',
            loading: 'Folder loading',
            noFolderRow: 'No folder, private folder for this chat',
            removed: 'Folder removed',
            set: ({ path }: { path: string }) => `Folder set to ${path}`,
        },
    },
    display: {
        chats: 'Chats',
        untitledChat: 'New chat',
        folder: 'Folder',
        privateToSession: 'Private to this session',
        sessionFiles: 'Session files',
        privateFolderOn: ({ machine }: { machine: string }) => `Private folder on ${machine}`,
    },
};


export const folderlessSessionTranslationsEnglish = { en: en };