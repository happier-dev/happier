

export type ArtifactsBrowserTranslations = Readonly<{
    description: string;
    newDocument: string;
    editDocument: string;
    searchPlaceholder: string;
    kindLabel: string;
    sourceLabel: string;
    kinds: Readonly<{
        home: string;
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
        size_desc: string;
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
        documentBody: (params: Readonly<{ size: string; limit: string; editsPreserved?: boolean }>) => string;
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
    homeEmpty: string;
    showAllKinds: string;
    storage: Readonly<{
        meter: (params: Readonly<{ used: string; limit: string }>) => string;
        a11y: (params: Readonly<{ used: string; limit: string }>) => string;
        total: (params: Readonly<{ size: string }>) => string;
        totalAtLeast: (params: Readonly<{ size: string }>) => string;
        totalA11y: (params: Readonly<{ size: string }>) => string;
        totalAtLeastA11y: (params: Readonly<{ size: string }>) => string;
        artifactsPart: (params: Readonly<{ size: string }>) => string;
        column: string;
        sizeUnknown: string;
    }>;
    storageView: Readonly<{
        title: string;
        description: string;
        settingsSubtitle: string;
        searchKeywords: string;
        say: Readonly<{
            stored: (params: Readonly<{ size: string }>) => string;
            storedAtLeast: (params: Readonly<{ size: string }>) => string;
            mostly: (params: Readonly<{ kind: string }>) => string;
            largest: (params: Readonly<{ kind: string }>) => string;
            nearlyFull: string;
            nearBody: (params: Readonly<{ used: string; limit: string }>) => string;
            failed: string;
            failedBody: string;
            loading: string;
        }>;
        account: Readonly<{
            title: string;
            stored: string;
            storedAtLeast: string;
            noLimit: string;
            barLabel: (params: Readonly<{ size: string }>) => string;
            unmeasured: string;
        }>;
        limit: Readonly<{
            title: string;
            leftOf: (params: Readonly<{ limit: string }>) => string;
            fullOf: (params: Readonly<{ limit: string }>) => string;
            left: (params: Readonly<{ size: string }>) => string;
            nothingLeft: string;
            note: string;
            barLabel: (params: Readonly<{ used: string; limit: string }>) => string;
        }>;
        kinds: Readonly<{
            title: string;
            note: string;
            sizeNotRecorded: string;
            petsLimit: (params: Readonly<{ limit: string }>) => string;
            names: Readonly<{
                artifacts: string;
                artifactOldVersions: string;
                pluginArtifacts: string;
                discussionAttachments: string;
                accountPets: string;
                pluginCollections: string;
                profilePictures: string;
                avatars: string;
                teamLogos: string;
            }>;
            shortNames: Readonly<{
                artifacts: string;
                artifactOldVersions: string;
                pluginArtifacts: string;
                discussionAttachments: string;
                accountPets: string;
                pluginCollections: string;
                profilePictures: string;
                avatars: string;
                teamLogos: string;
            }>;
            facts: Readonly<{
                artifacts: string;
                artifactOldVersions: string;
                pluginArtifacts: string;
                discussionAttachments: string;
                accountPets: string;
                pluginCollections: string;
                profilePictures: string;
                avatars: string;
                teamLogos: string;
            }>;
        }>;
        items: Readonly<{
            title: string;
            note: string;
            filterLabel: string;
            all: string;
            shapeLabel: string;
            list: string;
            map: string;
            name: string;
            kind: string;
            changed: string;
            size: string;
            foot: (params: Readonly<{ shown: string; total: string }>) => string;
            showMore: string;
            nameNotReadable: string;
            where: string;
            mapHint: string;
            smaller: (params: Readonly<{ count: string }>) => string;
            mapLabel: string;
            listLabel: string;
            rowLabel: (params: Readonly<{ name: string; kind: string; size: string }>) => string;
            none: string;
            onlyArtifacts: string;
            showOldVersions: string;
            deleteEllipsis: string;
            deleteOldVersions: string;
            titles: Readonly<{
                discussionAttachments: string;
                accountPets: string;
                pluginCollections: string;
                profilePictures: string;
                avatars: string;
                teamLogos: string;
            }>;
            oldVersionsWhere: (params: Readonly<{ where: string }>) => string;
        }>;
        empty: Readonly<{
            title: string;
            body: string;
            action: string;
        }>;
        ask: Readonly<{
            title: string;
            note: string;
            free: Readonly<{
                title: string;
                body: string;
                prompt: string;
            }>;
            artifacts: Readonly<{
                title: string;
                body: string;
                prompt: string;
            }>;
            attachments: Readonly<{
                title: string;
                body: string;
                prompt: string;
            }>;
        }>;
        seeUsage: string;
        showBiggest: string;
        openStorage: string;
        discussion: Readonly<{
            row: (params: Readonly<{ size: string }>) => string;
            description: string;
            say: (params: Readonly<{ size: string; count: string }>) => string;
            sayBody: string;
            ofAccount: string;
            ofAccountFigure: (params: Readonly<{ total: string }>) => string;
            byline: (params: Readonly<{ author: string; date: string }>) => string;
            showInMessage: string;
            download: string;
            removeFile: string;
        }>;
        confirm: Readonly<{
            removeTitle: (params: Readonly<{ name: string }>) => string;
            removeOwnBody: (params: Readonly<{ discussion: string }>) => string;
            removeOtherBody: (params: Readonly<{ discussion: string }>) => string;
            removeConfirm: string;
            trimTitle: (params: Readonly<{ title: string }>) => string;
            removeBody: string;
            trimBody: string;
            trimConfirm: string;
            freesLabel: string;
            limitAfterLabel: string;
            limitAfterValue: (params: Readonly<{ left: string; limit: string }>) => string;
        }>;
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
        changedReason: string;
        openRevision: (params: Readonly<{ n: number }>) => string;
        reattach: string;
        reattaching: string;
        attachHere: string;
        earlier: (params: Readonly<{ n: number; quote: string }>) => string;
        count: (params: Readonly<{ count: number }>) => string;
        countUnavailable: string;
        replyPlaceholder: string;
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
        publicationUnknown?: string;
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
        outsideSelection: string;
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
            home: 'Documents & files',
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
            size_desc: 'Largest first',
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
        countSoFar: ({ count }) => `${count} ${count === 1 ? 'artifact' : 'artifacts'} loaded so far`,
        noMatchSoFar: ({ query }) => `Nothing matches “${query}” yet`,
        quota: {
            accountTitle: 'Artifact storage is full',
            documentTitle: 'Too large to save',
            accountBody: ({ used, limit }) => `${used} of ${limit} used, versions included. Delete or export artifacts you no longer need to save new ones.`,
            documentBody: ({ size, limit, editsPreserved }) => `This would be ${size}; each artifact can hold up to ${limit}.${editsPreserved === false ? '' : ' Your edits are still here.'}`,
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
        homeEmpty: 'Documents, images and memories you create or share appear here',
        showAllKinds: 'Show all kinds',
        storage: {
            meter: ({ used, limit }) => `${used} of ${limit}`,
            a11y: ({ used, limit }) => `Artifact storage, ${used} of ${limit} used`,
            total: ({ size }) => `${size} stored`,
            totalAtLeast: ({ size }) => `${size} stored or more`,
            totalA11y: ({ size }) => `Your Account stores ${size}`,
            totalAtLeastA11y: ({ size }) => `Your Account stores at least ${size}. Profile pictures, avatars and Team logos aren’t counted.`,
            artifactsPart: ({ size }) => `${size} with old versions`,
            column: 'Size',
            sizeUnknown: 'Size not known yet',
        },
        storageView: {
            title: 'Storage',
            description: 'What your Account keeps on this server, and what you can clear.',
            settingsSubtitle: 'What your Account keeps on this server',
            searchKeywords: 'storage, space, size, limit, quota, files, attachments, old versions',
            say: {
                stored: ({ size }) => `${size} stored.`,
                storedAtLeast: ({ size }) => `At least ${size} stored.`,
                mostly: ({ kind }) => `Most of it is ${kind}.`,
                largest: ({ kind }) => `${kind} take the most space.`,
                nearlyFull: 'Nearly full.',
                nearBody: ({ used, limit }) => `${used} of your ${limit} Artifact limit is used.`,
                failed: 'Storage couldn’t be read.',
                failedBody: 'Nothing was changed.',
                loading: 'Reading what your Account stores',
            },
            account: {
                title: 'Your Account',
                stored: 'stored',
                storedAtLeast: 'stored or more',
                noLimit: 'No storage limit is set on this server.',
                barLabel: ({ size }) => `Your Account stores ${size}`,
                unmeasured: 'size not recorded',
            },
            limit: {
                title: 'Artifact limit',
                leftOf: ({ limit }) => `left of ${limit}`,
                fullOf: ({ limit }) => `of ${limit} · full`,
                left: ({ size }) => `${size} left`,
                nothingLeft: 'Nothing left',
                note: 'Artifacts and their old versions count toward it. Pets and plugin data have their own limits.',
                barLabel: ({ used, limit }) => `Artifact limit: ${used} of ${limit} used`,
            },
            kinds: {
                title: 'What’s stored',
                note: 'sized as you save, no scan needed',
                sizeNotRecorded: 'Size not recorded',
                petsLimit: ({ limit }) => `of ${limit}`,
                names: {
                    artifacts: 'Artifacts',
                    artifactOldVersions: 'Old versions',
                    pluginArtifacts: 'Plugin Artifacts',
                    discussionAttachments: 'Discussion attachments',
                    accountPets: 'Pets',
                    pluginCollections: 'Plugin data',
                    profilePictures: 'Profile picture',
                    avatars: 'Avatars',
                    teamLogos: 'Team logos',
                },
                shortNames: {
                    artifacts: 'Artifacts',
                    artifactOldVersions: 'Old versions',
                    pluginArtifacts: 'Plugin Artifacts',
                    discussionAttachments: 'Attachments',
                    accountPets: 'Pets',
                    pluginCollections: 'Plugin data',
                    profilePictures: 'Picture',
                    avatars: 'Avatars',
                    teamLogos: 'Team logos',
                },
                facts: {
                    artifacts: 'Documents, boards and files',
                    artifactOldVersions: 'History kept for your Artifacts',
                    pluginArtifacts: 'Saved by plugins for you',
                    discussionAttachments: 'Files in Discussions you own',
                    accountPets: 'Pets you imported',
                    pluginCollections: 'Kept by plugins; each one manages its own',
                    profilePictures: 'The picture on your public profile',
                    avatars: 'Pictures you uploaded',
                    teamLogos: 'Logos of Teams you own',
                },
            },
            items: {
                title: 'Biggest items',
                note: 'open one to see it where it lives',
                filterLabel: 'Show',
                all: 'All',
                shapeLabel: 'Show as',
                list: 'List',
                map: 'Map',
                name: 'Name',
                kind: 'Kind',
                changed: 'Changed',
                size: 'Size',
                foot: ({ shown, total }) => `The ${shown} biggest of ${total}`,
                showMore: 'Show more',
                nameNotReadable: 'Name not readable on this device',
                where: 'Artifacts',
                mapHint: 'Area is stored size · press a tile to open it',
                smaller: ({ count }) => `${count} smaller`,
                mapLabel: 'Biggest items by stored size',
                listLabel: 'Biggest items',
                rowLabel: ({ name, kind, size }) => `${name}, ${kind}, ${size}`,
                none: 'Nothing listed here yet',
                onlyArtifacts: 'Lists Artifacts. The other kinds show their totals above.',
                showOldVersions: 'Show old versions',
                deleteEllipsis: 'Delete…',
                deleteOldVersions: 'Delete old versions…',
                titles: {
                    discussionAttachments: 'File in a Discussion',
                    accountPets: 'Pet',
                    pluginCollections: 'Plugin data',
                    profilePictures: 'Profile picture',
                    avatars: 'Avatar',
                    teamLogos: 'Team logo',
                },
                oldVersionsWhere: ({ where }) => `Old versions · ${where}`,
            },
            empty: {
                title: 'Nothing stored yet',
                body: 'Artifacts you and your agents save, files attached in Discussions and Pets you import appear here with their size.',
                action: 'Open Artifacts',
            },
            ask: {
                title: 'Ask an agent',
                note: 'It can read this page and propose deletions. Nothing is deleted without your approval.',
                free: {
                    title: 'What can I delete to free up space?',
                    body: 'Proposes a list; you approve each item',
                    prompt: 'Read my Account storage and propose what I could delete to free up space. List each item with its size and why it can go. Do not delete anything until I approve each one.',
                },
                artifacts: {
                    title: 'Which Artifacts take the most space?',
                    body: 'Reads the same storage view',
                    prompt: 'Read my Account storage and list my largest Artifacts with their sizes, and say which of them look safe to clear. Do not delete anything.',
                },
                attachments: {
                    title: 'Which Discussions hold the most files?',
                    body: 'Reads the same storage view',
                    prompt: 'Read my Account storage and tell me which of my Discussions hold the most attached files, with their sizes. Do not delete anything.',
                },
            },
            seeUsage: 'See what’s using space',
            showBiggest: 'Show biggest Artifacts',
            openStorage: 'Opens Storage',
            discussion: {
                row: ({ size }) => `Storage · ${size}`,
                description: 'Files in this Discussion',
                say: ({ size, count }) => `${size} in ${count} files.`,
                sayBody: 'Each file stays with its message.',
                ofAccount: 'Of your Account',
                ofAccountFigure: ({ total }) => `of ${total}`,
                byline: ({ author, date }) => `${author} · ${date}`,
                showInMessage: 'Show in the message',
                download: 'Download',
                removeFile: 'Remove file…',
            },
            confirm: {
                removeTitle: ({ name }) => `Remove “${name}”?`,
                removeOwnBody: ({ discussion }) => `Your message in ${discussion} stays and shows that the file was removed. Nobody can open it after this.`,
                removeOtherBody: ({ discussion }) => `The message in ${discussion} stays and shows that the file was removed. Nobody can open it after this.`,
                removeConfirm: 'Remove file',
                trimTitle: ({ title }) => `Delete the old versions of “${title}”?`,
                removeBody: 'The message stays and shows that the file was removed. Nobody can open it after this.',
                trimBody: 'The current version and the files it uses stay. Its history starts again from now.',
                trimConfirm: 'Delete versions',
                freesLabel: 'Frees',
                limitAfterLabel: 'Artifact limit after',
                limitAfterValue: ({ left, limit }) => `${left} left of ${limit}`,
            },
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
            changedReason: 'This passage changed after the comment.',
            openRevision: ({ n }) => `Open version ${n}`,
            reattach: 'Attach to new text',
            reattaching: 'Select the text it belongs to now.',
            attachHere: 'Attach here',
            earlier: ({ n, quote }) => `Earlier on version ${n}: “${quote}”`,
            count: ({ count }) => `${count} ${count === 1 ? 'conversation' : 'conversations'}`,
            countUnavailable: 'Comment count unavailable',
            replyPlaceholder: 'Reply…',
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
            publicationUnknown: 'Check the Doc thread for the suggested edit before trying again.',
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
            outsideSelection: 'Also changes text outside the selection.',
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "en">;
