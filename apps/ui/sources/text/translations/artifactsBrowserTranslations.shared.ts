

export type ArtifactsBrowserTranslations = Readonly<{
    description: string;
    newDocument: string;
    editDocument: string;
    searchPlaceholder: string;
    kindLabel: string;
    sourceLabel: string;
    kinds: Readonly<{
        all: string;
        document: string;
        prompt: string;
        memory: string;
        board: string;
        widget: string;
        workflow: string;
        role: string;
        launchProfile: string;
    }>;
    kindOne: Readonly<{
        document: string;
        prompt: string;
        memory: string;
        board: string;
        widget: string;
        workflow: string;
        role: string;
        launchProfile: string;
        dashboard: string;
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
        moveVerb: (params: { name: string }) => string;
        topLevel: string;
        moveToTopLevel: string;
        deleteFolder: string;
        deleteTitle: (params: Readonly<{ name: string }>) => string;
        deleteBody: string;
        nameHelp: string;
        emptyFolder: string;
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
        lastKnown: string;
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
    loadingBody: string;
    countSoFar: (params: Readonly<{ count: number }>) => string;
    noMatchSoFar: (params: Readonly<{ query: string }>) => string;
    quota: Readonly<{
        accountTitle: string;
        documentTitle: string;
        accountBody: (params: Readonly<{ used: string; limit: string }>) => string;
        documentBody: (params: Readonly<{ size: string; limit: string }>) => string;
    }>;
    /** A save refused because a newer version was saved meanwhile (`version_mismatch`). */
    conflict: Readonly<{ title: string; body: string }>;
    open: Readonly<{
        document: string;
        prompt: string;
        memory: string;
        board: string;
        widget: string;
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
        compareUnavailable: string;
        compareCurrentUnavailable: string;
        compareReviewedUnavailable: string;
        savedByUser: string;
        savedByAgentSession: string;
        restoredVersion: (params: Readonly<{ n: number }>) => string;
        acceptedSuggestion: string;
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
        suggestions: (params: Readonly<{ count: number }>) => string;
        version: (params: Readonly<{ n: number }>) => string;
        sharedWithTeam: (params: Readonly<{ team: string }>) => string;
        shared: string;
        onlyYou: string;
    }>;
    passage: Readonly<{
        comment: string;
        you: string;
        changed: string;
        openConversation: string;
        replied: (params: Readonly<{ name: string; time: string }>) => string;
        changedReason: (params: Readonly<{ n: number }>) => string;
        openRevision: (params: Readonly<{ n: number }>) => string;
        reattach: string;
        reattaching: string;
        attachHere: string;
        earlier: (params: Readonly<{ n: number; quote: string }>) => string;
        count: (params: Readonly<{ count: number }>) => string;
        countUnavailable: string;
        refineHint: string;
        noComments: string;
        noCommentsHint: string;
        commentsUnavailable: string;
        threadsTitle: string;
        refineFailed: string;
        threadDetail: (params: Readonly<{ who: string; n: number }>) => string;
        acceptedToast: (params: Readonly<{ n: number }>) => string;
    }>;
    proposal: Readonly<{
        title: string;
        titleBy: (params: Readonly<{ who: string }>) => string;
        basedOn: (params: Readonly<{ n: number }>) => string;
        current: (params: Readonly<{ n: number }>) => string;
        before: string;
        after: string;
        accept: string;
        decline: string;
        accepting: string;
        declining: string;
        movedOn: string;
        compare: string;
        cantEdit: string;
        failed: string;
        acceptedByYou: (params: Readonly<{ n: number }>) => string;
        acceptedBy: (params: Readonly<{ who: string; n: number }>) => string;
        declinedByYou: string;
        declinedBy: (params: Readonly<{ who: string }>) => string;
        undo: string;
        undone: (params: Readonly<{ n: number }>) => string;
        undoConflict: string;
        openHistory: string;
        someone: string;
        askRedo: string;
        redoRequest: string;
    }>;
}>;


export const artifactsBrowserTranslationsEnglish = { en: {
        description: 'What you and your agents saved — ready to read, reuse and share.',
        newDocument: 'New document',
        editDocument: 'Edit document',
        searchPlaceholder: 'Search artifacts',
        kindLabel: 'Kind',
        sourceLabel: 'Source',
        kinds: {
            all: 'All kinds',
            document: 'Documents',
            prompt: 'Prompts',
            memory: 'Memory',
            board: 'Boards',
            widget: 'Widgets',
            workflow: 'Workflows',
            role: 'Roles',
            launchProfile: 'Launch profiles',
        },
        kindOne: {
            document: 'Document',
            prompt: 'Prompt',
            memory: 'Memory',
            board: 'Board',
            widget: 'Widget',
            workflow: 'Workflow',
            role: 'Role',
            launchProfile: 'Launch profile',
            dashboard: 'Dashboard',
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
            moveVerb: ({ name }) => `Move to ${name}`,
            topLevel: 'Top level',
            moveToTopLevel: 'Move to the top level',
            deleteFolder: 'Delete folder',
            deleteTitle: ({ name }) => `Delete “${name}”?`,
            deleteBody: 'Its items and folders move up one level. Nothing is deleted.',
            nameHelp: 'Folders are yours alone. Filing something never changes it for the people it’s shared with.',
            emptyFolder: 'Empty',
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
            lastKnown: 'Showing your last known folders',
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
        loadFailedBody: 'Try again in a moment. Nothing was lost.',
        retainedBody: "Couldn’t refresh. Showing the last loaded artifacts.",
        loadingBody: 'Still loading the rest.',
        countSoFar: ({ count }) => `${count} loaded so far`,
        noMatchSoFar: ({ query }) => `Nothing matches “${query}” yet`,
        quota: {
            accountTitle: 'Artifact storage is full',
            documentTitle: 'Too large to save',
            accountBody: ({ used, limit }) => `${used} of ${limit} used, versions included. Delete or export artifacts you no longer need to save new ones.`,
            documentBody: ({ size, limit }) => `This would be ${size}; each artifact can hold up to ${limit}. Your edits are still here.`,
        },
        conflict: {
            title: 'Changed while you edited',
            body: 'A newer version was saved. Your edits are still here — review the current version before you save.',
        },
        open: {
            document: 'Open document',
            prompt: 'Open prompt',
            memory: 'Open memory',
            board: 'Open board',
            widget: 'Open widget',
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
            compareUnavailable: 'Comparison unavailable',
            compareCurrentUnavailable: 'The current version isn’t available in this History view. You can still read earlier versions.',
            compareReviewedUnavailable: 'The reviewed version is no longer in the retained history. You can still read the available versions.',
            savedByUser: 'Saved by user',
            savedByAgentSession: 'Saved by agent session',
            restoredVersion: ({ n }) => `Restored from version ${n}`,
            acceptedSuggestion: 'Accepted suggestion',
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
            version: ({ n }) => `Version ${n}`,
            sharedWithTeam: ({ team }) => `Shared with ${team}`,
            shared: 'Shared',
            onlyYou: 'Only you',
            suggestions: ({ count }) => count === 1 ? '1 suggestion' : `${count} suggestions`,
        },
        passage: {
            comment: 'Comment',
            you: 'You',
            changed: 'Changed',
            openConversation: 'Open conversation',
            replied: ({ name, time }) => `${name} replied · ${time}`,
            changedReason: ({ n }) => `This passage changed after the comment. The quote is from version ${n}.`,
            openRevision: ({ n }) => `Open version ${n}`,
            reattach: 'Attach to new text',
            reattaching: 'Select the text it belongs to now.',
            attachHere: 'Attach here',
            earlier: ({ n, quote }) => `Earlier on version ${n}: “${quote}”`,
            count: ({ count }) => `${count} ${count === 1 ? 'conversation' : 'conversations'}`,
            countUnavailable: 'Comment count unavailable',
            refineHint: 'Select the words to comment on',
            noComments: 'No comments yet',
            noCommentsHint: 'Select text to comment, or mention an agent to have it answer or propose an edit.',
            commentsUnavailable: 'Comments aren’t available right now.',
            threadsTitle: 'Conversations',
            refineFailed: 'Couldn’t place that selection. Select the words again.',
            threadDetail: ({ who, n }) => n === 0 ? who : `${who} · ${n} ${n === 1 ? 'reply' : 'replies'}`,
            acceptedToast: ({ n }) => `Accepted · version ${n}`,
        },
        proposal: {
            title: 'Suggested edit',
            titleBy: ({ who }) => `${who} suggests an edit`,
            basedOn: ({ n }) => `Based on version ${n}`,
            current: ({ n }) => `Version ${n} · current`,
            before: 'Before',
            after: 'After',
            accept: 'Accept',
            decline: 'Decline',
            accepting: 'Accepting… checking the document hasn’t changed',
            declining: 'Declining…',
            movedOn: 'The document changed after this suggestion. Nothing was applied.',
            compare: 'Compare',
            cantEdit: 'Only people who can edit this document can accept it.',
            failed: 'Couldn’t save your decision. Try again.',
            acceptedByYou: ({ n }) => `You accepted the edit · now version ${n}`,
            acceptedBy: ({ who, n }) => `${who} accepted the edit · now version ${n}`,
            declinedByYou: 'You declined the suggestion · the document didn’t change',
            declinedBy: ({ who }) => `${who} declined the suggestion · the document didn’t change`,
            undo: 'Undo',
            undone: ({ n }) => `Undone · now version ${n}`,
            undoConflict: 'Undo would overwrite newer edits. Open history to restore an earlier version.',
            openHistory: 'Open history',
            someone: 'Someone',
            askRedo: 'Ask to redo',
            redoRequest: 'The document changed after your suggestion. Could you suggest it again on the current version?',
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "en">;
