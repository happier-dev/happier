

export type ArtifactsBrowserTranslations = Readonly<{
    description: string;
    newDocument: string;
    searchPlaceholder: string;
    kindLabel: string;
    sourceLabel: string;
    kinds: Readonly<{
        all: string;
        document: string;
        prompt: string;
        memory: string;
        board: string;
        workflow: string;
        role: string;
        launchProfile: string;
    }>;
    kindOne: Readonly<{
        document: string;
        prompt: string;
        memory: string;
        board: string;
        workflow: string;
        role: string;
        launchProfile: string;
    }>;
    sort: Readonly<{
        label: string;
        updated_desc: string;
        created_desc: string;
        title_asc: string;
    }>;
    view: Readonly<{
        label: string;
        grid: string;
        list: string;
        folders: string;
    }>;
    folders: Readonly<{
        newFolder: string;
        newFolderInside: string;
        rename: string;
        moveTo: string;
        moveItemTo: (params: Readonly<{ name: string }>) => string;
        newFolderEllipsis: string;
        moveVerb: string;
        topLevel: string;
        moveToTopLevel: string;
        deleteFolder: string;
        deleteTitle: (params: Readonly<{ name: string }>) => string;
        deleteBody: string;
        nameHelp: string;
        namePlaceholder: string;
        create: string;
        options: (params: Readonly<{ name: string }>) => string;
        expand: (params: Readonly<{ name: string }>) => string;
        collapse: (params: Readonly<{ name: string }>) => string;
        columnName: string;
        columnEdited: string;
        emptyInvite: string;
        unavailable: string;
        saveFailed: string;
        refusedCycle: string;
        refusedUnavailable: string;
        refusedOther: string;
        showAllKinds: string;
        promptSearch: string;
    }>;
    provenance: Readonly<{
        savedByYou: string;
        sharedWithYou: string;
        fromFile: (params: Readonly<{ name: string }>) => string;
        openSession: (params: Readonly<{ session: string }>) => string;
    }>;
    emptyTitle: string;
    emptyBody: string;
    emptyHint: string;
    loadFailedTitle: string;
    loadFailedBody: string;
    retainedBody: string;
    quota: Readonly<{
        accountTitle: string;
        documentTitle: string;
        accountBody: (params: Readonly<{ used: string; limit: string }>) => string;
        documentBody: (params: Readonly<{ size: string; limit: string }>) => string;
    }>;
    open: Readonly<{
        document: string;
        prompt: string;
        memory: string;
        board: string;
        workflow: string;
        role: string;
        launchProfile: string;
    }>;
    openAsPage: string;
    actions: Readonly<{
        edit: string;
        history: string;
        share: string;
        more: string;
        copyLink: string;
        linkCopied: string;
    }>;
    history: Readonly<{
        title: string;
        current: string;
        now: string;
        restoreNote: string;
        loadFailed: string;
        empty: string;
        versionsLabel: string;
        restoreFailed: string;
        savedByUser: string;
        savedByAgentSession: string;
        restoredVersion: (params: Readonly<{ n: number }>) => string;
        version: (params: Readonly<{ n: number }>) => string;
        keeps: (params: Readonly<{ count: number }>) => string;
        restore: (params: Readonly<{ n: number }>) => string;
    }>;
    savedToday: (params: Readonly<{ count: number }>) => string;
    noMatch: (params: Readonly<{ query: string }>) => string;
    storage: Readonly<{
        meter: (params: Readonly<{ used: string; limit: string }>) => string;
        a11y: (params: Readonly<{ used: string; limit: string }>) => string;
    }>;
    facts: Readonly<{
        edited: (params: Readonly<{ age: string }>) => string;
    }>;
}>;


export const artifactsBrowserTranslationsEnglish = { en: {
        description: 'What you and your agents saved — ready to read, reuse and share.',
        newDocument: 'New document',
        searchPlaceholder: 'Search artifacts',
        kindLabel: 'Kind',
        sourceLabel: 'Source',
        kinds: {
            all: 'All kinds',
            document: 'Documents',
            prompt: 'Prompts',
            memory: 'Memory',
            board: 'Boards',
            workflow: 'Workflows',
            role: 'Roles',
            launchProfile: 'Launch profiles',
        },
        kindOne: {
            document: 'Document',
            prompt: 'Prompt',
            memory: 'Memory',
            board: 'Board',
            workflow: 'Workflow',
            role: 'Role',
            launchProfile: 'Launch profile',
        },
        sort: {
            label: 'Sort',
            updated_desc: 'Recently updated',
            created_desc: 'Recently created',
            title_asc: 'Title',
        },
        view: {
            label: 'View',
            grid: 'Grid',
            list: 'List',
            folders: 'Folders',
        },
        folders: {
            newFolder: 'New folder',
            newFolderInside: 'New folder inside',
            rename: 'Rename',
            moveTo: 'Move to folder…',
            moveItemTo: ({ name }) => `Move “${name}” to`,
            newFolderEllipsis: 'New folder…',
            moveVerb: 'Move to',
            topLevel: 'Top level',
            moveToTopLevel: 'Move to the top level',
            deleteFolder: 'Delete folder',
            deleteTitle: ({ name }) => `Delete “${name}”?`,
            deleteBody: 'Its items and folders move up one level. Nothing is deleted.',
            nameHelp: 'Folders are yours alone. Filing something never changes it for the people it’s shared with.',
            namePlaceholder: 'Folder name',
            create: 'Create',
            options: ({ name }) => `${name} options`,
            expand: ({ name }) => `Expand ${name}`,
            collapse: ({ name }) => `Collapse ${name}`,
            columnName: 'Name',
            columnEdited: 'Edited',
            emptyInvite: 'No folders yet. Group what belongs together; only you see how you file things.',
            unavailable: 'Folders couldn’t be loaded from this Home. Everything is listed without them.',
            saveFailed: 'That change didn’t save. Try again.',
            refusedCycle: 'A folder can’t move into itself',
            refusedUnavailable: 'Folders are unavailable right now',
            refusedOther: 'It can’t move there',
            showAllKinds: 'Show every kind in Artifacts',
            promptSearch: 'Search prompts and skills',
        },
        provenance: {
            savedByYou: 'Saved by you',
            sharedWithYou: 'Shared with you',
            fromFile: ({ name }) => `From ${name}`,
            openSession: ({ session }) => `Open ${session}`,
        },
        emptyTitle: 'Keep what your agents make',
        emptyBody: 'Plans, notes, code and boards you or your agents save land here — readable on every device and ready to share with your Teams.',
        emptyHint: 'Or ask an agent to “save that as an artifact”.',
        loadFailedTitle: 'Couldn’t load your artifacts',
        loadFailedBody: 'Check your connection, then try again. Nothing was lost.',
        retainedBody: "Couldn’t refresh. Showing the last loaded artifacts.",
        quota: {
            accountTitle: 'Artifact storage is full',
            documentTitle: 'Too large to save',
            accountBody: ({ used, limit }) => `${used} of ${limit} used, versions included. Delete or export artifacts you no longer need to save new ones.`,
            documentBody: ({ size, limit }) => `This would be ${size}; each artifact can hold up to ${limit}. Your edits are still here.`,
        },
        open: {
            document: 'Open document',
            prompt: 'Open prompt',
            memory: 'Open memory',
            board: 'Open board',
            workflow: 'Open workflow',
            role: 'Open role',
            launchProfile: 'Open launch profile',
        },
        openAsPage: 'Open as page',
        actions: {
            edit: 'Edit',
            history: 'History',
            share: 'Share',
            more: 'More actions',
            copyLink: 'Copy link',
            linkCopied: 'Link copied',
        },
        history: {
            title: 'History',
            current: 'Current',
            now: 'Now',
            restoreNote: 'Restoring adds it as a new version. Nothing is lost.',
            loadFailed: 'Couldn’t load the history. Try again.',
            empty: 'No earlier versions yet. Each save keeps one.',
            versionsLabel: 'Versions',
            restoreFailed: 'Couldn’t restore this version. Try again.',
            savedByUser: 'Saved by user',
            savedByAgentSession: 'Saved by agent session',
            restoredVersion: ({ n }) => `Restored from version ${n}`,
            version: ({ n }) => `Version ${n}`,
            keeps: ({ count }) => `Keeps the last ${count} versions.`,
            restore: ({ n }) => `Restore version ${n}`,
        },
        savedToday: ({ count }) => `${count} saved today`,
        noMatch: ({ query }) => `No artifacts match “${query}”`,
        storage: {
            meter: ({ used, limit }) => `${used} of ${limit}`,
            a11y: ({ used, limit }) => `Artifact storage, ${used} of ${limit} used`,
        },
        facts: {
            edited: ({ age }) => `Edited ${age}`,
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "en">;
