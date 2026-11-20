

export type FilesPaneTranslations = Readonly<{
    menu: Readonly<{
        openBeside: string;
        openWithBlame: string;
        wrap: string;
        background: string;
        raw: string;
        copyContents: string;
        revealInFiles: string;
        showBlame: string;
        hideBlame: string;
        copyPath: string;
        copyAbsolutePath: string;
        copyHappierLink: string;
        attachToMessage: string;
        saveAsArtifact: string;
        openInDefaultApp: string;
        showInFinder: string;
        showInExplorer: string;
        showInFileManager: string;
        restoreBeforeTurn: (params: Readonly<{ turn: number }>) => string;
        restoreBeforeTurnFallback: string;
        discardAllChanges: string;
        goToDefinition: string;
        showInfo: string;
        restartLanguageServices: string;
        goToTypeDefinition: string;
        goToImplementation: string;
        formatDocument: string;
        formatSelection: string;
        organizeImports: string;
        suggest: string;
        acceptCompletion: string;
        expandSelection: string;
        shrinkSelection: string;
        peekReferences: string;
        signatureHelp: string;
        formatOnSave: string;
        formatOnSaveDescription: string;
        inlayHints: string;
        inlayOff: string;
        inlayParameters: string;
        inlayAll: string;
        semanticHighlighting: string;
        semanticHighlightingDescription: string;
        renameSymbol: string;
        quickFix: string;
    }>;
    changedOnly: string;
    /** The tree's All | Changed view switch (lab FB1) and its accessible name. */
    showAll: string;
    showChanged: string;
    showLabel: string;
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
    managedStoppedTitle: (params: Readonly<{ workspace: string }>) => string;
    managedStoppedReason: string;
    managedStoppedChangesReason: string;
    serverFolderTitle: string;
    serverFolderHelperNote: (params: Readonly<{ workspace: string }>) => string;
    serverFolderSearch: (params: Readonly<{ workspace: string }>) => string;
    serverFolderPreparing: string;
    serverFolderPrepareFailed: (params: Readonly<{ reason: string }>) => string;
    serverFolderUnsupportedTitle: string;
    serverFolderUnsupportedBody: (params: Readonly<{ workspace: string }>) => string;
    managedStartingTitle: (params: Readonly<{ workspace: string }>) => string;
    page: Readonly<{
        view: string;
        preview: string;
        source: string;
        changes: string;
        unsaved: string;
        folders: string;
        discardEdits: string;
        updatedJustNow: string;
        downloadWholeFile: string;
        artifactTitle: string;
        artifactDescription: string;
        artifactTitleLabel: string;
        artifactFolderDescription: string;
        artifactEntrypointLabel: string;
        artifactAudience: string;
        artifactOnlyYou: string;
        artifactSave: string;
        artifactSaved: string;
        artifactOpen: string;
        artifactFailed: string;
        artifactApproval: string;
        updatedByJustNow: (params: Readonly<{ agent: string }>) => string;
        updatedByForJustNow: (params: Readonly<{ agent: string; person: string }>) => string;
        byAgentAge: (params: Readonly<{ agent: string; age: string }>) => string;
        byAgentForAge: (params: Readonly<{ agent: string; person: string; age: string }>) => string;
        deletedBy: (params: Readonly<{ agent: string }>) => string;
        deletedByAt: (params: Readonly<{ agent: string; time: string }>) => string;
        deletedAt: (params: Readonly<{ time: string }>) => string;
        readingFrom: (params: Readonly<{ machine: string; seconds: number }>) => string;
        tooLargeTitle: (params: Readonly<{ size: string }>) => string;
        tooLargeBody: (params: Readonly<{ slice: string }>) => string;
        showFirst: (params: Readonly<{ slice: string }>) => string;
        showLast: (params: Readonly<{ slice: string }>) => string;
        showingFirst: (params: Readonly<{ slice: string; size: string }>) => string;
        showingLast: (params: Readonly<{ slice: string; size: string }>) => string;
        partialFact: (params: Readonly<{ slice: string; size: string }>) => string;
        /** The kind fact for text with no language: why it reads unhighlighted (lab FV2t). */
        plainText: string;
        infoKind: string;
        infoLanguage: string;
        infoLines: string;
        infoSize: string;
        infoEncoding: string;
        infoLineEndings: string;
        encodingBom: string;
        encodingNotUtf8: string;
        eolCrlf: string;
        eolMixed: string;
        /** The Save as Artifact audience: the source's Teams could not be read, so the copy stays private. */
        artifactAudienceUnavailable: string;
        /** Saved, then sharing with the Team failed: the Artifact exists and can be opened. */
        artifactShareFailed: (params: Readonly<{ team: string }>) => string;
        fromMachine: (params: Readonly<{ machine: string }>) => string;
    }>;
    /** P7 language features on the File page: the card, the state note, Problems and References. */
    intelligence: Readonly<{
        cardLabel: string;
        languageServer: string;
        starting: (params: Readonly<{ server: string; machine: string }>) => string;
        loadingProject: (params: Readonly<{ server: string; machine: string }>) => string;
        startingDetail: string;
        serverStopped: (params: Readonly<{ server: string; machine: string }>) => string;
        serverCouldNotStart: (params: Readonly<{ server: string; machine: string }>) => string;
        serverMissing: (params: Readonly<{ server: string; machine: string }>) => string;
        machineOffline: (params: Readonly<{ machine: string }>) => string;
        machineNeedsUpdate: (params: Readonly<{ machine: string }>) => string;
        restart: string;
        copy: string;
        lookingUp: string;
        goToDefinition: string;
        findReferences: string;
        definition: string;
        references: string;
        definedOutside: string;
        namesOnLine: string;
        noReferences: string;
        textMatches: string;
        textMatchesPartial: string;
        noReferencesPartial: string;
        referencesPartial: string;
        problemsTitle: string;
        referencesTitle: string;
        problemsScope: string;
        problemsIdle: string;
        checkProblems: string;
        calls: string;
        incomingCalls: string;
        outgoingCalls: string;
        noCalls: string;
        chooseCallTarget: string;
        checkWholeProject: string;
        openFiles: string;
        wholeProject: string;
        projectProblemsIdle: string;
        projectProblemsUnavailable: string;
        projectNoProblems: string;
        projectProblemsPartial: string;
        workspaceSymbols: string;
        checking: string;
        noProblems: string;
        addedToMessage: string;
        showProblems: string;
        problemsCount: (params: Readonly<{ count: number }>) => string;
        askAgent: (params: Readonly<{ agent: string; count: number }>) => string;
        saveAndAskAgent: (params: Readonly<{ agent: string; count: number }>) => string;
        ask: (params: Readonly<{ count: number }>) => string;
        saveAndAsk: (params: Readonly<{ count: number }>) => string;
        referencesEmpty: string;
        problemsEmpty: string;
        fix: string;
        renameTitle: string;
        fixesTitle: string;
        preparingRename: string;
        lookingForFixes: string;
        saveFirst: string;
        newName: string;
        renameHint: string;
        findingUses: string;
        previewRename: string;
        renameTo: (params: Readonly<{ from: string; to: string }>) => string;
        changesInFiles: (params: Readonly<{ changes: number; files: number }>) => string;
        renameInFiles: (params: Readonly<{ files: number }>) => string;
        renameOnly: string;
        applyDeclined: string;
        undoDeclined: string;
        renameAndUpdateImports: string;
        fileRenamed: (params: Readonly<{ name: string }>) => string;
        applyFix: string;
        runsCommand: string;
        alsoRunsCommand: string;
        renamed: (params: Readonly<{ files: number }>) => string;
        fixApplied: string;
        nothingChanged: string;
        undone: (params: Readonly<{ files: number }>) => string;
        resultChanged: string;
        resultSkipped: string;
        resultFailed: (params: Readonly<{ reason: string }>) => string;
        undoChanged: (params: Readonly<{ files: number }>) => string;
        undoFailed: string;
        readingFile: string;
        changesNotShown: (params: Readonly<{ count: number }>) => string;
        cannotRename: string;
        noFixes: string;
        noInfo: string;
        nothingToChange: string;
        renameUnavailable: string;
        fixesUnavailable: string;
        editLoading: string;
        editFailed: string;
        outcomeUnknown: string;
    }>;
}>;


export const filesPaneTranslationsEnglish = { en: {
        menu: {
            openBeside: "Open beside",
            openWithBlame: "Open with blame",
            wrap: "Wrap lines",
            background: "Background",
            raw: "Source",
            copyContents: "Copy contents",
            revealInFiles: "Reveal in Files",
            showBlame: "Show blame",
            hideBlame: "Hide blame",
            copyPath: "Copy path",
            copyAbsolutePath: "Copy absolute path",
            copyHappierLink: "Copy Happier link",
            attachToMessage: "Attach to message",
            saveAsArtifact: "Save as Artifact…",
            openInDefaultApp: "Open in default app",
            showInFinder: "Show in Finder",
            showInExplorer: "Show in Explorer",
            showInFileManager: "Show in file manager",
            restoreBeforeTurn: ({ turn }) => "Restore this file to before turn" + " " + turn,
            restoreBeforeTurnFallback: 'Restore file',
            discardAllChanges: "Discard all changes in this file",
            goToDefinition: "Go to definition at cursor",
            showInfo: "Info at cursor",
            restartLanguageServices: "Restart language services",
            goToTypeDefinition: "Go to type definition",
            goToImplementation: "Go to implementation",
            formatDocument: "Format document",
            formatSelection: "Format selection",
            organizeImports: "Organize imports",
            suggest: "Suggest",
            acceptCompletion: "Accept suggestion",
            expandSelection: "Expand selection",
            shrinkSelection: "Shrink selection",
            peekReferences: "Peek references",
            signatureHelp: "Parameter help",
            formatOnSave: "Format on save",
            formatOnSaveDescription: "Format the buffer before saving. Off by default.",
            inlayHints: "Inlay hints",
            inlayOff: "Off",
            inlayParameters: "Parameters",
            inlayAll: "All",
            semanticHighlighting: "Semantic highlighting",
            semanticHighlightingDescription: "Layer language-server highlighting over syntax colors.",
            renameSymbol: "Rename symbol",
            quickFix: "Quick fix",
        },
        changedOnly: 'Changed only',
        showAll: 'All',
        showChanged: 'Changed',
        showLabel: 'Show',
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
        workspaceUnavailableReason: 'Happier can’t reach these files from here.',
        managedStoppedTitle: ({ workspace }) => `${workspace} is stopped`,
        managedStoppedReason: 'Start it to see its files.',
        managedStoppedChangesReason: 'Start it to see its changes.',
        serverFolderTitle: 'A folder on a server',
        serverFolderHelperNote: ({ workspace }: { workspace: string }) => `The first time, Happier copies a small helper into ~/.happier on ${workspace}. Nothing runs there while you aren’t using it.`,
        serverFolderSearch: ({ workspace }: { workspace: string }) => `Search folders in ${workspace}`,
        serverFolderPreparing: 'Preparing workspace access',
        serverFolderPrepareFailed: ({ reason }: { reason: string }) => `Failed: ${reason}`,
        serverFolderUnsupportedTitle: 'This server isn’t supported yet',
        serverFolderUnsupportedBody: ({ workspace }: { workspace: string }) => `Happier can only open folders on Linux and macOS servers this way. Set ${workspace} up as a machine instead: Happier then runs there on its own.`,
        managedStartingTitle: ({ workspace }) => `Starting ${workspace}…`,
        page: {
            view: "View",
            preview: "Preview",
            source: "Source",
            changes: "Changes",
            unsaved: "Unsaved",
            folders: "Folders",
            discardEdits: "Discard edits",
            updatedJustNow: "Updated just now",
            downloadWholeFile: "Download the whole file",
            artifactTitle: "Save as Artifact",
            artifactDescription: "An Artifact is a copy you can share. Later changes to the file don’t change it.",
            artifactTitleLabel: "Title",
            artifactFolderDescription: "An Artifact is a copy you can share. It takes the page and every file beside it; later changes to the folder don’t change it.",
            artifactEntrypointLabel: "Page it opens",
            artifactAudience: "Who can see it",
            artifactOnlyYou: "Only you",
            artifactSave: "Save as Artifact",
            artifactSaved: "Saved as Artifact",
            artifactOpen: "Open",
            artifactFailed: "Couldn’t save the Artifact. Try again.",
            artifactApproval: "Waiting for approval",
            updatedByJustNow: ({ agent }) => "Updated by " + agent + " just now",
            updatedByForJustNow: ({ agent, person }) => "Updated by " + agent + " for " + person + " just now",
            byAgentAge: ({ agent, age }) => "by " + agent + " " + age,
            byAgentForAge: ({ agent, person, age }) => "by " + agent + " for " + person + " " + age,
            deletedBy: ({ agent }) => "Deleted by " + agent,
            deletedByAt: ({ agent, time }) => "Deleted by " + agent + " at " + time,
            deletedAt: ({ time }) => "Deleted at " + time,
            readingFrom: ({ machine, seconds }) => "Reading it from " + machine + " · " + seconds + " s",
            tooLargeTitle: ({ size }) => "This file is " + size,
            tooLargeBody: ({ slice }) => "Previews show the first " + slice + ".",
            showFirst: ({ slice }) => "Show first " + slice,
            showLast: ({ slice }) => "Show the last " + slice,
            showingFirst: ({ slice, size }) => "Showing the first " + slice + " of " + size,
            showingLast: ({ slice, size }) => "Showing the last " + slice + " of " + size,
            partialFact: ({ slice, size }) => slice + " of " + size,
            plainText: "Plain text",
            infoKind: "Kind",
            infoLanguage: "Language",
            infoLines: "Lines",
            infoSize: "Size",
            infoEncoding: "Encoding",
            infoLineEndings: "Line endings",
            encodingBom: "UTF-8 with BOM",
            encodingNotUtf8: "Not UTF-8",
            eolCrlf: "Windows (CRLF)",
            eolMixed: "Mixed",
            artifactAudienceUnavailable: "Teams for this file couldn’t be read, so only you will see it.",
            artifactShareFailed: ({ team }) => "Saved for you, but it couldn’t be shared with " + team + ".",
            fromMachine: ({ machine }) => "from " + machine,
        },
        intelligence: {
            cardLabel: "About this name",
            languageServer: "the language server",
            starting: ({ server, machine }) => "Starting " + server + " on " + machine + "…",
            loadingProject: ({ server, machine }) => server + " is loading the project on " + machine + "…",
            startingDetail: "First answers take a few seconds on a large project.",
            serverStopped: ({ server, machine }) => server + " stopped on " + machine + ".",
            serverCouldNotStart: ({ server, machine }) => server + " couldn’t start on " + machine + ".",
            serverMissing: ({ server, machine }) => server + " isn’t installed on " + machine + ".",
            machineOffline: ({ machine }) => "Language features need " + machine + ", which is offline. Reading and reviewing work as usual.",
            machineNeedsUpdate: ({ machine }) => "Language features need a newer Happier on " + machine + ".",
            restart: "Restart",
            copy: "Copy",
            lookingUp: "Looking it up…",
            goToDefinition: "Go to definition",
            findReferences: "Find references",
            definition: "Definition",
            references: "References",
            definedOutside: "Defined outside the workspace",
            namesOnLine: "Names on this line",
            noReferences: "No references found",
            textMatches: "Text matches: no language server answers for this file.",
            textMatchesPartial: "Text matches, first results: no language server answers for this file.",
            noReferencesPartial: "None in the first results. There may be more.",
            referencesPartial: "First results only. There may be more.",
            problemsTitle: "Problems",
            referencesTitle: "References",
            problemsScope: "In files you have open",
            problemsIdle: "Check this file for type errors and other problems.",
            checkProblems: "Check problems",
            calls: "Calls",
            incomingCalls: "Incoming",
            outgoingCalls: "Outgoing",
            noCalls: "No calls found",
            chooseCallTarget: "Choose a function",
            checkWholeProject: "Check the whole project",
            openFiles: "Open files",
            wholeProject: "Whole project",
            projectProblemsIdle: "Check every file in the project, including the ones you don’t have open.",
            projectProblemsUnavailable: "Project checking is unavailable. Check the machine and its language tools, then try again.",
            projectNoProblems: "No problems in the project",
            projectProblemsPartial: "Some project results could not be included.",
            workspaceSymbols: "Symbols",
            checking: "Checking…",
            noProblems: "No problems in files you have open",
            addedToMessage: "Added to your message",
            showProblems: "Show problems",
            problemsCount: ({ count }) => String(count) + " " + (count === 1 ? "problem" : "problems"),
            askAgent: ({ agent, count }) => "Ask " + agent + " to fix " + String(count) + " " + (count === 1 ? "problem" : "problems"),
            saveAndAskAgent: ({ agent, count }) => "Save and ask " + agent + " to fix " + String(count) + " " + (count === 1 ? "problem" : "problems"),
            ask: ({ count }) => "Ask an agent to fix " + String(count) + " " + (count === 1 ? "problem" : "problems"),
            saveAndAsk: ({ count }) => "Save and ask an agent to fix " + String(count) + " " + (count === 1 ? "problem" : "problems"),
            referencesEmpty: "Find references on a name in a file to see where it is used.",
            problemsEmpty: "Open a file to check it for problems.",
            fix: "Fix",
            renameTitle: "Rename",
            fixesTitle: "Quick fixes",
            preparingRename: "Checking this name…",
            lookingForFixes: "Looking for fixes…",
            saveFirst: "Save this file first: renames and fixes work on what is saved.",
            newName: "New name",
            renameHint: "Return shows every change before anything is written.",
            findingUses: "Finding every use…",
            previewRename: "Preview",
            renameTo: ({ from, to }) => from + " → " + to,
            changesInFiles: ({ changes, files }) => String(changes) + " " + (changes === 1 ? "change" : "changes") + " in " + String(files) + " " + (files === 1 ? "file" : "files"),
            renameInFiles: ({ files }) => "Rename in " + String(files) + " " + (files === 1 ? "file" : "files"),
            renameOnly: "Rename only",
            applyDeclined: "The change wasn’t approved. Nothing was written.",
            undoDeclined: "Undo wasn’t approved. The files keep the change.",
            renameAndUpdateImports: "Rename and update imports",
            fileRenamed: ({ name }) => "Renamed to " + name,
            applyFix: "Apply fix",
            runsCommand: "The language server makes this change when it runs. Each file it writes is listed after.",
            alsoRunsCommand: "Then the language server runs a command, which may change more.",
            renamed: ({ files }) => "Renamed in " + String(files) + " " + (files === 1 ? "file" : "files"),
            fixApplied: "Fix applied",
            nothingChanged: "Nothing was changed",
            undone: ({ files }) => "Undone in " + String(files) + " " + (files === 1 ? "file" : "files"),
            resultChanged: "Changed since the preview, left alone",
            resultSkipped: "Skipped",
            resultFailed: ({ reason }) => reason ? "Couldn’t write: " + reason : "Couldn’t write",
            undoChanged: ({ files }) => String(files) + " " + (files === 1 ? "file has" : "files have") + " changed since, left alone",
            undoFailed: "Undo couldn’t finish. Check the files before trying again.",
            readingFile: "Reading…",
            changesNotShown: ({ count }) => String(count) + " " + (count === 1 ? "change" : "changes") + "; the preview can’t be shown",
            cannotRename: "This name can’t be renamed.",
            noFixes: "No fixes here.",
            noInfo: "Nothing to show here.",
            nothingToChange: "Nothing to change.",
            renameUnavailable: "Renaming needs a language server for this file.",
            fixesUnavailable: "Fixes need a language server for this file.",
            editLoading: "The language server is still loading the project. Try again in a moment.",
            editFailed: "Couldn’t get the changes. Try again.",
            outcomeUnknown: "The change may have been written. Check the files before trying again.",
        },
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "en">;
